/**
 * parser.js - تحليل الرسائل
 * ================================
 * يحلل رسائل الجروب ويستخرج:
 * 1. الطلبات الأصلية (type: 'order')
 * 2. ردود الاستلام نصية (type: 'accept')
 * 3. تفاعلات الاستلام 👍/2️⃣/3️⃣ (type: 'accept')
 *
 * منطق الرصيد:
 * - صاحب الطلب (orderOwnerPhone) → +quantity (سلّم طلبات → رصيده يزيد)
 * - المستلم (acceptorPhone) → -quantity (استلم طلبات → رصيده يقل)
 */

const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const logger = require('./logger');
const whatsapp = require('./whatsapp');

// مجموعة المعرفات المعالجة لمنع التكرار
const processedIds = new Set();

// كلمات الاستلام (تُحدّث من Google Sheets)
let acceptWords = [...config.defaultAcceptWords];

function updateAcceptWords(words) {
  if (Array.isArray(words) && words.length > 0) {
    acceptWords = words.map((w) => w.trim().toLowerCase());
    logger.info('تم تحديث كلمات الاستلام', { words: acceptWords });
  }
}

function getAcceptWords() {
  return [...acceptWords];
}

/**
 * تنظيف رقم الهاتف من واتساب
 * واتساب يرسل الأرقام بصيغ مختلفة:
 *   - 966501234567@s.whatsapp.net  → 966501234567
 *   - 109346058985724@s.whatsapp.net → يحتوي على رقم زائد في البداية
 *
 * نحذف كل شيء بعد @ ثم نحتفظ بالأرقام فقط.
 * إذا كان الطول > 13 رقم، نحذف الرقم الأول (encoding artifact).
 */
function cleanPhone(jid) {
  if (!jid) return null;

  // إزالة الجزء بعد @
  let phone = jid.split('@')[0].trim();

  // إزالة أي حروف غير رقمية
  phone = phone.replace(/\D/g, '');

  if (!phone) return null;

  // أرقام الهاتف مع رمز الدولة عادةً 11-13 رقم
  // إذا كان أطول من 13 رقم → احذف الرقم الأول
  if (phone.length > 13) {
    phone = phone.substring(1);
  }

  return phone;
}

/**
 * تحويل إيموجيات الأرقام إلى أرقام
 */
function emojiToNumber(text) {
  const emojiMap = {
    '0️⃣': '0', '1️⃣': '1', '2️⃣': '2', '3️⃣': '3',
    '4️⃣': '4', '5️⃣': '5', '6️⃣': '6', '7️⃣': '7',
    '8️⃣': '8', '9️⃣': '9', '🔟': '10',
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
 */
function extractQuantity(text) {
  if (!text) return 1;
  const cleaned = text.trim();

  if (cleaned === '👍' || cleaned.includes('👍')) return 1;

  const emojiNum = emojiToNumber(cleaned);
  if (emojiNum !== null && emojiNum > 0) return emojiNum;

  const numberMatch = cleaned.match(/(\d+)/);
  if (numberMatch) {
    const num = parseInt(numberMatch[1], 10);
    if (num > 0 && num <= 9999) return num;
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

  if (cleaned === '👍') return true;

  // إيموجيات أرقام وحدها (2️⃣ أو 3️⃣ ...)
  const emojiOnlyPattern = /^[\s0️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣9️⃣🔟]+$/u;
  if (emojiOnlyPattern.test(cleaned)) return true;

  return false;
}

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
 */
async function processMessage(msg, sock) {
  const messageId = msg.key.id;
  if (processedIds.has(messageId)) return null;

  // ====================================================
  // حالة 1: تفاعل (reaction) مثل 👍 أو 2️⃣ أو 3️⃣
  // ====================================================
  if (whatsapp.isReaction(msg)) {
    const reactionText = msg.message.reactionMessage.text;
    const targetMessageId = whatsapp.getReactionTargetId(msg);

    // فقط التفاعلات الكمية (👍 أو إيموجي رقم)
    const isQuantityReaction =
      reactionText === '👍' ||
      /^[\s0️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣9️⃣🔟]+$/u.test(reactionText);

    if (!isQuantityReaction) return null;

    const senderJid = msg.key.participant || msg.key.remoteJid;
    const acceptorPhone = cleanPhone(senderJid);
    if (!acceptorPhone) return null;

    const quantity = extractQuantity(reactionText);
    const transactionId = uuidv4();
    addProcessedId(messageId);

    // جلب بيانات الرسالة الأصلية (صاحب الطلب)
    const originalMsg = whatsapp.getCachedMessage(targetMessageId);
    const ownerJid = originalMsg?.key?.participant || originalMsg?.key?.remoteJid;
    const orderOwnerPhone = cleanPhone(ownerJid);
    const quotedText = whatsapp.extractText(originalMsg) || '';

    logger.info('🎯 تفاعل استلام', {
      id: transactionId.substring(0, 8),
      acceptor: acceptorPhone,
      owner: orderOwnerPhone,
      reaction: reactionText,
      qty: quantity,
    });

    return {
      transactionId,
      messageId,
      type: 'accept',
      // المستلم (الكابتن الذي وضع التفاعل) → رصيده يقل
      phone: acceptorPhone,
      acceptorPhone,
      // صاحب الطلب → رصيده يزيد
      quotedPhone: orderOwnerPhone || '',
      orderOwnerPhone: orderOwnerPhone || '',
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

  const senderJid = msg.key.participant || msg.key.remoteJid;
  const senderPhone = cleanPhone(senderJid);
  if (!senderPhone) return null;

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
      phone: senderPhone,
      text: text.substring(0, 500),
      timestamp: new Date().toISOString(),
      groupId: msg.key.remoteJid,
    };
  }

  // ====================================================
  // حالة 2ب: رد على رسالة → تحقق من كلمة الاستلام
  // ====================================================
  if (!isAcceptMessage(text)) {
    logger.debug('رد لكن ليس استلاماً', { phone: senderPhone, text: text.substring(0, 30) });
    return null;
  }

  const quotedOwnerJid = contextInfo?.participant;
  const orderOwnerPhone = cleanPhone(quotedOwnerJid);
  const quotedText =
    contextInfo?.quotedMessage?.conversation ||
    contextInfo?.quotedMessage?.extendedTextMessage?.text ||
    contextInfo?.quotedMessage?.imageMessage?.caption ||
    '';
  const quotedMessageId = contextInfo?.stanzaId || '';

  const textAfterWord = text.replace(/^(تم|هات|تن|اوك)\s*/i, '').trim();
  const quantity = extractQuantity(textAfterWord || text);

  const transactionId = uuidv4();
  addProcessedId(messageId);

  logger.info('🎯 رد استلام', {
    id: transactionId.substring(0, 8),
    acceptor: senderPhone,
    owner: orderOwnerPhone,
    qty: quantity,
  });

  return {
    transactionId,
    messageId,
    type: 'accept',
    // المستلم (الكابتن الذي رد) → رصيده يقل
    phone: senderPhone,
    acceptorPhone: senderPhone,
    // صاحب الطلب → رصيده يزيد
    quotedPhone: orderOwnerPhone || '',
    orderOwnerPhone: orderOwnerPhone || '',
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
