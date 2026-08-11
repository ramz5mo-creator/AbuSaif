'use strict';
/**
 * whatsapp.js - الاتصال بواتساب v5 (Self-Healing + Recovery)
 * ============================================================
 * التغييرات عن v4:
 * - تفويض إدارة الاتصال إلى connection-manager.js (Self-Healing + Exponential Backoff)
 * - تفويض Recovery إلى recovery-service.js (مستقل لكل جروب + منع التكرار)
 * - health-monitor.js يراقب الاتصال بشكل مستقل
 * - tamCache يبقى Cache فقط — المصدر الدائم هو Google Sheets + recovery-cursors.json
 * - منع Duplicate Processing باستخدام Message ID عبر recovery-service
 * - جميع الدوال المُصدَّرة محافظة على توافقها مع server.js
 */

const {
  USyncQuery,
  USyncUser,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

// الوحدات الجديدة
const connectionManager = require('./connection-manager');
const recoveryService   = require('./recovery-service');
const healthMonitor     = require('./health-monitor');

// ====================================================
// الكاشات (تبقى في الذاكرة — Cache فقط وليست مصدر بيانات)
// ====================================================

const messageCache = new Map();
const tamCache     = new Map();
const orderCache   = new Map();
const lidToPhoneMap = new Map();

const LID_MAP_PATH   = path.resolve(config.volumePath, 'lid-map.json');
const TAM_CACHE_PATH = path.resolve(config.volumePath, 'tam-cache.json');

let sheetsModule = null;
function getSheets() {
  if (!sheetsModule) {
    try { sheetsModule = require('./sheets'); } catch (e) { /* تجاهل */ }
  }
  return sheetsModule;
}

const discoveredGroups = new Map();

let membersDbModule = null;
function getMembersDb() {
  if (!membersDbModule) {
    try { membersDbModule = require('./members-db'); } catch (e) { /* تجاهل */ }
  }
  return membersDbModule;
}

let messageHandler = null;

// ====================================================
// واجهة عامة (متوافقة مع server.js الحالي)
// ====================================================

function setMessageHandler(handler) {
  messageHandler = handler;
  // تسجيل معالج الرسائل في ConnectionManager
  connectionManager.setMessageHandler(_handleMessagesUpsert);
  // تسجيل معالج الرسائل في RecoveryService
  recoveryService.setMessageHandler(_handleMessagesUpsert);
}

function onQRUpdate(updateFn, clearFn) {
  connectionManager.onQRUpdate(updateFn, clearFn);
}

function getSocket() {
  return connectionManager.getSocket();
}

/**
 * بدء الاتصال بواتساب (يستخدم ConnectionManager الآن)
 */
async function connect() {
  // تحميل lidMap وtamCache من القرص عند بدء التشغيل
  loadLidMap();
  loadTamCache();
  recoveryService.loadCursors();

  // ربط أحداث ConnectionManager
  _bindConnectionEvents();

  // بدء HealthMonitor
  healthMonitor.start(connectionManager);

  // بدء ConnectionManager
  await connectionManager.start();
}

// ====================================================
// ربط أحداث ConnectionManager
// ====================================================

function _bindConnectionEvents() {
  // CONNECTED: أول اتصال
  connectionManager.on('CONNECTED', async ({ sock, isReconnect }) => {
    logger.info(`[WA] ✅ CONNECTED | ${new Date().toISOString()}`);
    await _onConnected(sock, false);
  });

  // RECONNECTED: بعد انقطاع
  connectionManager.on('RECONNECTED', async ({ sock, attempt }) => {
    logger.info(`[WA] ✅ RECONNECTED | ${new Date().toISOString()} | محاولة ${attempt}`);
    await _onConnected(sock, true);
  });

  // DISCONNECTED
  connectionManager.on('DISCONNECTED', ({ reason, code, ts }) => {
    logger.warn(`[WA] ⚡ DISCONNECTED | ${ts} | ${reason}`);
  });

  // RECONNECTING
  connectionManager.on('RECONNECTING', ({ attempt, delayMs, reason, ts }) => {
    logger.info(`[WA] 🔄 RECONNECTING | ${ts} | محاولة ${attempt} | بعد ${Math.round(delayMs/1000)}ث`);
  });

  // LOGGED_OUT
  connectionManager.on('LOGGED_OUT', ({ ts }) => {
    logger.error(`[WA] ❌ LOGGED_OUT | ${ts} | احذف مجلد auth وأعد المسح`);
  });

  // BAD_SESSION
  connectionManager.on('BAD_SESSION', ({ ts }) => {
    logger.error(`[WA] ❌ BAD_SESSION | ${ts} | احذف مجلد auth وأعد المسح`);
  });

  // getMessage (للرسائل المُعاد إرسالها)
  connectionManager.on('getMessage', (key, resolve) => {
    const cached = messageCache.get(key.id);
    resolve(cached?.message || undefined);
  });

  // messages.delete
  connectionManager.on('messages.delete', _handleMessagesDelete);

  // MESSAGE_HANDLER_ERROR
  connectionManager.on('MESSAGE_HANDLER_ERROR', ({ error }) => {
    logger.error('[WA] خطأ في معالجة رسالة (محمي)', { error });
  });
}

// ====================================================
// عند نجاح الاتصال (أول مرة أو إعادة)
// ====================================================

async function _onConnected(sock, isReconnect) {
  logger.info(`📦 tamCache: ${tamCache.size} | msgCache: ${messageCache.size}`);

  // ربط أحداث الجروبات على Socket الجديد
  sock.ev.on('group-participants.update', _handleGroupParticipantsUpdate);

  if (isReconnect) {
    // Recovery بعد إعادة الاتصال
    setTimeout(async () => {
      try {
        const result = await recoveryService.runRecovery(sock);
        logger.info('[WA] Recovery اكتمل', {
          total: result.totalRecovered,
          skipped: result.totalSkipped,
        });
      } catch (e) {
        logger.error('[WA] فشل Recovery', { error: e.message });
      }
    }, 3000); // انتظر 3 ثوانٍ لاستقرار الاتصال
  }

  // تحميل أسماء المسجلين
  const sheets = getSheets();
  if (sheets && sheets.loadRegisteredUsers) {
    sheets.loadRegisteredUsers().catch(() => {});
  }

  // تهيئة Members DB
  getMembersDb()?.initialize().then(() => {
    return getMembersDb()?.loadFromSheets();
  }).then(({ lidToPhone: sheetsLids } = {}) => {
    if (!sheetsLids) return;
    let merged = 0;
    for (const [lid, phone] of sheetsLids.entries()) {
      if (lid && phone && !lidToPhoneMap.has(lid)) {
        lidToPhoneMap.set(lid, phone);
        merged++;
      }
    }
    logger.info(`🗃️ دمج ${merged} ربط جديد من Members DB`);
    return loadGroupParticipantsAndSync();
  }).catch(e => {
    logger.debug('members-db init error', { error: e.message });
    loadGroupParticipants();
  });

  // تحديث كل 30 دقيقة — مرة واحدة فقط
  if (!_intervalsStarted) {
    _intervalsStarted = true;
    setInterval(() => {
      loadGroupParticipantsAndSync().catch(() => {});
      const s = getSheets();
      if (s && s.loadRegisteredUsers) s.loadRegisteredUsers(true).catch(() => {});
    }, 30 * 60 * 1000);
    logger.info('[WA] ✅ تم تسجيل setInterval للتحديث الدوري (مرة واحدة)');
  }

  // بدء الحل التلقائي للـ LIDs بعد 90 ثانية — مرة واحدة فقط
  if (!_autoResolveStarted) {
    _autoResolveStarted = true;
    setTimeout(() => {
      startAutoResolveLids().catch(e => logger.debug('startAutoResolveLids error', { error: e.message }));
    }, 90 * 1000);
    logger.info('[WA] ✅ تم جدولة startAutoResolveLids (مرة واحدة)');
  }
}

// ====================================================
// معالج الرسائل الرئيسي (يُستدعى من CM وRecovery)
// ====================================================

async function _handleMessagesUpsert({ messages, type }, sock) {
  // الـ reactions في Baileys تصل أحياناً بـ type: 'append' — نسمح بها
  const hasReactions = messages.some(m => m.message?.reactionMessage);
  if (type !== 'notify' && !hasReactions) return;

  for (const msg of messages) {
    if (!msg.message) continue;

    const msgId = msg.key?.id;

    // منع Duplicate Processing
    if (msgId && recoveryService.isProcessed(msgId)) {
      logger.debug(`[WA] ⏭️ تجاهل رسالة مكررة: ${msgId.substring(0, 8)}`);
      continue;
    }

    // تخزين رسائل البوت نفسه (fromMe)
    if (msg.key.fromMe) {
      if (msgId && msg.message && !msg.message.reactionMessage) {
        const remoteJidBot = msg.key.remoteJid || '';
        const targetGroupsBot = config.whatsapp.targetGroups || [];
        const isTargetBot = targetGroupsBot.some(g => g.id === remoteJidBot);
        if (isTargetBot && remoteJidBot.endsWith('@g.us')) {
          messageCache.set(msgId, msg);
          if (messageCache.size > 5000) {
            messageCache.delete(messageCache.keys().next().value);
          }
        }
      }
      continue;
    }

    // تتبع الجروبات المكتشفة
    const remoteJid = msg.key.remoteJid || '';
    if (remoteJid.endsWith('@g.us')) {
      const existing = discoveredGroups.get(remoteJid) || { name: '', messageCount: 0, lastMessage: '' };
      existing.messageCount++;
      existing.lastMessage = new Date().toISOString();
      if (msg.pushName) existing.name = msg.pushName;
      discoveredGroups.set(remoteJid, existing);
    }

    // فلتر الجروب
    const targetGroups = config.whatsapp.targetGroups || [];
    const isTarget = targetGroups.some(g => g.id === remoteJid);
    if (!isTarget) continue;
    if (!remoteJid.endsWith('@g.us')) continue;

    // تخزين في الكاش
    if (msgId && !msg.message.reactionMessage) {
      messageCache.set(msgId, msg);
      if (messageCache.size > 5000) {
        messageCache.delete(messageCache.keys().next().value);
      }
    }

    // تسجيل الرسالة كمعالجة (منع التكرار)
    if (msgId) {
      recoveryService.markProcessed(msgId);
      // تحديث مؤشر Recovery
      const msgTs = (msg.messageTimestamp || 0) * 1000;
      recoveryService.updateCursor(remoteJid, msgId, msgTs);
    }

    // سجل تشخيصي
    const senderJid = getSenderJid(msg);
    logger.info('📨 رسالة', {
      id: msgId?.substring(0, 8),
      from: senderJid?.split('@')[0] || 'N/A',
      type: msg.message.reactionMessage ? 'reaction' : Object.keys(msg.message)[0],
      name: msg.pushName || '',
    });

    // حل LID من pushName
    if (msg.pushName) {
      const currentSock = connectionManager.getSocket();
      const s = getSheets();
      if (senderJid && senderJid.includes('@s.whatsapp.net')) {
        const phoneNum = senderJid.replace('@s.whatsapp.net', '');
        if (s && s.updateWhatsappName) {
          s.updateWhatsappName(phoneNum, msg.pushName).catch(() => {});
        }
      } else if (senderJid && senderJid.includes('@lid')) {
        const resolved = resolvePhoneByPushName(msg.pushName);
        if (resolved) {
          addLidMapping(senderJid, resolved);
          const phoneNum = resolved.replace('@s.whatsapp.net', '');
          if (s && s.updateWhatsappName) {
            s.updateWhatsappName(phoneNum, msg.pushName).catch(() => {});
          }
        } else {
          const rawSenderPn = msg.key?.senderPn || msg.key?.participantPn;
          if (rawSenderPn) {
            const pnJid = rawSenderPn.includes('@') ? rawSenderPn : `${rawSenderPn}@s.whatsapp.net`;
            addLidMapping(senderJid, pnJid);
          } else {
            logger.warn(`⚠️ LID غير محلول: ${msg.pushName}`, { lid: senderJid?.substring(0, 15) });
            queueLidForResolve(senderJid);
            if (currentSock && remoteJid && senderJid && senderJid.includes('@lid')) {
              (async () => {
                try {
                  const meta = await currentSock.groupMetadata(remoteJid);
                  if (meta?.participants) {
                    for (const p of meta.participants) {
                      const pLid = p.lid || '';
                      const pId = p.id || '';
                      const sLid = senderJid.split(':')[0];
                      const pLidBase = pLid.split(':')[0];
                      if (pLid === senderJid || pLidBase === sLid) {
                        if (pId && pId.includes('@s.whatsapp.net')) {
                          addLidMapping(senderJid, pId);
                          if (s && s.updateWhatsappName && msg.pushName) {
                            s.updateWhatsappName(pId.replace('@s.whatsapp.net', ''), msg.pushName).catch(() => {});
                          }
                        }
                        break;
                      }
                    }
                  }
                } catch (e) {
                  logger.debug('فشل جلب groupMetadata لحل LID', { error: e.message });
                }
              })();
            }
          }
        }
      }
    }

    // تمرير الرسالة لمعالج server.js
    if (messageHandler) {
      try {
        await messageHandler(msg, connectionManager.getSocket());
      } catch (error) {
        logger.error('خطأ في المعالجة', { error: error.message, msgId });
      }
    }
  }
}

// ====================================================
// معالج حذف الرسائل
// ====================================================

async function _handleMessagesDelete(item) {
  try {
    const keys = item?.keys || (item?.ids ? item.ids.map(id => ({ id, remoteJid: item.jid })) : []);
    for (const key of keys) {
      const msgId = key?.id || key;
      const remoteJid = key?.remoteJid || item?.jid || '';
      const targetGroups = config.whatsapp.targetGroups || [];
      const isTarget = targetGroups.some(g => g.id === remoteJid);
      if (!isTarget) continue;
      const cachedMsg = messageCache.get(msgId);
      let phone = '', name = '', text = '';
      if (cachedMsg) {
        const senderJid = getSenderJid(cachedMsg);
        phone = senderJid ? senderJid.replace('@s.whatsapp.net', '').replace('@lid', '') : '';
        name = cachedMsg.pushName || '';
        text = extractText(cachedMsg) || '';
        if (!text) {
          const m = cachedMsg.message || {};
          if (m.imageMessage) text = `[صورة] ${m.imageMessage.caption || ''}`;
          else if (m.audioMessage) text = '[رسالة صوتية]';
          else if (m.videoMessage) text = `[فيديو] ${m.videoMessage.caption || ''}`;
          else if (m.stickerMessage) text = '[ستيكر]';
          else if (m.documentMessage) text = `[ملف] ${m.documentMessage.fileName || ''}`;
          else text = '[رسالة غير نصية]';
        }
      } else {
        text = '[لم تُخزّن الرسالة]';
      }
      if (!name && phone) {
        const s = getSheets();
        if (s && s.getRegisteredName) name = s.getRegisteredName(phone) || '';
      }
      logger.info(`🗑️ حذف رسالة`, { phone, name, msgId: msgId?.substring(0, 12), text: text.substring(0, 50) });
      const s = getSheets();
      if (s && s.saveDeletedMessage) {
        s.saveDeletedMessage({ phone, name, text, messageId: msgId }).catch(() => {});
      }
    }
  } catch (err) {
    logger.debug('خطأ في معالجة حذف الرسالة', { error: err.message });
  }
}

// ====================================================
// معالج أحداث الجروب (دخول/خروج/ترقية)
// ====================================================

async function _handleGroupParticipantsUpdate({ id: groupId, participants, action }) {
  const targetGroups = config.whatsapp.targetGroups || [];
  const isTarget = targetGroups.some(g => g.id === groupId);
  if (!isTarget) return;
  logger.info(`👥 حدث جروب: ${action} | عدد: ${participants.length}`);
  const sock = connectionManager.getSocket();
  if (!sock) return;
  if (action === 'add') {
    const groupName = targetGroups.find(g => g.id === groupId)?.name || groupId;
    setTimeout(async () => {
      try {
        const meta = await sock.groupMetadata(groupId);
        if (!meta?.participants) return;
        const sheets = getSheets();
        for (const p of meta.participants) {
          if (!participants.includes(p.id) && !participants.includes(p.lid)) continue;
          const pId = p.id || '';
          const pLid = p.lid || '';
          if (pLid && pId.includes('@s.whatsapp.net')) {
            lidToPhoneMap.set(pLid, pId);
            const base = pLid.split(':')[0];
            if (base !== pLid) lidToPhoneMap.set(base + '@lid', pId);
            if (sheets?.addNewMemberToRegistered) {
              await sheets.addNewMemberToRegistered(pId, p.notify || '', groupName);
              const phone9 = pId.split('@')[0].replace(/\D/g,'').slice(-9);
              if (sheets.updateLidInRegistered) await sheets.updateLidInRegistered(phone9, pLid);
            }
            logger.info(`✅ عضو جديد: ${pId.split('@')[0]} في ${groupName}`);
          } else if (pId.includes('@lid') || pLid.includes('@lid')) {
            const theLid = pLid.includes('@lid') ? pLid : pId;
            queueLidForResolve(theLid);
            resolveLidDirect(theLid).then(async r => {
              if (r) {
                if (sheets?.addNewMemberToRegistered) {
                  await sheets.addNewMemberToRegistered(r, p.notify || '', groupName);
                }
              } else {
                if (sheets?.addNewMemberToRegistered) {
                  await sheets.addNewMemberToRegistered(theLid, p.notify || '', groupName);
                }
              }
            }).catch(() => {});
          }
        }
        saveLidMapDebounced();
      } catch(e) {
        logger.debug('فشل تحديث بيانات العضو الجديد', { error: e.message });
      }
    }, 3000);
  } else if (action === 'promote' || action === 'demote') {
    setTimeout(async () => {
      try {
        const meta = await sock.groupMetadata(groupId);
        if (!meta?.participants) return;
        for (const p of meta.participants) {
          if (!participants.includes(p.id) && !participants.includes(p.lid)) continue;
          const pId = p.id || '';
          const pLid = p.lid || '';
          if (pLid && pId.includes('@s.whatsapp.net')) {
            lidToPhoneMap.set(pLid, pId);
            const base = pLid.split(':')[0];
            if (base !== pLid) lidToPhoneMap.set(base + '@lid', pId);
          }
        }
        saveLidMapDebounced();
      } catch(e) {}
    }, 3000);
  } else if (action === 'remove') {
    logger.info(`🚶 عضو غادر الجروب: ${participants[0]?.substring(0,15)}`);
  }
}

// ====================================================
// دوال LID (محافظة على التوافق مع server.js)
// ====================================================

function resolveLid(lid) {
  if (!lid) return null;
  try {
    const sheets = require('./sheets');
    const fromRegistered = sheets.resolvePhoneFromRegistered(lid);
    if (fromRegistered) {
      const jid = `${fromRegistered}@s.whatsapp.net`;
      addLidMapping(lid, jid);
      return jid;
    }
  } catch(e) {}
  const direct = lidToPhoneMap.get(lid);
  if (direct) return direct;
  const lidPrefix = lid.split(':')[0];
  const baseKey = lidPrefix + '@lid';
  const baseMatch = lidToPhoneMap.get(baseKey);
  if (baseMatch) { addLidMapping(lid, baseMatch); return baseMatch; }
  for (const [k, v] of lidToPhoneMap.entries()) {
    if (k.split(':')[0] === lidPrefix) { addLidMapping(lid, v); return v; }
  }
  return null;
}

let lidMapDirty = false;
let lidMapSaveTimer = null;

function addLidMapping(lid, phone) {
  if (!lid || !phone) return;
  if (lidToPhoneMap.get(lid) === phone) return;
  lidToPhoneMap.set(lid, phone);
  lidMapDirty = true;
  if (!lidMapSaveTimer) {
    lidMapSaveTimer = setTimeout(() => {
      lidMapSaveTimer = null;
      if (lidMapDirty) { saveLidMap(); lidMapDirty = false; }
    }, 5000);
  }
}

async function resolveLidDirect(lid) {
  const sock = connectionManager.getSocket();
  if (!sock || !lid || !lid.includes('@lid')) return null;
  const cached = resolveLid(lid);
  if (cached && cached.includes('@s.whatsapp.net')) return cached;
  try {
    const query = new USyncQuery().withContactProtocol().withLIDProtocol();
    query.withUser(new USyncUser().withLid(lid));
    const results = await sock.executeUSyncQuery(query);
    if (results && results.list && results.list.length > 0) {
      const item = results.list[0];
      if (item.id && item.id.includes('@s.whatsapp.net')) {
        addLidMapping(lid, item.id);
        const phone9 = item.id.split('@')[0].replace(/\D/g,'').slice(-9);
        const db = getMembersDb();
        if (db) db.upsertMember({ lid, phone: phone9 });
        try { const sh = require('./sheets'); sh.updateLidInRegistered(phone9, lid).catch(()=>{}); } catch(e){}
        logger.info(`✅ resolveLidDirect: ${lid.substring(0, 15)} → ${item.id.split('@')[0]}`);
        return item.id;
      }
      if (item.contact && item.contact.id && item.contact.id.includes('@s.whatsapp.net')) {
        addLidMapping(lid, item.contact.id);
        const phone9b = item.contact.id.split('@')[0].replace(/\D/g,'').slice(-9);
        const db2 = getMembersDb();
        if (db2) db2.upsertMember({ lid, phone: phone9b });
        try { const sh = require('./sheets'); sh.updateLidInRegistered(phone9b, lid).catch(()=>{}); } catch(e){}
        logger.info(`✅ resolveLidDirect(contact): ${lid.substring(0, 15)} → ${item.contact.id.split('@')[0]}`);
        return item.contact.id;
      }
    }
  } catch (e) {
    logger.debug(`فشل resolveLidDirect [${lid.substring(0, 20)}]: ${e.message}`);
  }
  return null;
}

function resolveLidByPushName(lid, pushName) {
  if (!lid || !pushName || pushName === 'غير معروف') return null;
  const sheets = getSheets();
  if (!sheets || !sheets.findPhoneByName) return null;
  const phone = sheets.findPhoneByName(pushName);
  if (phone) {
    const jid = `${phone}@s.whatsapp.net`;
    addLidMapping(lid, jid);
    return jid;
  }
  return null;
}

function resolvePhoneByPushName(pushName) {
  if (!pushName || pushName === 'غير معروف') return null;
  const sheets = getSheets();
  if (!sheets || !sheets.findPhoneByName) return null;
  const phone = sheets.findPhoneByName(pushName);
  if (phone) return `${phone}@s.whatsapp.net`;
  return null;
}

// ====================================================
// دوال LID - تحميل/حفظ/مزامنة (محافظة على التوافق)
// ====================================================

function saveLidMap() {
  try {
    const dir = path.dirname(LID_MAP_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(lidToPhoneMap);
    fs.writeFileSync(LID_MAP_PATH, JSON.stringify(obj, null, 2));
    logger.debug(`💾 تم حفظ lidMap (${lidToPhoneMap.size} ربط)`);
  } catch (e) {
    logger.warn('فشل حفظ lidMap', { error: e.message });
  }
}

function loadLidMap() {
  try {
    if (fs.existsSync(LID_MAP_PATH)) {
      const data = JSON.parse(fs.readFileSync(LID_MAP_PATH, 'utf8'));
      let count = 0;
      for (const [lid, phone] of Object.entries(data)) {
        if (lid && phone) { lidToPhoneMap.set(lid, phone); count++; }
      }
      logger.info(`📂 تم تحميل ${count} ربط LID من القرص`);
    }
  } catch (e) {
    logger.warn('فشل تحميل lidMap من القرص', { error: e.message });
  }
}

let _lidSaveTimer = null;
function saveLidMapDebounced() {
  if (_lidSaveTimer) clearTimeout(_lidSaveTimer);
  _lidSaveTimer = setTimeout(saveLidMap, 3000);
}

// ====================================================
// حفظ وتحميل tamCache وorderCache (دائم على Volume)
// ====================================================
const TAM_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 ساعة — بعدها تُحذف المدخلات القديمة

function saveTamCache() {
  try {
    const dir = path.dirname(TAM_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    // تحويل Map إلى Object مع تنظيف القديم
    const tamObj = {};
    for (const [k, v] of tamCache.entries()) {
      const ts = typeof v === 'object' ? (v.ts || now) : now;
      if (now - ts < TAM_CACHE_TTL_MS) {
        tamObj[k] = typeof v === 'string' ? { captain: v, ts } : v;
      }
    }
    const orderObj = {};
    for (const [k, v] of orderCache.entries()) {
      const ts = typeof v === 'object' ? (v.ts || now) : now;
      if (now - ts < TAM_CACHE_TTL_MS) {
        orderObj[k] = typeof v === 'string' ? { producer: v, ts } : v;
      }
    }
    fs.writeFileSync(TAM_CACHE_PATH, JSON.stringify({ tamCache: tamObj, orderCache: orderObj, savedAt: new Date().toISOString() }, null, 2));
    logger.debug(`💾 tamCache محفوظ (${Object.keys(tamObj).length} تم + ${Object.keys(orderObj).length} طلب)`);
  } catch (e) {
    logger.warn('فشل حفظ tamCache', { error: e.message });
  }
}

function loadTamCache() {
  try {
    if (!fs.existsSync(TAM_CACHE_PATH)) {
      logger.info('📂 tamCache: لا يوجد ملف محفوظ — سيُنشأ عند أول "تم"');
      return;
    }
    const raw = JSON.parse(fs.readFileSync(TAM_CACHE_PATH, 'utf8'));
    const now = Date.now();
    let tamCount = 0, orderCount = 0, skipped = 0;
    for (const [k, v] of Object.entries(raw.tamCache || {})) {
      const ts = v.ts || 0;
      if (now - ts < TAM_CACHE_TTL_MS) {
        tamCache.set(k, v);
        tamCount++;
      } else {
        skipped++;
      }
    }
    for (const [k, v] of Object.entries(raw.orderCache || {})) {
      const ts = v.ts || 0;
      if (now - ts < TAM_CACHE_TTL_MS) {
        orderCache.set(k, v);
        orderCount++;
      } else {
        skipped++;
      }
    }
    logger.info(`📂 tamCache محمَّل: ${tamCount} تم + ${orderCount} طلب (تجاهل ${skipped} قديم)`);
  } catch (e) {
    logger.warn('فشل تحميل tamCache من القرص', { error: e.message });
  }
}

let _tamSaveTimer = null;
function saveTamCacheDebounced() {
  if (_tamSaveTimer) clearTimeout(_tamSaveTimer);
  _tamSaveTimer = setTimeout(saveTamCache, 2000);
}

async function loadGroupParticipants() {
async function loadGroupParticipants() {
  const sock = connectionManager.getSocket();
  if (!sock) return;
  if (!connectionManager.isConnected()) return;
  try {
    const targetGroups = config.whatsapp.targetGroups || [];
    for (const group of targetGroups) {
      try {
        const metadata = await sock.groupMetadata(group.id);
        if (metadata && metadata.participants) {
          let linked = 0, unlinked = 0;
          for (const p of metadata.participants) {
            const pId = p.id || '', pLid = p.lid || '';
            if (pLid && pId && pId.includes('@s.whatsapp.net')) {
              lidToPhoneMap.set(pLid, pId);
              const lidBase = pLid.split(':')[0];
              if (lidBase && lidBase !== pLid) lidToPhoneMap.set(lidBase + '@lid', pId);
              linked++;
            } else if (pId && pId.includes('@s.whatsapp.net') && !pLid) {
              unlinked++;
            }
          }
          logger.info(`📋 جروب ${group.name}: ${metadata.participants.length} عضو | مربوط: ${linked} | بدون LID: ${unlinked}`);
        }
      } catch (e) {
        logger.warn(`فشل تحميل مشاركي جروب ${group.name}`, { error: e.message });
      }
    }
    logger.info(`🔗 الإجمالي: ${lidToPhoneMap.size} ربط LID→Phone`);
  } catch (error) {
    logger.warn('فشل تحميل بيانات الجروبات', { error: error.message });
  }
}

async function loadGroupParticipantsAndSync() {
async function loadGroupParticipantsAndSync() {
  const sock = connectionManager.getSocket();
  if (!sock) return;
  if (!connectionManager.isConnected()) return;
  const db = getMembersDb();
  const targetGroups = config.whatsapp.targetGroups || [];
  const newMembers = [];
  for (const group of targetGroups) {
    try {
      const metadata = await sock.groupMetadata(group.id);
      if (!metadata?.participants) continue;
      for (const p of metadata.participants) {
        const pId = p.id || '', pLid = p.lid || '';
        const role = (p.admin === 'admin' || p.admin === 'superadmin') ? 'مشرف' : 'عضو';
        if (pLid && pId.includes('@s.whatsapp.net')) {
          const phone = pId.split('@')[0].replace(/\D/g, '').slice(-9);
          lidToPhoneMap.set(pLid, pId);
          const base = pLid.split(':')[0];
          if (base !== pLid) lidToPhoneMap.set(base + '@lid', pId);
          if (db) db.upsertMember({ lid: pLid, phone, name: '', group: group.name, role });
        } else if (pId.includes('@lid') || (pLid && !pId.includes('@s.whatsapp.net'))) {
          const effectiveLid = pId.includes('@lid') ? pId : pLid;
          const existingPhone = lidToPhoneMap.get(effectiveLid) || (db && db.resolvePhone(effectiveLid));
          if (!existingPhone) {
            newMembers.push({ lid: effectiveLid, group: group.name, role });
            queueLidForResolve(effectiveLid);
          } else {
            lidToPhoneMap.set(effectiveLid, existingPhone);
          }
        } else if (pId.includes('@s.whatsapp.net') && !pLid) {
          const phone = pId.split('@')[0].replace(/\D/g, '').slice(-9);
          if (db) db.upsertMember({ lid: '', phone, name: '', group: group.name, role });
        }
      }
      logger.info(`📊 ${group.name}: ${metadata.participants.length} عضو | جدد غير محلول: ${newMembers.length}`);
    } catch (e) {
      logger.warn(`فشل تحميل ${group.name}`, { error: e.message });
    }
  }
  logger.info(`🔗 الإجمالي: ${lidToPhoneMap.size} ربط | جدد للحل: ${newMembers.length}`);
}

async function syncGroupLids(groupId) {
  const sock = connectionManager.getSocket();
  if (!sock) return { newLinks: 0, total: 0 };
  const targetGroups = config.whatsapp.targetGroups || [];
  const groups = groupId ? targetGroups.filter(g => g.id === groupId) : targetGroups;
  let newLinks = 0, total = 0;
  for (const group of groups) {
    try {
      const metadata = await sock.groupMetadata(group.id);
      if (!metadata?.participants) continue;
      const unresolvedLids = [];
      for (const p of metadata.participants) {
        total++;
        if (p.lid && p.id && p.id.includes('@s.whatsapp.net')) {
          const existed = lidToPhoneMap.has(p.lid);
          lidToPhoneMap.set(p.lid, p.id);
          const lidBase = p.lid.split(':')[0];
          if (lidBase && lidBase !== p.lid) lidToPhoneMap.set(lidBase + '@lid', p.id);
          if (!existed) newLinks++;
        } else if (p.id?.includes('@lid') || (p.lid && !p.id?.includes('@s.whatsapp.net'))) {
          const lidToResolve = p.id?.includes('@lid') ? p.id : p.lid;
          if (lidToResolve) unresolvedLids.push(lidToResolve);
        }
      }
      if (unresolvedLids.length > 0) {
        for (const lid of unresolvedLids) {
          try {
            const resolved = await resolveLidDirect(lid);
            if (resolved && resolved.includes('@s.whatsapp.net')) newLinks++;
          } catch (e) {
            logger.debug(`فشل حل LID ${lid.substring(0,15)}`, { error: e.message });
          }
        }
      }
    } catch (e) {
      logger.warn(`فشل مزامنة جروب ${group.name}`, { error: e.message });
    }
  }
  if (newLinks > 0) saveLidMapDebounced();
  logger.info(`✅ syncGroupLids: ${newLinks} ربط جديد من إجمالي ${total}`);
  return { newLinks, total };
}

async function syncAllLidsFull() {
  const sock = connectionManager.getSocket();
  if (!sock) return { success: false, message: 'واتساب غير متصل', totalMembers: 0, totalLids: 0, resolved: 0, unresolved: 0, newLinks: 0 };
  const targetGroups = config.whatsapp.targetGroups || [];
  let totalMembers = 0, totalLids = 0, newLinks = 0, alreadyKnown = 0;
  const unresolved = new Set();
  for (const group of targetGroups) {
    try {
      const metadata = await sock.groupMetadata(group.id);
      if (!metadata?.participants) continue;
      for (const p of metadata.participants) {
        totalMembers++;
        const pId = p.id || '', pLid = p.lid || '';
        if (pLid.includes('@lid') && pId.includes('@s.whatsapp.net')) {
          totalLids++;
          const old = lidToPhoneMap.get(pLid);
          if (old !== pId) { addLidMapping(pLid, pId); newLinks++; } else { alreadyKnown++; }
          const base = pLid.split(':')[0];
          if (base && base !== pLid.split('@')[0]) addLidMapping(`${base}@lid`, pId);
          continue;
        }
        const lidOnly = pId.includes('@lid') ? pId : (pLid.includes('@lid') ? pLid : '');
        if (lidOnly) {
          totalLids++;
          if (!lidToPhoneMap.has(lidOnly)) { unresolved.add(lidOnly); queueLidForResolve(lidOnly); }
        }
      }
    } catch (e) {
      logger.warn(`⚠️ فشل قراءة الجروب ${group.name || group.id}`, { error: e.message });
    }
  }
  saveLidMap();
  let resolvedNow = 0;
  const LID_BATCH_SIZE = 20;
  const unresolvedArr = Array.from(unresolved);
  const totalUnresolved = unresolvedArr.length;

  for (let i = 0; i < unresolvedArr.length; i += LID_BATCH_SIZE) {
    const batch = unresolvedArr.slice(i, i + LID_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(lid => resolveLidDirect(lid))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value && r.value.includes('@s.whatsapp.net')) {
        resolvedNow++;
      }
    }
    const done = Math.min(i + LID_BATCH_SIZE, totalUnresolved);
    logger.info(`[LID Sync] ${done}/${totalUnresolved} | حُلّ: ${resolvedNow}`);
    if (i + LID_BATCH_SIZE < unresolvedArr.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  saveLidMap();
  return { success: true, totalMembers, totalLids, newLinks, alreadyKnown, attemptedResolve: unresolved.size, resolvedNow, resolved: totalLids - unresolved.size + resolvedNow, unresolved: Math.max(0, unresolved.size - resolvedNow) };
}

// ====================================================
// دوال tamCache وorderCache (محافظة على التوافق)
// ====================================================

function setCaptainForMessage(messageId, captainPhone) {
  if (!messageId || !captainPhone) return;
  tamCache.set(messageId, { captain: captainPhone, ts: Date.now() });
  saveTamCacheDebounced();
  logger.debug('💾 tamCache', { msgId: messageId.substring(0, 8), captain: captainPhone, size: tamCache.size });
}

function getCaptainByMessageId(messageId) {
  const entry = tamCache.get(messageId);
  if (!entry) return null;
  // دعم البنية القديمة (string) والجديدة ({captain, ts})
  return typeof entry === 'string' ? entry : (entry.captain || null);
}

function setOrderForReply(replyMsgId, producerPhone) {
  if (!replyMsgId || !producerPhone) return;
  orderCache.set(replyMsgId, { producer: producerPhone, ts: Date.now() });
  saveTamCacheDebounced();
}

function getOrderByReplyId(replyMsgId) {
  const entry = orderCache.get(replyMsgId);
  if (!entry) return null;
  // دعم البنية القديمة (string) والجديدة ({producer, ts})
  return typeof entry === 'string' ? entry : (entry.producer || null);
}

function getCachedMessage(messageId) {
  return messageCache.get(messageId) || null;
}

function getPushNameFromCachedMessage(messageId) {
  const msg = messageCache.get(messageId);
  return msg?.pushName || null;
}

function getCacheStats() {
  return {
    messageCache: messageCache.size,
    tamCache: tamCache.size,
    lidMap: lidToPhoneMap.size,
    processedIds: recoveryService.getStats().processedIds,
    isConnected: connectionManager.isConnected(),
  };
}

// ====================================================
// دوال مساعدة (محافظة على التوافق)
// ====================================================

function extractText(msg) {
  if (!msg || !msg.message) return null;
  if (msg.message.conversation) return msg.message.conversation;
  if (msg.message.extendedTextMessage?.text) return msg.message.extendedTextMessage.text;
  if (msg.message.imageMessage?.caption) return msg.message.imageMessage.caption;
  if (msg.message.reactionMessage?.text) return msg.message.reactionMessage.text;
  return null;
}

function getMessageType(msg) {
  if (!msg?.message) return 'other';
  const m = msg.message;
  if (m.conversation || m.extendedTextMessage) return 'text';
  if (m.audioMessage) return 'audio';
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.stickerMessage) return 'sticker';
  if (m.documentMessage) return 'document';
  return 'other';
}

function isReaction(msg) {
  return !!msg?.message?.reactionMessage;
}

function getReactionTargetId(msg) {
  return msg?.message?.reactionMessage?.key?.id || null;
}

function getSenderJid(msg) {
  const key = msg.key || {};
  if (key.senderPn) {
    if (key.participant && key.participant.includes('@lid')) addLidMapping(key.participant, key.senderPn);
    return key.senderPn;
  }
  if (key.participantPn) {
    if (key.participant && key.participant.includes('@lid')) addLidMapping(key.participant, key.participantPn);
    return key.participantPn;
  }
  if (key.participant && key.participant.includes('@s.whatsapp.net')) return key.participant;
  if (msg.participant && msg.participant.includes('@s.whatsapp.net')) return msg.participant;
  if (key.participant && key.participant.includes('@lid')) {
    const resolved = lidToPhoneMap.get(key.participant);
    if (resolved) return resolved;
    const lidPrefix = key.participant.split(':')[0];
    const baseKey = lidPrefix + '@lid';
    const resolvedBase = lidToPhoneMap.get(baseKey);
    if (resolvedBase) { addLidMapping(key.participant, resolvedBase); return resolvedBase; }
    for (const [lid, phone] of lidToPhoneMap.entries()) {
      if (lid.split(':')[0] === lidPrefix) { addLidMapping(key.participant, phone); return phone; }
    }
    if (msg.pushName) {
      const resolvedByName = resolveLidByPushName(key.participant, msg.pushName);
      if (resolvedByName) return resolvedByName;
    }
  }
  if (key.participant && !key.participant.endsWith('@g.us')) {
    if (key.participant.includes('@lid')) logger.warn('⚠️ LID غير محلول', { lid: key.participant, pushName: msg.pushName || '' });
    return key.participant;
  }
  if (key.remoteJid && !key.remoteJid.endsWith('@g.us')) return key.remoteJid;
  return null;
}

function getPushName(msg) {
  return msg?.pushName || 'غير معروف';
}

async function listGroups() {
  const sock = connectionManager.getSocket();
  if (!sock) return;
  try {
    const groups = await sock.groupFetchAllParticipating();
    const groupList = Object.values(groups);
    logger.info(`═══ الجروبات (${groupList.length}) ═══`);
    groupList.slice(0, 10).forEach((group, i) => {
      logger.info(`  ${i + 1}. ${group.subject} → ${group.id}`);
    });
  } catch (error) {
    logger.warn('لم يتم جلب الجروبات', { error: error.message });
  }
}

function getDiscoveredGroups() { return discoveredGroups; }
function getLidToPhoneMap() { return lidToPhoneMap; }
function getMessageCache() { return messageCache; }

function lookupPhone(phone) {
  const results = [];
  for (const [lid, jid] of lidToPhoneMap.entries()) {
    const num = jid.replace('@s.whatsapp.net', '');
    if (num.includes(phone) || phone.includes(num)) results.push({ lid, jid: num });
  }
  const tamEntries = [];
  for (const [msgId, captainPhone] of tamCache.entries()) {
    if (captainPhone.includes(phone) || phone.includes(captainPhone)) {
      tamEntries.push({ msgId: msgId.substring(0, 12), captainPhone });
    }
  }
  return { inLidMap: results.length > 0, lidEntries: results, tamEntries: tamEntries.slice(0, 10) };
}

function getRegisteredLidStatus() {
  const sheets = getSheets();
  if (!sheets || !sheets.getAllRegistered) return [];
  const all = sheets.getAllRegistered();
  const result = [];
  for (const { phone, name } of all) {
    let lid = null;
    for (const [l, p] of lidToPhoneMap.entries()) {
      const pNum = p.replace('@s.whatsapp.net', '');
      if (pNum === phone || pNum.slice(-9) === phone.slice(-9)) { lid = l; break; }
    }
    result.push({ phone, name, lid, resolved: !!lid });
  }
  return result;
}

async function getGroupMembersWithLidStatus(groupId) {
  const sock = connectionManager.getSocket();
  if (!sock) return [];
  try {
    const metadata = await sock.groupMetadata(groupId);
    const participants = metadata?.participants || [];
    const sheetsModule = getSheets();
    const result = [];
    for (const p of participants) {
      const jid = p.id || '', lid = p.lid || '';
      const isLid = jid.includes('@lid') || lid.includes('@lid');
      const effectiveLid = lid.includes('@lid') ? lid : (jid.includes('@lid') ? jid : null);
      let pushName = p.notify || '';
      if (!pushName) {
        for (const [, msg] of messageCache.entries()) {
          const k = msg.key || {};
          const sender = k.participant || k.remoteJid || '';
          if ((sender === jid || sender === lid || sender === effectiveLid) && msg.pushName) {
            pushName = msg.pushName; break;
          }
        }
      }
      if (isLid && effectiveLid) {
        const resolvedJid = lidToPhoneMap.get(effectiveLid);
        const resolvedPhone = resolvedJid ? resolvedJid.replace('@s.whatsapp.net', '') : null;
        const name = resolvedPhone && sheetsModule ? (sheetsModule.getRegisteredName(resolvedPhone) || '') : '';
        result.push({ lid: effectiveLid, phone: resolvedPhone || null, name: name || pushName, pushName, resolved: !!resolvedPhone, status: resolvedPhone ? 'resolved' : 'unresolved' });
      } else if (jid.includes('@s.whatsapp.net')) {
        const phone = jid.replace('@s.whatsapp.net', '');
        const name = sheetsModule ? (sheetsModule.getRegisteredName(phone) || '') : '';
        result.push({ lid: null, phone, name: name || pushName, pushName, resolved: true, status: 'real' });
      }
    }
    return result;
  } catch(e) {
    logger.warn('فشل جلب أعضاء الجروب', { error: e.message });
    return [];
  }
}

// ====================================================
// نظام LID التلقائي (5 طبقات)
// ====================================================

const _lidResolveQueue = new Set();
let _autoResolveRunning = false;
let _intervalsStarted = false;   // منع تكرار setInterval عند إعادة الاتصال
let _autoResolveStarted = false; // منع تكرار startAutoResolveLids
const _newlyResolvedLids = new Map();
// عداد فشل لكل LID — بعد MAX_LID_FAILURES فشل متتالي يُنقل لقائمة "مستحيل الحل"
const _lidFailCount = new Map();
const _permanentlyFailedLids = new Set();
const MAX_LID_FAILURES = 10;

function queueLidForResolve(lid) {
  if (!lid || !lid.includes('@lid')) return;
  if (lidToPhoneMap.has(lid)) return;
  _lidResolveQueue.add(lid);
}

async function autoResolveLidsBatch() {
  if (_autoResolveRunning) return;
  const sock = connectionManager.getSocket();
  if (!sock) return;
  if (_lidResolveQueue.size === 0) return;
  _autoResolveRunning = true;
  const BATCH_SIZE = 10;
  const batch = [];
  for (const lid of _lidResolveQueue) {
    if (batch.length >= BATCH_SIZE) break;
    if (!lidToPhoneMap.has(lid)) batch.push(lid);
    else _lidResolveQueue.delete(lid);
  }
  if (batch.length === 0) { _autoResolveRunning = false; return; }
  logger.info(`🤖 autoResolve: محاولة حل ${batch.length} LID من ${_lidResolveQueue.size} في الانتظار`);
  let resolved = 0;
  for (const lid of batch) {
    // تخطي الـ LIDs المستحيلة
    if (_permanentlyFailedLids.has(lid)) {
      _lidResolveQueue.delete(lid);
      continue;
    }
    try {
      const result = await resolveLidDirect(lid);
      if (result) {
        resolved++;
        _lidResolveQueue.delete(lid);
        _lidFailCount.delete(lid);
        const phone = result.split('@')[0].replace(/\D/g, '');
        if (phone.length >= 9) {
          _newlyResolvedLids.set(lid, phone);
          const db = getMembersDb();
          if (db) db.upsertMember({ lid, phone: phone.slice(-9) });
        }
        logger.info(`✅ autoResolve: ${lid.substring(0,15)} → ${phone}`);
      } else {
        // فشل بدون exception — زيادة عداد الفشل
        const fails = (_lidFailCount.get(lid) || 0) + 1;
        _lidFailCount.set(lid, fails);
        if (fails >= MAX_LID_FAILURES) {
          _permanentlyFailedLids.add(lid);
          _lidResolveQueue.delete(lid);
          logger.warn(`🚫 LID مستحيل الحل بعد ${fails} محاولة — تم إيقاف المحاولة: ${lid.substring(0,20)}`);
        }
      }
    } catch(e) {
      const fails = (_lidFailCount.get(lid) || 0) + 1;
      _lidFailCount.set(lid, fails);
      if (fails >= MAX_LID_FAILURES) {
        _permanentlyFailedLids.add(lid);
        _lidResolveQueue.delete(lid);
        logger.warn(`🚫 LID مستحيل الحل بعد ${fails} محاولة — تم إيقاف المحاولة: ${lid.substring(0,20)}`);
      } else {
        logger.debug(`autoResolve فشل (${fails}/${MAX_LID_FAILURES}): ${lid.substring(0,15)}`, { error: e.message });
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (resolved > 0) {
    saveLidMapDebounced();
    if (_newlyResolvedLids.size > 0) {
      const sheets = getSheets();
      if (sheets && sheets.backfillLidRecords) {
        const toUpdate = new Map(_newlyResolvedLids);
        _newlyResolvedLids.clear();
        sheets.backfillLidRecords(toUpdate).catch(e => logger.debug('فشل backfill سجلات LID', { error: e.message }));
      }
    }
  }
  logger.info(`🤖 autoResolve: ${resolved}/${batch.length} تم حلها | متبقي: ${_lidResolveQueue.size}`);
  _autoResolveRunning = false;
}

async function collectAllUnresolvedLids() {
  const sock = connectionManager.getSocket();
  if (!sock || !connectionManager.isConnected()) return 0;
  const targetGroups = config.whatsapp.targetGroups || [];
  let queued = 0;
  for (const group of targetGroups) {
    try {
      const metadata = await sock.groupMetadata(group.id);
      if (!metadata?.participants) continue;
      for (const p of metadata.participants) {
        const pId = p.id || '', pLid = p.lid || '';
        if (pLid && pId.includes('@s.whatsapp.net')) {
          if (!lidToPhoneMap.has(pLid)) {
            lidToPhoneMap.set(pLid, pId);
            const base = pLid.split(':')[0];
            if (base !== pLid) lidToPhoneMap.set(base + '@lid', pId);
          }
        }
        if (pId.includes('@lid') && !lidToPhoneMap.has(pId)) { _lidResolveQueue.add(pId); queued++; }
        if (pLid && !pId.includes('@s.whatsapp.net') && !lidToPhoneMap.has(pLid)) { _lidResolveQueue.add(pLid); queued++; }
      }
    } catch(e) {
      logger.debug(`collectAllUnresolvedLids: فشل ${group.name}`, { error: e.message });
    }
  }
  if (queued > 0) logger.info(`📝 جمع LIDs: ${queued} جديد في القائمة | إجمالي: ${_lidResolveQueue.size}`);
  return queued;
}

async function startAutoResolveLids() {
  logger.info('🚀 بدء نظام LID الشامل (5 طبقات)');
  await collectAllUnresolvedLids();
  setTimeout(autoResolveLidsBatch, 5 * 1000);
  setInterval(async () => {
    if (!connectionManager.isConnected()) return;
    await collectAllUnresolvedLids();
    await autoResolveLidsBatch();
  }, 5 * 60 * 1000);
  setInterval(async () => {
    if (!connectionManager.isConnected()) return;
    await autoResolveLidsBatch();
  }, 30 * 1000);
  setInterval(async () => {
    if (!connectionManager.isConnected()) return;
    logger.info('🔄 تحديث دوري لقائمة الأعضاء (كل ساعة)');
    await loadGroupParticipants();
    await collectAllUnresolvedLids();
  }, 60 * 60 * 1000);
  logger.info(`✅ نظام LID نشط: ${_lidResolveQueue.size} في القائمة`);
}

function getUnresolvedLids() {
  const result = [], seen = new Set();
  for (const [msgId, msg] of messageCache.entries()) {
    const key = msg.key || {};
    const participant = key.participant || '';
    if (!participant.includes('@lid')) continue;
    if (lidToPhoneMap.has(participant)) continue;
    if (seen.has(participant)) continue;
    seen.add(participant);
    result.push({ lid: participant, pushName: msg.pushName || '', msgId: msgId.substring(0, 12) });
  }
  return result;
}

// ====================================================
// تصدير (متوافق 100% مع server.js الحالي)
// ====================================================

module.exports = {
  connect,
  setMessageHandler,
  setCaptainForMessage,
  getCaptainByMessageId,
  getCacheStats,
  getSocket,
  extractText,
  getMessageType,
  isReaction,
  getReactionTargetId,
  getSenderJid,
  getPushName,
  getCachedMessage,
  onQRUpdate,
  getDiscoveredGroups,
  lookupPhone,
  resolveLidByPushName,
  resolveLid,
  resolveLidDirect,
  addLidMapping,
  setOrderForReply,
  getOrderByReplyId,
  getPushNameFromCachedMessage,
  resolvePhoneByPushName,
  syncGroupLids,
  syncAllLidsFull,
  getUnresolvedLids,
  getRegisteredLidStatus,
  getGroupMembersWithLidStatus,
  getLidToPhoneMap,
  getMessageCache,
  queueLidForResolve,
  startAutoResolveLids,
  // جديد: للوصول لحالة الاتصال والـ Recovery
  connectionManager,
  recoveryService,
  healthMonitor,
};

// دوال مساعدة للوصول من server.js
module.exports.getConnectionManager = () => connectionManager;
module.exports.getRecoveryStats     = () => recoveryService.getStats();
module.exports.isConnected          = () => connectionManager.isConnected();
module.exports.isSupervisorCommand  = (msg) => {
  // تحقق من أوامر المشرف — انسخ المنطق الحالي من v4 هنا
  // مثال: msg.message?.conversation?.startsWith('كشف') || ...
  const text = module.exports.extractText(msg) || '';
  return text.startsWith('كشف') || text.startsWith('.');
};
