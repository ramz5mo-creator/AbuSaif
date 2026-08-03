/**
 * parser.js - تحليل الرسائل
 * ================================
 * يحلل رسائل الجروب ويستخرج:
 * 1. الطلبات الأصلية
 * 2. ردود الاستلام (تم، هات، تن، اوك)
 * 3. الكمية (رقم أو إيموجي أو 👍 = 1)
 *
 * القواعد:
 * - يعتمد على رقم الهاتف وليس الاسم
 * - كل عملية لها معرف فريد (UUID) لمنع التكرار
 * - لا تُحتسب العملية إلا مرة واحدة
 * - كلمة الاستلام يجب أن تكون ردًا على رسالة الطلب
 */

const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const logger = require('./logger');
const whatsapp = require('./whatsapp');

// مجموعة المعرفات المعالجة لمنع التكرار
const processedIds = new Set();

// كلمات الاستلام (تُحدّث من Google Sheets)
let acceptWords = [...config.defaultAcceptWords];

/**
 * تحديث كلمات الاستلام
 * @param {string[]} words - قائمة الكلمات الجديدة
 */
function updateAcceptWords(words) {
  if (Array.isArray(words) && words.length > 0) {
    acceptWords = words.map((w) => w.trim().toLowerCase());
    logger.info('تم تحديث كلمات الاستلام', { words: acceptWords });
  }
}

/**
 * الحصول على كلمات الاستلام الحالية
 */
function getAcceptWords() {
  return [...acceptWords];
}

/**
 * تحويل إيموجيات الأرقام إلى أرقام
 * مثل: 2️⃣ → 2, 1️⃣5️⃣ → 15
 */
function emojiToNumber(text) {
  const emojiMap = {
    '0️⃣': '0',
    '1️⃣': '1',
    '2️⃣': '2',
    '3️⃣': '3',
    '4️⃣': '4',
    '5️⃣': '5',
    '6️⃣': '6',
    '7️⃣': '7',
    '8️⃣': '8',
    '9️⃣': '9',
    '🔟': '10',
  };

  let result = text;
  for (const [emoji, num] of Object.entries(emojiMap)) {
    result = result.replaceAll(emoji, num);
  }

  // إزالة كل شيء ما عدا الأرقام
  const numbers = result.replace(/[^\d]/g, '');
  return numbers ? parseInt(numbers, 10) : null;
}

/**
 * استخراج الكمية من النص
 * القواعد:
 * - 👍 = 1
 * - رقم عادي (مثل 15 أو 22) = الرقم نفسه
 * - إيموجيات أرقام (مثل 2️⃣2️⃣) = الرقم المقابل
 * - إذا لم يُحدد رقم مع كلمة الاستلام = 1 (افتراضي)
 */
function extractQuantity(text) {
  if (!text) return 1;

  const cleaned = text.trim();

  // 👍 = 1
  if (cleaned === '👍' || cleaned.includes('👍')) {
    return 1;
  }

  // البحث عن إيموجيات أرقام أولاً
  const emojiNum = emojiToNumber(cleaned);
  if (emojiNum !== null && emojiNum > 0) {
    return emojiNum;
  }

  // البحث عن أرقام عادية في النص
  const numberMatch = cleaned.match(/(\d+)/);
  if (numberMatch) {
    const num = parseInt(numberMatch[1], 10);
    if (num > 0 && num <= 9999) {
      return num;
    }
  }

  // افتراضي: 1
  return 1;
}

/**
 * التحقق مما إذا كان النص يحتوي على كلمة استلام
 */
function isAcceptMessage(text) {
  if (!text) return false;
  const cleaned = text.trim().toLowerCase();

  // التحقق من كلمات الاستلام
  for (const word of acceptWords) {
    if (cleaned === word || cleaned.startsWith(word + ' ') || cleaned.startsWith(word + '\n')) {
      return true;
    }
  }

  // 👍 وحده يعتبر استلام
  if (cleaned === '👍') {
    return true;
  }

  return false;
}

/**
 * استخراج رقم الهاتف من معرف المرسل
 * المعرف يكون بصيغة: 201234567890@s.whatsapp.net
 * أو في الجروب: 201234567890@s.whatsapp.net (participant)
 */
function extractPhone(participant) {
  if (!participant) return null;
  // إزالة @s.whatsapp.net أو @g.us
  return participant.replace(/@.*$/, '');
}

/**
 * معالجة رسالة واحدة
 * @param {object} msg - كائن الرسالة من Baileys
 * @param {object} sock - كائن الاتصال
 * @returns {object|null} - نتيجة المعالجة أو null إذا لم تكن ذات صلة
 */
async function processMessage(msg, sock) {
  const messageId = msg.key.id;

  // منع التكرار
  if (processedIds.has(messageId)) {
    return null;
  }

  // استخراج النص
  const text = whatsapp.extractText(msg);
  if (!text) return null;

  // استخراج معلومات المرسل
  const sender = msg.key.participant || msg.key.remoteJid;
  const phone = extractPhone(sender);

  if (!phone) return null;

  // === التحقق: هل هذه رسالة استلام (رد على طلب)؟ ===
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  const isReply = !!contextInfo?.quotedMessage;

  if (!isReply) {
    // ليست ردًا → قد تكون طلبًا أصليًا (نسجلها كطلب)
    // في الإصدار الأول: نتجاهل الرسائل غير الردود
    // لأن الاستلام يجب أن يكون ردًا على رسالة الطلب
    logger.debug('رسالة غير رد - تم تجاهلها', { phone, text: text.substring(0, 30) });
    return null;
  }

  // === هل النص يحتوي على كلمة استلام؟ ===
  if (!isAcceptMessage(text)) {
    logger.debug('ليست رسالة استلام', { phone, text: text.substring(0, 30) });
    return null;
  }

  // === استخراج معلومات الرسالة المرد عليها (الطلب الأصلي) ===
  const quotedParticipant = contextInfo?.participant;
  const quotedPhone = extractPhone(quotedParticipant);
  const quotedText = contextInfo?.quotedMessage?.conversation ||
    contextInfo?.quotedMessage?.extendedTextMessage?.text ||
    contextInfo?.quotedMessage?.imageMessage?.caption ||
    '';

  // === استخراج الكمية ===
  // الكمية تُستخرج من رسالة الاستلام نفسها
  // مثل: "تم 5" أو "هات 15" أو "تن 2️⃣2️⃣"
  const textAfterWord = text.replace(/^(تم|هات|تن|اوك)\s*/i, '').trim();
  const quantity = extractQuantity(textAfterWord || text);

  // === إنشاء معرف فريد للعملية ===
  const transactionId = uuidv4();

  // تسجيل المعرف لمنع التكرار
  processedIds.add(messageId);

  // تنظيف المعرفات القديمة (الاحتفاظ بآخر 10000)
  if (processedIds.size > 10000) {
    const arr = [...processedIds];
    arr.splice(0, arr.length - 5000);
    processedIds.clear();
    arr.forEach((id) => processedIds.add(id));
  }

  const result = {
    transactionId,
    messageId,
    type: 'accept', // نوع العملية: استلام
    phone, // رقم هاتف المستلم (الذي رد)
    quotedPhone, // رقم هاتف صاحب الطلب الأصلي
    quantity, // الكمية
    text, // نص رسالة الاستلام
    quotedText: quotedText.substring(0, 200), // نص الطلب الأصلي (مختصر)
    timestamp: new Date().toISOString(),
    groupId: msg.key.remoteJid,
  };

  logger.info('🎯 عملية استلام جديدة', {
    transactionId: transactionId.substring(0, 8),
    acceptor: phone,
    orderOwner: quotedPhone,
    quantity,
  });

  return result;
}

module.exports = {
  processMessage,
  updateAcceptWords,
  getAcceptWords,
  extractQuantity,
  emojiToNumber,
  isAcceptMessage,
  extractPhone,
};
