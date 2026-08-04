/**
 * parser.js - تحليل الرسائل
 * ================================
 * يحلل رسائل الجروب ويستخرج:
 * 1. الطلبات الأصلية (type: 'order')
 * 2. ردود الاستلام نصية (type: 'accept')
 * 3. تفاعلات الاستلام 👍/2️⃣/3️⃣ (type: 'accept')
 *
 * القواعد:
 * - يعتمد على رقم الهاتف وليس الاسم
 * - كل عملية لها معرف فريد (UUID) لمنع التكرار
 * - لا تُحتسب العملية إلا مرة واحدة
 * - كلمة الاستلام يجب أن تكون ردًا على رسالة الطلب
 *   أو تفاعلاً (reaction) على رسالة الطلب
 *
 * منطق الرصيد:
 * - صاحب الطلب (quotedPhone) → +quantity (سلّم طلبات)
 * - المستلم (phone) → -quantity (استلم طلبات)
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
 * تنظيف رقم الهاتف
 * يزيل @s.whatsapp.net أو @g.us
 * ويزيل الصفر الزائد في البداية إن وجد
 * مثال: 10934600585724 → 934600585724
 *        962791234567  → 962791234567 (يبقى كما هو)
 */
function cleanPhone(participant) {
  if (!participant) return null;
  let phone = participant.replace(/@.*$/, '').trim();

  // إزالة أي حروف غير رقمية
  phone = phone.replace(/\D/g, '');

  // بعض أرقام واتساب تبدأ بـ 1 زائد (مشكلة encoding)
  // مثل: 10934600585724 → يجب أن يكون 934600585724
  // نتحقق: إذا كان الرقم يبدأ بـ 1 وطوله 14 رقم → احذف الـ 1
  // (أرقام الهاتف العادية 12-13 رقم مع رمز الدولة)
  if (phone.length === 14 && phone.startsWith('1')) {
    const withoutLeadingOne = phone.substring(1);
    // تحقق أن الرقم الناتج منطقي (يبدأ برمز دولة معروف)
    if (/^(9[0-9]{2}|2[0-9]{2}|3[0-9]{2}|4[0-9]{2}|5[0-9]{2}|6[0-9]{2}|7[0-9]{2}|8[0-9]{2})/.test(withoutLeadingOne)) {
      phone = withoutLeadingOne;
    }
  }

  return phone || null;
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

  const numbers = result.replace(/[^\d]/g, '');
  return numbers ? parseInt(numbers, 10) : null;
}

/**
 * استخراج الكمية من النص
 * - 👍 = 1
 * - إيموجي رقم (2️⃣) = الرقم نفسه
 * - رقم عادي = الرقم نفسه
 * - لا شيء = 1
 */
function extractQuantity(text) {
  if (!text) return 1;

  const cleaned = text.trim();

  // 👍 = 1
  if (cleaned === '👍' || cleaned.includes('👍')) {
    return 1;
  }

  // البحث عن إيموجيات أرقام أولاً (مثل 2️⃣ أو 3️⃣)
  const emojiNum = emojiToNumber(cleaned);
  if (emojiNum !== null && emojiNum > 0) {
    return emojiNum;
  }

  // البحث عن أرقام عادية
  const numberMatch = cleaned.match(/(\d+)/);
  if (numberMatch) {
    const num = parseInt(numberMatch[1], 10);
    if (num > 0 && num <= 9999) {
      return num;
    }
  }

  return 1;
}

/**
 * التحقق مما إذا كان النص يحتوي على كلمة استلام
 */
function isAcceptMessage(text) {
  if (!text) return false;
  const cleaned = text.trim().toLowerCase();

  for (const word of acceptWords) {
    if (
      cleaned === word ||
      cleaned.startsWith(word + ' ') ||
      cleaned.startsWith(word + '\n')
    ) {
      return true;
    }
  }

  // 👍 وحده = استلام
  if (cleaned === '👍') {
    return true;
  }

  // إيموجيات الأرقام وحدها = استلام (2️⃣ أو 3️⃣ ...)
  const emojiOnlyPattern = /^[\s0️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣9️⃣🔟]+$/u;
  if (emojiOnlyPattern.test(cleaned)) {
    return true;
  }

  return false;
}

/**
 * منع التكرار - تنظيف المعرفات القديمة
 */
function addProcessedId(id) {
  processedIds.add(id);
  if (processedIds.size > 10000) {
    const arr = [...processedIds];
    arr.splice(0, arr.length - 5000);
    processedIds.clear();
    arr.forEach((i) => processedIds.add(i));
  }
}

/**
 * معالجة رسالة واحدة
 * @param {object} msg - كائن الرسالة من Baileys
 * @param {object} sock - كائن الاتصال
 * @returns {object|null}
 */
async function processMessage(msg, sock) {
  const messageId = msg.key.id;

  if (processedIds.has(messageId)) {
    return null;
  }

  // ====================================================
  // حالة 1: تفاعل (reaction) مثل 👍 أو 2️⃣ أو 3️⃣
  // ====================================================
  if (whatsapp.isReaction(msg)) {
    const reactionText = msg.message.reactionMessage.text;
    const targetMessageId = whatsapp.getReactionTargetId(msg);

    // التحقق من أن التفاعل هو كمية (👍 أو إيموجي رقم)
    const isQuantityReaction =
      reactionText === '👍' ||
      /^[\s0️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣9️⃣🔟]+$/u.test(reactionText);

    if (!isQuantityReaction) {
      return null;
    }

    const sender = msg.key.participant || msg.key.remoteJid;
    const phone = cleanPhone(sender);
    if (!phone) return null;

    const quantity = extractQuantity(reactionText);
    const transactionId = uuidv4();
    addProcessedId(messageId);

    // نحاول جلب بيانات الرسالة الأصلية من الكاش
    const originalMsg = whatsapp.getCachedMessage(targetMessageId);
    const quotedSender = originalMsg?.key?.participant || originalMsg?.key?.remoteJid;
    const quotedPhone = cleanPhone(quotedSender);
    const quotedText = whatsapp.extractText(originalMsg) || '';

    logger.info('🎯 تفاعل استلام جديد', {
      transactionId: transactionId.substring(0, 8),
      acceptor: phone,
      orderOwner: quotedPhone,
      reaction: reactionText,
      quantity,
    });

    return {
      transactionId,
      messageId,
      type: 'accept',
      phone,                              // المستلم (الكابتن) → رصيده يقل
      quotedPhone: quotedPhone || '',     // صاحب الطلب → رصيده يزيد
      quantity,
      text: reactionText,
      quotedText: quotedText.substring(0, 200),
      quotedMessageId: targetMessageId,
      timestamp: new Date().toISOString(),
      groupId: msg.key.remoteJid,
      source: 'reaction',
    };
  }

  // ====================================================
  // حالة 2: رسالة نصية
  // ====================================================
  const text = whatsapp.extractText(msg);
  if (!text) return null;

  const sender = msg.key.participant || msg.key.remoteJid;
  const phone = cleanPhone(sender);
  if (!phone) return null;

  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  const isReply = !!contextInfo?.quotedMessage;

  // ====================================================
  // حالة 2أ: رسالة أصلية (ليست ردًا) → طلب
  // ====================================================
  if (!isReply) {
    addProcessedId(messageId);
    return {
      type: 'order',
      messageId,
      phone,
      text: text.substring(0, 500),
      timestamp: new Date().toISOString(),
      groupId: msg.key.remoteJid,
    };
  }

  // ====================================================
  // حالة 2ب: رد على رسالة → تحقق من كلمة الاستلام
  // ====================================================
  if (!isAcceptMessage(text)) {
    logger.debug('رد لكن ليس استلاماً', { phone, text: text.substring(0, 30) });
    return null;
  }

  // استخراج بيانات الرسالة المرد عليها
  const quotedParticipant = contextInfo?.participant;
  const quotedPhone = cleanPhone(quotedParticipant);
  const quotedText =
    contextInfo?.quotedMessage?.conversation ||
    contextInfo?.quotedMessage?.extendedTextMessage?.text ||
    contextInfo?.quotedMessage?.imageMessage?.caption ||
    '';
  const quotedMessageId = contextInfo?.stanzaId || '';

  // استخراج الكمية من نص الرد
  const textAfterWord = text.replace(/^(تم|هات|تن|اوك)\s*/i, '').trim();
  const quantity = extractQuantity(textAfterWord || text);

  const transactionId = uuidv4();
  addProcessedId(messageId);

  logger.info('🎯 رد استلام جديد', {
    transactionId: transactionId.substring(0, 8),
    acceptor: phone,
    orderOwner: quotedPhone,
    quantity,
  });

  return {
    transactionId,
    messageId,
    type: 'accept',
    phone,                              // المستلم (الكابتن) → رصيده يقل
    quotedPhone: quotedPhone || '',     // صاحب الطلب → رصيده يزيد
    quantity,
    text,
    quotedText: quotedText.substring(0, 200),
    quotedMessageId,
    timestamp: new Date().toISOString(),
    groupId: msg.key.remoteJid,
    source: 'reply',
  };
}

module.exports = {
  processMessage,
  updateAcceptWords,
  getAcceptWords,
  extractQuantity,
  emojiToNumber,
  isAcceptMessage,
  cleanPhone,
};
