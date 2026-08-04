/**
 * whatsapp.js - الاتصال بواتساب
 * ================================
 * يدير الاتصال بواتساب عبر Baileys،
 * ويقرأ رسائل الجروب المستهدف،
 * ويمرر الرسائل للمعالجة.
 *
 * يدعم:
 * - الرسائل النصية العادية
 * - الردود (extendedTextMessage)
 * - التفاعلات (reactions) مثل 👍 / 2️⃣ / 3️⃣
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

// مخزن مؤقت للرسائل (للبحث عن الرسائل المرد عليها)
const messageCache = new Map();

let sock = null;
let messageHandler = null;

/**
 * تعيين معالج الرسائل
 * @param {Function} handler - دالة تُستدعى عند وصول رسالة جديدة
 */
function setMessageHandler(handler) {
  messageHandler = handler;
}

/**
 * بدء الاتصال بواتساب
 */
async function connect() {
  const authPath = path.resolve(config.whatsapp.authPath);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: require('pino')({ level: 'silent' }),
    browser: ['AbuSaif Bot', 'Chrome', '120.0.0'],
    getMessage: async (key) => {
      const cached = messageCache.get(key.id);
      return cached?.message || undefined;
    },
  });

  // === أحداث الاتصال ===
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('═══════════════════════════════════════');
      logger.info('   امسح رمز QR التالي بواتساب:');
      logger.info('═══════════════════════════════════════');
      qrcode.generate(qr, { small: true });
      logger.info('═══════════════════════════════════════');
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn('انقطع الاتصال بواتساب', { statusCode, shouldReconnect });

      if (shouldReconnect) {
        logger.info('إعادة الاتصال خلال ثوانٍ...');
        setTimeout(connect, config.general.reconnectInterval);
      } else {
        logger.error('تم تسجيل الخروج. يرجى حذف مجلد auth وإعادة المسح.');
      }
    }

    if (connection === 'open') {
      logger.info('✅ تم الاتصال بواتساب بنجاح!');
      listGroups();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // === استقبال جميع الرسائل (نصية + تفاعلات) في مستمع واحد فقط ===
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;

      const targetGroup = config.whatsapp.targetGroupId;
      if (targetGroup && msg.key.remoteJid !== targetGroup) continue;
      if (!msg.key.remoteJid?.endsWith('@g.us')) continue;

      // تخزين الرسالة في الكاش (للرسائل النصية فقط، ليس التفاعلات)
      if (msg.key.id && !msg.message.reactionMessage) {
        messageCache.set(msg.key.id, msg);
        // تنظيف الكاش القديم (الاحتفاظ بآخر 2000)
        if (messageCache.size > 2000) {
          const firstKey = messageCache.keys().next().value;
          messageCache.delete(firstKey);
        }
      }

      if (messageHandler) {
        try {
          await messageHandler(msg, sock);
        } catch (error) {
          logger.error('خطأ في معالجة الرسالة', {
            error: error.message,
            messageId: msg.key.id,
            isReaction: !!msg.message.reactionMessage,
          });
        }
      }
    }
  });

  return sock;
}

/**
 * استخراج النص من الرسالة
 * يدعم: نص عادي، رد، صورة، تفاعل (reaction)
 */
function extractText(msg) {
  if (!msg || !msg.message) return null;

  // رسالة نصية عادية
  if (msg.message.conversation) {
    return msg.message.conversation;
  }

  // رسالة نصية ممتدة (رد أو رابط)
  if (msg.message.extendedTextMessage?.text) {
    return msg.message.extendedTextMessage.text;
  }

  // رسالة صورة مع تعليق
  if (msg.message.imageMessage?.caption) {
    return msg.message.imageMessage.caption;
  }

  // تفاعل (reaction) - مثل 👍 أو 2️⃣
  if (msg.message.reactionMessage?.text) {
    return msg.message.reactionMessage.text;
  }

  return null;
}

/**
 * التحقق مما إذا كانت الرسالة تفاعلاً (reaction)
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
 * استخراج رقم هاتف المرسل من الرسالة
 * يحاول participant أولاً، ثم يتحقق من remoteJid
 */
function getSenderJid(msg) {
  // participant موجود في رسائل الجروب ويحتوي على رقم الهاتف
  if (msg.key.participant) return msg.key.participant;

  // في بعض الحالات النادرة participant غائب لكن remoteJid يحتوي على الهاتف
  // (مثلاً في الرسائل الخاصة أو إصدارات معينة من Baileys)
  if (msg.key.remoteJid && !msg.key.remoteJid.endsWith('@g.us')) {
    return msg.key.remoteJid;
  }

  return null;
}

/**
 * عرض قائمة الجروبات المتاحة
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
  } catch (error) {
    logger.warn('لم يتم جلب قائمة الجروبات بعد', { error: error.message });
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

module.exports = {
  connect,
  setMessageHandler,
  getSocket,
  extractText,
  isReaction,
  getReactionTargetId,
  getSenderJid,
  getCachedMessage,
};
