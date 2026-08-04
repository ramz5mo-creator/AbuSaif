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

  // === استقبال الرسائل النصية والردود ===
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;

      const targetGroup = config.whatsapp.targetGroupId;
      if (targetGroup && msg.key.remoteJid !== targetGroup) continue;
      if (!msg.key.remoteJid?.endsWith('@g.us')) continue;

      // تخزين الرسالة في الكاش للردود المستقبلية
      if (msg.key.id) {
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
          });
        }
      }

      const sender = msg.key.participant || msg.key.remoteJid;
      const text = extractText(msg);
      const isReply = !!msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

      logger.debug('رسالة جديدة', {
        from: sender,
        text: text?.substring(0, 50),
        isReply,
      });
    }
  });

  // === استقبال التفاعلات (reactions) ===
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message?.reactionMessage) continue;
      if (msg.key.fromMe) continue;

      const targetGroup = config.whatsapp.targetGroupId;
      if (targetGroup && msg.key.remoteJid !== targetGroup) continue;
      if (!msg.key.remoteJid?.endsWith('@g.us')) continue;

      if (messageHandler) {
        try {
          await messageHandler(msg, sock);
        } catch (error) {
          logger.error('خطأ في معالجة التفاعل', {
            error: error.message,
            messageId: msg.key.id,
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
  if (!msg.message) return null;

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
  return !!msg.message?.reactionMessage;
}

/**
 * استخراج معرف الرسالة الأصلية التي تفاعل معها
 */
function getReactionTargetId(msg) {
  return msg.message?.reactionMessage?.key?.id || null;
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
  getCachedMessage,
};
