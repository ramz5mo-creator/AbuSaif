/**
 * whatsapp.js - الاتصال بواتساب
 * ================================
 * يدير الاتصال بواتساب عبر Baileys،
 * ويقرأ رسائل الجروب المستهدف،
 * ويمرر الرسائل للمعالجة.
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
    printQRInTerminal: false, // سنطبعه يدوياً بشكل أوضح
    logger: require('pino')({ level: 'silent' }), // إخفاء سجلات Baileys
    browser: ['AbuSaif Bot', 'Chrome', '120.0.0'],
    getMessage: async (key) => {
      // البحث عن الرسالة في المخزن المؤقت
      const cached = messageCache.get(key.id);
      return cached?.message || undefined;
    },
  });

  // لا حاجة لربط مخزن خارجي - نستخدم cache محلي

  // === أحداث الاتصال ===
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    // عرض رمز QR
    if (qr) {
      logger.info('═══════════════════════════════════════');
      logger.info('   امسح رمز QR التالي بواتساب:');
      logger.info('═══════════════════════════════════════');
      qrcode.generate(qr, { small: true });
      logger.info('═══════════════════════════════════════');
    }

    // حالة الاتصال
    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn('انقطع الاتصال بواتساب', {
        statusCode,
        shouldReconnect,
      });

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

  // حفظ بيانات الجلسة
  sock.ev.on('creds.update', saveCreds);

  // === استقبال الرسائل ===
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // نهتم فقط بالرسائل الجديدة (notify)
    if (type !== 'notify') return;

    for (const msg of messages) {
      // تجاهل الرسائل القديمة أو رسائل النظام
      if (!msg.message) continue;
      if (msg.key.fromMe) continue; // تجاهل رسائلنا

      // التحقق من أن الرسالة من الجروب المستهدف
      const targetGroup = config.whatsapp.targetGroupId;
      if (targetGroup && msg.key.remoteJid !== targetGroup) continue;

      // التحقق من أنها رسالة جروب
      if (!msg.key.remoteJid?.endsWith('@g.us')) continue;

      // تمرير الرسالة للمعالج
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

      // سجل تشخيصي
      const sender = msg.key.participant || msg.key.remoteJid;
      const text = extractText(msg);
      const isReply = !!msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

      logger.debug('رسالة جديدة', {
        from: sender,
        group: msg.key.remoteJid,
        text: text?.substring(0, 50),
        isReply,
      });
    }
  });

  return sock;
}

/**
 * استخراج النص من الرسالة
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
    logger.info('انسخ معرف الجروب المطلوب وضعه في TARGET_GROUP_ID');
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

module.exports = {
  connect,
  setMessageHandler,
  getSocket,
  extractText,
};
