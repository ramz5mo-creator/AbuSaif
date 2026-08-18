'use strict';
/**
 * recovery-service.js — نظام Recovery المستقل لكل جروب
 * ======================================================
 * المسؤوليات:
 *  - حفظ آخر رسالة تمت معالجتها لكل جروب بشكل دائم (ملف JSON)
 *  - استرداد الرسائل الفائتة بعد إعادة الاتصال بشكل مستقل لكل جروب
 *  - تمرير الرسائل المسترجعة عبر نفس Pipeline معالجة الرسائل العادية
 *  - منع Duplicate Processing باستخدام Message ID (processedIds Set)
 *  - عدم الاعتماد على عدد ثابت من الرسائل
 *  - تسجيل أخطاء Recovery بشكل مفصّل
 *
 * الاستخدام:
 *   const recovery = require('./recovery-service');
 *   recovery.setMessageHandler(handler);
 *   await recovery.runRecovery(sock);  // يُستدعى بعد CONNECTED/RECONNECTED
 */

const fs   = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const messageLog = require('./message-log');

// ====================================================
// الثوابت
// ====================================================

// مسار ملف حفظ مؤشرات الجروبات (على Railway Volume)
const CURSORS_PATH = path.resolve(
  config.volumePath || '/data',
  'recovery-cursors.json'
);

// الحد الأقصى للرسائل المسترجعة في دفعة واحدة لكل جروب
const MAX_MESSAGES_PER_BATCH = 500;

// مدة الاسترداد الافتراضية عند عدم وجود مؤشر (بالمللي ثانية) — 24 ساعة
const DEFAULT_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

// ====================================================
// الحالة الداخلية
// ====================================================

/** مؤشرات آخر رسالة معالجة لكل جروب { groupId: { messageId, timestamp } } */
let _cursors = {};

/** Set لمنع معالجة نفس الرسالة مرتين { messageId } */
const _processedIds = new Set();

/** معالج الرسائل الخارجي (نفس pipeline الرسائل العادية) */
let _messageHandler = null;

/** هل Recovery جارٍ الآن */
let _isRunning = false;

// ====================================================
// واجهة عامة
// ====================================================

/**
 * تعيين معالج الرسائل (نفس الدالة المستخدمة للرسائل العادية)
 * @param {Function} handler - async (data, sock) => void
 */
function setMessageHandler(handler) {
  _messageHandler = handler;
}

/**
 * تشغيل Recovery بعد إعادة الاتصال
 * يعمل بشكل مستقل لكل جروب من الجروبات الثلاثة
 * @param {object} sock - Socket الحالي
 * @returns {Promise<object>} نتائج Recovery لكل جروب
 */
async function runRecovery(sock) {
  if (_isRunning) {
    logger.warn('[Recovery] Recovery جارٍ بالفعل — تجاهل');
    return {};
  }
  if (!sock) {
    logger.warn('[Recovery] لا يوجد Socket — تخطي Recovery');
    return {};
  }

  _isRunning = true;
  const ts = new Date().toISOString();
  logger.info(`[Recovery] 🔄 RECOVERY_STARTED | ${ts}`);

  // تحميل المؤشرات من القرص
  loadCursors();
  const resetStale = messageLog.resetStaleProcessing();
  const retried = await retryPendingMessages(sock);

  const targetGroups = config.whatsapp.targetGroups || [];
  const results = {};

  // Recovery مستقل لكل جروب
  for (const group of targetGroups) {
    results[group.id] = await _recoverGroup(sock, group);
  }

  // حفظ المؤشرات المحدّثة
  saveCursors();

  const totalRecovered = Object.values(results).reduce((s, r) => s + (r.recovered || 0), 0);
  const totalSkipped   = Object.values(results).reduce((s, r) => s + (r.skipped  || 0), 0);
  const endTs = new Date().toISOString();

  logger.info(`[Recovery] ✅ RECOVERY_COMPLETED | ${endTs} | مسترجع: ${totalRecovered} | مكرر متجاهل: ${totalSkipped} | محاولات معلقة: ${retried.succeeded}/${retried.attempted} | معلقة أعيد ضبطها: ${resetStale}`);

  _isRunning = false;
  return { results, totalRecovered, totalSkipped, retried, resetStale, ts, endTs };
}

/**
 * استعادة تاريخية محكومة لجروب واحد ضمن نافذة زمنية محددة.
 * لا تغيّر مؤشر Recovery الدائم، وتحفظ نسخة سابقة من المؤشرات على الـVolume.
 * تُستخدم فقط لردم فجوة مؤكدة بعد موافقة المشغّل.
 */
async function runHistoricalRecovery(sock, { groupId, fromTimestamp, toTimestamp }) {
  if (_isRunning) throw new Error('Recovery جارٍ بالفعل');
  if (!sock) throw new Error('لا يوجد Socket متصل');
  if (!groupId || !Number.isFinite(fromTimestamp) || !Number.isFinite(toTimestamp) || fromTimestamp >= toTimestamp) {
    throw new Error('نافذة الاستعادة التاريخية غير صالحة');
  }

  const group = (config.whatsapp.targetGroups || []).find(item => item.id === groupId);
  if (!group) throw new Error('الجروب المطلوب غير مسجل');

  _isRunning = true;
  loadCursors();
  const cursorsBefore = JSON.parse(JSON.stringify(_cursors));
  const backupName = `recovery-cursors.before-historical-${Date.now()}.json`;
  const backupPath = path.join(config.volumePath, backupName);

  try {
    fs.writeFileSync(backupPath, JSON.stringify(cursorsBefore, null, 2));
    logger.info(`[Recovery] 🗂️ HISTORICAL_RECOVERY_BACKUP | ${backupName}`);

    const messages = await _fetchMissedMessages(sock, groupId, fromTimestamp);
    const candidates = (messages || [])
      .filter(msg => {
        const timestamp = (msg.messageTimestamp || 0) * 1000;
        return timestamp > fromTimestamp && timestamp <= toTimestamp;
      })
      .sort((a, b) => ((a.messageTimestamp || 0) * 1000) - ((b.messageTimestamp || 0) * 1000));

    let recovered = 0;
    let skipped = 0;
    let errors = 0;
    logger.info(`[Recovery] 🔄 HISTORICAL_RECOVERY_STARTED | ${group.name} | ${new Date(fromTimestamp).toISOString()} → ${new Date(toTimestamp).toISOString()} | رسائل: ${candidates.length}`);

    for (const msg of candidates) {
      const msgId = msg.key?.id;
      if (!msgId || !msg.message) continue;
      if (isProcessed(msgId)) {
        skipped++;
        continue;
      }

      try {
        await _messageHandler({ messages: [msg], type: 'notify' }, sock);
        if (isProcessed(msgId)) recovered++;
        else {
          errors++;
          logger.warn(`[Recovery] ⚠️ HISTORICAL_RECOVERY_PENDING | ${group.name} | ${msgId.substring(0, 8)}`);
        }
      } catch (error) {
        errors++;
        logger.error(`[Recovery] ❌ HISTORICAL_RECOVERY_ERROR | ${group.name} | ${msgId.substring(0, 8)}`, { error: error.message });
      }
    }

    logger.info(`[Recovery] ✅ HISTORICAL_RECOVERY_COMPLETED | ${group.name} | مسترجع: ${recovered} | مكرر: ${skipped} | أخطاء: ${errors}`);
    return { group: group.name, recovered, skipped, errors, candidates: candidates.length, backupName };
  } finally {
    // لا تسمح للاستعادة التاريخية بتقديم/تغيير مؤشر الرسائل الحي.
    _cursors = cursorsBefore;
    saveCursors();
    _isRunning = false;
  }
}

/**
 * تحديث مؤشر آخر رسالة معالجة لجروب معين
 * يُستدعى من pipeline الرسائل العادية بعد كل معالجة ناجحة
 * @param {string} groupId
 * @param {string} messageId
 * @param {number} timestamp - Unix timestamp بالمللي ثانية
 */
function updateCursor(groupId, messageId, timestamp) {
  if (!groupId || !messageId) return;
  const current = _cursors[groupId];
  // تحديث فقط إذا كانت الرسالة أحدث
  if (!current || timestamp > (current.timestamp || 0)) {
    _cursors[groupId] = { messageId, timestamp };
    saveCursorsDebounced();
  }
}

/**
 * تسجيل رسالة كمعالجة (منع التكرار)
 * يُستدعى من pipeline الرسائل العادية
 * @param {string} messageId
 */
function markProcessed(messageId) {
  if (!messageId) return;
  _processedIds.add(messageId);
  // تنظيف دوري لمنع تضخم الذاكرة (الاحتفاظ بآخر 10,000 فقط)
  if (_processedIds.size > 10_000) {
    const toDelete = [..._processedIds].slice(0, 2_000);
    toDelete.forEach(id => _processedIds.delete(id));
  }
}

/**
 * فحص إذا كانت الرسالة قد عولجت من قبل
 * @param {string} messageId
 * @returns {boolean}
 */
function isProcessed(messageId) {
  return _processedIds.has(messageId) || messageLog.isDone(messageId);
}

/**
 * جلب المؤشرات الحالية (للتشخيص)
 */
function getCursors() {
  return { ..._cursors };
}

/**
 * جلب إحصائيات (للتشخيص)
 */
function getStats() {
  return {
    processedIds: _processedIds.size,
    cursors: Object.keys(_cursors).length,
    isRunning: _isRunning,
    messageLog: messageLog.getStats(),
    incompleteReviews: messageLog.getIncompleteReviews({ limit: 100 }),
  };
}

/**
 * يعيد الرسائل التي حفظت دائماً ولكن لم تكتمل، عبر المعالج نفسه فقط.
 * لا ينشئ سجلاً مالياً مباشرة ولا يتجاوز قواعد التصنيف أو منع التكرار.
 */
async function retryPendingMessages(sock, { limit = 100 } = {}) {
  const candidates = messageLog.getRetryCandidates({ limit });
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  if (!_messageHandler || !sock || candidates.length === 0) return { attempted, succeeded, failed };

  for (const record of candidates) {
    if (!record.rawMessage?.message || !record.messageId) continue;
    attempted++;
    try {
      await _messageHandler({ messages: [record.rawMessage], type: 'notify' }, sock);
      if (isProcessed(record.messageId)) succeeded++;
      else failed++;
    } catch (error) {
      failed++;
      logger.error(`[Recovery] ❌ RETRY_FAILED | ${record.messageId.substring(0, 8)}`, { error: error.message });
    }
  }

  if (attempted > 0) logger.info(`[Recovery] 🔁 RETRY_QUEUE | نجح: ${succeeded}/${attempted} | بقي فاشلاً: ${failed}`);
  return { attempted, succeeded, failed };
}

// ====================================================
// Recovery داخلي لكل جروب
// ====================================================

async function _recoverGroup(sock, group) {
  const groupId   = group.id;
  const groupName = group.name || groupId;
  const cursor    = _cursors[groupId];

  // تحديد نقطة البداية
  const sinceTimestamp = cursor?.timestamp
    ? cursor.timestamp
    : Date.now() - DEFAULT_RECOVERY_WINDOW_MS;

  const sinceDate = new Date(sinceTimestamp).toISOString();
  logger.info(`[Recovery] 📥 ${groupName} | منذ: ${sinceDate}`);

  let recovered = 0;
  let skipped   = 0;
  let errors    = 0;
  let lastMsgId = cursor?.messageId || null;
  let lastMsgTs = cursor?.timestamp || 0;

  try {
    // جلب الرسائل الفائتة من Baileys
    // fetchMessagesFromWA يجلب من الخادم مباشرة بدون حد ثابت
    const messages = await _fetchMissedMessages(sock, groupId, sinceTimestamp);

    if (!messages || messages.length === 0) {
      logger.info(`[Recovery] ✅ ${groupName} | لا توجد رسائل فائتة`);
      return { recovered: 0, skipped: 0, errors: 0 };
    }

    logger.info(`[Recovery] 📦 ${groupName} | وجد ${messages.length} رسالة فائتة`);

    // معالجة الرسائل بالترتيب الزمني (الأقدم أولاً)
    const sorted = messages.sort((a, b) => {
      const ta = (a.messageTimestamp || 0) * 1000;
      const tb = (b.messageTimestamp || 0) * 1000;
      return ta - tb;
    });

    for (const msg of sorted) {
      const msgId = msg.key?.id;
      const msgTs = (msg.messageTimestamp || 0) * 1000;

      if (!msgId || !msg.message) continue;

      // تخطي الرسائل القديمة (قبل نقطة المؤشر)
      if (msgTs <= sinceTimestamp && msgId === cursor?.messageId) {
        skipped++;
        continue;
      }

      // منع Duplicate Processing بعد تأكيد الحفظ والمعالجة فقط
      if (isProcessed(msgId)) {
        skipped++;
        logger.debug(`[Recovery] ⏭️ ${groupName} | تكرار: ${msgId.substring(0, 8)}`);
        continue;
      }

      // تمرير الرسالة عبر نفس Pipeline
      try {
        if (_messageHandler) {
          await _messageHandler({ messages: [msg], type: 'notify' }, sock);
          if (isProcessed(msgId)) {
            recovered++;
            // لا يتقدم المؤشر إلا بعد تأكيد اكتمال الرسالة.
            if (msgTs > lastMsgTs) {
              lastMsgId = msgId;
              lastMsgTs = msgTs;
            }
          } else {
            errors++;
            logger.warn(`[Recovery] ⚠️ ${groupName} | بقيت الرسالة في طابور المحاولة: ${msgId.substring(0, 8)}`);
          }
        }
      } catch (err) {
        errors++;
        logger.error(`[Recovery] ❌ ${groupName} | خطأ في معالجة رسالة ${msgId.substring(0, 8)}`, {
          error: err.message,
          stack: err.stack?.split('\n')[0],
        });
        // الاستمرار في معالجة بقية الرسائل رغم الخطأ
      }
    }

    // تحديث المؤشر الدائم
    if (lastMsgId && lastMsgTs > (cursor?.timestamp || 0)) {
      _cursors[groupId] = { messageId: lastMsgId, timestamp: lastMsgTs };
    }

    logger.info(`[Recovery] ✅ ${groupName} | مسترجع: ${recovered} | مكرر: ${skipped} | أخطاء: ${errors}`);
    return { recovered, skipped, errors };

  } catch (err) {
    logger.error(`[Recovery] ❌ فشل Recovery للجروب ${groupName}`, {
      error: err.message,
      stack: err.stack?.split('\n')[0],
    });
    return { recovered, skipped, errors: errors + 1 };
  }
}

// ====================================================
// جلب الرسائل الفائتة من Baileys
// ====================================================

/**
 * جلب الرسائل الفائتة منذ timestamp معين
 * يستخدم fetchMessageHistory من Baileys
 * @param {object} sock
 * @param {string} groupId
 * @param {number} sinceTimestamp - Unix timestamp بالمللي ثانية
 * @returns {Promise<Array>}
 */
async function _fetchMissedMessages(sock, groupId, sinceTimestamp) {
  const messages = [];
  const sinceSeconds = Math.floor(sinceTimestamp / 1000);

  try {
    // الطريقة 1: fetchMessageHistory (Baileys v6+)
    if (typeof sock.fetchMessageHistory === 'function') {
      let cursor = null;
      let hasMore = true;
      let batchCount = 0;

      while (hasMore && messages.length < MAX_MESSAGES_PER_BATCH) {
        batchCount++;
        try {
          const result = await sock.fetchMessageHistory(
            50, // رسائل في كل طلب
            { remoteJid: groupId },
            cursor
          );

          if (!result || !result.messages || result.messages.length === 0) {
            hasMore = false;
            break;
          }

          // فلتر: الرسائل الأحدث من sinceTimestamp فقط
          for (const msg of result.messages) {
            const msgTs = (msg.messageTimestamp || 0);
            if (msgTs > sinceSeconds) {
              messages.push(msg);
            } else {
              // وصلنا لرسائل قديمة — توقف
              hasMore = false;
              break;
            }
          }

          cursor = result.cursor || null;
          if (!cursor) hasMore = false;

          // تأخير بين الطلبات لتجنب الضغط
          if (hasMore) await _sleep(300);

        } catch (batchErr) {
          logger.warn(`[Recovery] تحذير في دفعة ${batchCount} للجروب ${groupId}`, {
            error: batchErr.message,
          });
          hasMore = false;
        }
      }

      return messages;
    }

    // الطريقة 2: loadMessages (Baileys القديم)
    if (typeof sock.loadMessages === 'function') {
      try {
        const msgs = await sock.loadMessages(groupId, MAX_MESSAGES_PER_BATCH, null);
        if (msgs?.messages) {
          for (const msg of msgs.messages) {
            const msgTs = (msg.messageTimestamp || 0);
            if (msgTs > sinceSeconds) {
              messages.push(msg);
            }
          }
        }
      } catch (e) {
        logger.warn(`[Recovery] فشل loadMessages للجروب ${groupId}`, { error: e.message });
      }
      return messages;
    }

    // الطريقة 3: لا يوجد دعم — تسجيل تحذير
    logger.warn(`[Recovery] ⚠️ Baileys لا يدعم جلب التاريخ — Recovery غير متاح لـ ${groupId}`);
    return [];

  } catch (err) {
    logger.error(`[Recovery] خطأ في جلب رسائل ${groupId}`, { error: err.message });
    return messages; // أرجع ما جُمع حتى الآن
  }
}

// ====================================================
// حفظ وتحميل المؤشرات من القرص
// ====================================================

function loadCursors() {
  try {
    if (fs.existsSync(CURSORS_PATH)) {
      const data = JSON.parse(fs.readFileSync(CURSORS_PATH, 'utf8'));
      _cursors = data || {};
      logger.info(`[Recovery] 📂 تم تحميل مؤشرات ${Object.keys(_cursors).length} جروب`);
    } else {
      _cursors = {};
      logger.info('[Recovery] لا يوجد ملف مؤشرات — سيُنشأ عند أول معالجة');
    }
  } catch (err) {
    logger.error('[Recovery] فشل تحميل المؤشرات', { error: err.message });
    _cursors = {};
  }
}

function saveCursors() {
  try {
    const dir = path.dirname(CURSORS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CURSORS_PATH, JSON.stringify(_cursors, null, 2));
    logger.debug(`[Recovery] 💾 تم حفظ مؤشرات ${Object.keys(_cursors).length} جروب`);
  } catch (err) {
    logger.error('[Recovery] فشل حفظ المؤشرات', { error: err.message });
  }
}

// Debounced save لتجنب الكتابة المتكررة
let _saveTimer = null;
function saveCursorsDebounced() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveCursors, 2_000);
}

// ====================================================
// مساعدات
// ====================================================

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ====================================================
// تصدير
// ====================================================

module.exports = {
  setMessageHandler,
  runRecovery,
  runHistoricalRecovery,
  updateCursor,
  markProcessed,
  isProcessed,
  loadCursors,
  saveCursors,
  getCursors,
  getStats,
  retryPendingMessages,
  getIncompleteReviews: messageLog.getIncompleteReviews,
};
