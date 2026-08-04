/**
 * whatsapp.js - الاتصال بواتساب
 * ================================
 * يدير الاتصال بواتساب عبر Baileys،
 * ويقرأ رسائل الجروب المستهدف،
 * ويمرر الرسائل للمعالجة.
 *
 * إصلاحات v3:
 * - حل مشكلة statusCode 440 (conflict) بإضافة تأخير تصاعدي
 * - حل مشكلة فقدان tamCache عند إعادة الاتصال
 * - دعم senderPn/participantPn لأرقام الهاتف الحقيقية
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

// ====================================================
// الكاشات (تبقى في الذاكرة بين إعادات الاتصال)
// ====================================================

// مخزن مؤقت للرسائل (للبحث عن الرسائل المرد عليها)
const messageCache = new Map();

// كاش خاص برسائل "تم" - يحفظ رقم الكابتن مع معرف الرسالة
// { messageId: captainPhone }
// هذا الكاش لا يُمسح عند إعادة الاتصال - يبقى طالما البوت يعمل
const tamCache = new Map();

let sock = null;
let messageHandler = null;
let reconnectAttempts = 0;
let isConnecting = false;
let qrUpdateCallback = null;
let qrClearCallback = null;

/**
 * تعيين معالج الرسائل
 */
function setMessageHandler(handler) {
  messageHandler = handler;
}

/**
 * بدء الاتصال بواتساب مع إدارة ذكية لإعادة الاتصال
 */
async function connect() {
  if (isConnecting) {
    logger.debug('الاتصال جارٍ بالفعل، تجاهل الطلب المكرر');
    return;
  }
  isConnecting = true;

  try {
    const authPath = path.resolve(config.whatsapp.authPath);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    // جلب أحدث إصدار من Baileys
    let version;
    try {
      const result = await fetchLatestBaileysVersion();
      version = result.version;
      logger.debug('إصدار Baileys', { version: version.join('.') });
    } catch {
      version = [2, 3000, 1015901307];
    }

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: require('pino')({ level: 'silent' }),
      // استخدام اسم مختلف لتجنب تعارض الجلسات (conflict 440)
      browser: ['AbuSaif', 'Chrome', '120.0.0'],
      // تعطيل sync الرسائل القديمة لتسريع الاتصال
      syncFullHistory: false,
      // تعطيل retry تلقائي للرسائل لتجنب التكرار
      retryRequestDelayMs: 250,
      getMessage: async (key) => {
        const cached = messageCache.get(key.id);
        return cached?.message || undefined;
      },
    });

    // === أحداث الاتصال ===
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n========================================');
        console.log('  📱 امسح رمز QR بواتساب');
        console.log('========================================');
        qrcode.generate(qr, { small: true });
        console.log('========================================');
        console.log('🌐 أو افتح رابط البوت في المتصفح لمسح QR كصورة');
        console.log('\n');
        // إرسال QR للخادم
        if (qrUpdateCallback) qrUpdateCallback(qr);
      }

      if (connection === 'close') {
        isConnecting = false;
        const err = new Boom(lastDisconnect?.error);
        const statusCode = err?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn('انقطع الاتصال بواتساب', { statusCode, shouldReconnect });

        if (!shouldReconnect) {
          logger.error('تم تسجيل الخروج. يرجى حذف مجلد auth وإعادة المسح.');
          return;
        }

        // ====================================================
        // إدارة ذكية لإعادة الاتصال
        // statusCode 440 = conflict (جلسة مكررة)
        // في هذه الحالة ننتظر أطول قبل إعادة الاتصال
        // ====================================================
        reconnectAttempts++;

        let delay;
        if (statusCode === 440) {
          // conflict: ننتظر 30-60 ثانية
          delay = 30000 + Math.random() * 30000;
          logger.warn(`⚠️ تعارض جلسة (440) - إعادة الاتصال بعد ${Math.round(delay/1000)}ث`);
        } else if (reconnectAttempts <= 3) {
          delay = 5000;
        } else if (reconnectAttempts <= 10) {
          delay = 15000;
        } else {
          delay = 30000;
        }

        logger.info(`🔄 إعادة الاتصال بعد ${Math.round(delay/1000)} ثانية... (محاولة ${reconnectAttempts})`);
        setTimeout(connect, delay);
      }

      if (connection === 'open') {
        reconnectAttempts = 0;
        isConnecting = false;
        logger.info('✅ تم الاتصال بواتساب بنجاح!');
        logger.info(`📦 حجم tamCache: ${tamCache.size} رسالة محفوظة`);
        // مسح QR من الخادم (لم يعد مطلوباً)
        if (qrClearCallback) qrClearCallback();
        listGroups();
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // === استقبال جميع الرسائل ===
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;

        const targetGroup = config.whatsapp.targetGroupId;
        if (targetGroup && msg.key.remoteJid !== targetGroup) continue;
        if (!msg.key.remoteJid?.endsWith('@g.us')) continue;

        // تخزين الرسالة في الكاش (ليس التفاعلات)
        if (msg.key.id && !msg.message.reactionMessage) {
          messageCache.set(msg.key.id, msg);
          if (messageCache.size > 3000) {
            const firstKey = messageCache.keys().next().value;
            messageCache.delete(firstKey);
          }
        }

        // سجل تشخيصي
        logger.info('📨 رسالة واردة', {
          id: msg.key.id?.substring(0, 10),
          participant: msg.key.participant?.substring(0, 20) || 'N/A',
          senderPn: msg.key.senderPn || 'N/A',
          participantPn: msg.key.participantPn || 'N/A',
          isReaction: !!msg.message.reactionMessage,
          pushName: msg.pushName || 'N/A',
          msgType: Object.keys(msg.message)[0],
        });

        if (messageHandler) {
          try {
            await messageHandler(msg, sock);
          } catch (error) {
            logger.error('خطأ في معالجة الرسالة', {
              error: error.message,
              stack: error.stack?.substring(0, 200),
              messageId: msg.key.id,
            });
          }
        }
      }
    });

    return sock;
  } catch (error) {
    isConnecting = false;
    logger.error('خطأ في الاتصال', { error: error.message });
    reconnectAttempts++;
    const delay = Math.min(reconnectAttempts * 10000, 60000);
    setTimeout(connect, delay);
  }
}

/**
 * استخراج النص من الرسالة
 */
function extractText(msg) {
  if (!msg || !msg.message) return null;
  if (msg.message.conversation) return msg.message.conversation;
  if (msg.message.extendedTextMessage?.text) return msg.message.extendedTextMessage.text;
  if (msg.message.imageMessage?.caption) return msg.message.imageMessage.caption;
  if (msg.message.reactionMessage?.text) return msg.message.reactionMessage.text;
  return null;
}

/**
 * استخراج نوع الرسالة
 */
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

/**
 * التحقق مما إذا كانت الرسالة تفاعلاً
 */
function isReaction(msg) {
  return !!msg?.message?.reactionMessage;
}

/**
 * استخراج معرف الرسالة الأصلية التي تفاعل معها
 */
function getReactionTargetId(msg) {
  return msg?.message?.reactionMessage?.key?.id || null;
}

/**
 * استخراج رقم هاتف المرسل
 * Baileys 6.7+ يرسل LID في participant - نستخدم senderPn/participantPn أولاً
 */
function getSenderJid(msg) {
  const key = msg.key || {};

  if (key.senderPn) return key.senderPn;
  if (key.participantPn) return key.participantPn;
  if (key.participant && key.participant.includes('@s.whatsapp.net')) return key.participant;
  if (key.remoteJidAlt && key.remoteJidAlt.includes('@s.whatsapp.net')) return key.remoteJidAlt;

  // آخر محاولة: participant حتى لو LID
  if (key.participant && !key.participant.endsWith('@g.us')) return key.participant;
  if (key.remoteJid && !key.remoteJid.endsWith('@g.us')) return key.remoteJid;

  logger.warn('⚠️ getSenderJid: لم يُعثر على رقم هاتف', {
    remoteJid: key.remoteJid?.substring(0, 30),
    participant: key.participant?.substring(0, 30),
    senderPn: key.senderPn,
    participantPn: key.participantPn,
  });
  return null;
}

/**
 * عرض قائمة الجروبات
 */
async function listGroups() {
  try {
    const groups = await sock.groupFetchAllParticipating();
    const groupList = Object.values(groups);
    logger.info(`═══ الجروبات المتاحة (${groupList.length}) ═══`);
    groupList.forEach((group, i) => {
      logger.info(`  ${i + 1}. ${group.subject} → ${group.id}`);
    });
    logger.info('═══════════════════════════════════════');
    logger.info('انسخ معرف الجروب المطلوب وضعه في TARGET_GROUP_ID');
  } catch (error) {
    logger.warn('لم يتم جلب قائمة الجروبات', { error: error.message });
  }
}

/**
 * الحصول على كائن الاتصال
 */
function getSocket() {
  return sock;
}

/**
 * الحصول على رسالة من الكاش
 */
function getCachedMessage(messageId) {
  return messageCache.get(messageId) || null;
}

/**
 * حفظ رقم الكابتن لرسالة "تم" في كاش خاص
 * هذا الكاش لا يُمسح عند إعادة الاتصال
 */
function setCaptainForMessage(messageId, captainPhone) {
  if (!messageId || !captainPhone) return;
  tamCache.set(messageId, captainPhone);
  if (tamCache.size > 5000) {
    const firstKey = tamCache.keys().next().value;
    tamCache.delete(firstKey);
  }
  logger.debug('💾 tamCache: حفظ كابتن', {
    msgId: messageId.substring(0, 10),
    captain: captainPhone,
    cacheSize: tamCache.size,
  });
}

/**
 * الحصول على رقم الكابتن من كاش رسائل "تم"
 */
function getCaptainByMessageId(messageId) {
  return tamCache.get(messageId) || null;
}

/**
 * الحصول على حجم الكاش (للتشخيص)
 */
function getCacheStats() {
  return {
    messageCache: messageCache.size,
    tamCache: tamCache.size,
  };
}

/**
 * تعيين callback لتحديث QR في الخادم
 */
function onQRUpdate(updateFn, clearFn) {
  qrUpdateCallback = updateFn;
  qrClearCallback = clearFn;
}

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
  getCachedMessage,
  onQRUpdate,
};
