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
 *
 * أرقام الأردن (962): 12 خانة (962 + 9 أرقام)
 * واتساب يضيف أحياناً prefix زائداً في البداية:
 *   - 1962791234567 (13 خانة) → 962791234567 (12 خانة)
 *   - 23428820500642 (14 خانة) → 428820500642 (12 خانة)
 *
 * الجروب (@g.us) تُرفض دائماً
 */
function cleanPhone(jid) {
  if (!jid) return null;

  // رفض معرفات الجروب
  if (jid.includes('@g.us')) return null;

  // إزالة الجزء بعد @
  let phone = jid.split('@')[0].trim();

  // إزالة أي حروف غير رقمية
  phone = phone.replace(/\D/g, '');

  if (!phone) return null;

  // أرقام الأردن 12 خانة → احذف من البداية حتى يصبح 12 خانة
  while (phone.length > 12) {
    phone = phone.substring(1);
  }

  // أقل من 9 أرقام → غير صالح
  if (phone.length < 9) return null;

  return phone;
}

/**
 * تحويل إيموجيات الأرقام إلى أرقام
 *
 * الإيموجيات تصل أحياناً بـ variation selectors مختلفة
 * لذا نستخدم codePoint للتعرف عليها بدقة
 */
function emojiToNumber(text) {
  if (!text) return null;

  // تنظيف الـ variation selectors (U+FE0F و U+20E3)
  // ثم البحث عن الأرقام الإيموجية
  const cleaned = text.replace(/\uFE0F|\u20E3/g, '').trim();

  // خريطة الإيموجيات بعد إزالة الـ variation selectors
  // 0️⃣ = 0\uFE0F\u20E3 → بعد التنظيف = '0'
  // لكن نحتاج للتعامل مع الصيغة الأصلية أيضاً
  const emojiMap = {
    '0️⃣': 0, '1️⃣': 1, '2️⃣': 2, '3️⃣': 3, '4️⃣': 4,
    '5️⃣': 5, '6️⃣': 6, '7️⃣': 7, '8️⃣': 8, '9️⃣': 9,
    '🔟': 10,
    // صيغ بديلة بدون variation selector
    '0⃣': 0, '1⃣': 1, '2⃣': 2, '3⃣': 3, '4⃣': 4,
    '5⃣': 5, '6⃣': 6, '7⃣': 7, '8⃣': 8, '9⃣': 9,
  };

  // محاولة مطابقة مباشرة
  const trimmed = text.trim();
  if (emojiMap[trimmed] !== undefined) {
    return emojiMap[trimmed];
  }

  // استبدال الإيموجيات بأرقام
  let result = text;
  for (const [emoji, num] of Object.entries(emojiMap)) {
    result = result.split(emoji).join(String(num));
  }

  // استخراج الرقم
  const numbers = result.replace(/[^\d]/g, '');
  if (numbers) {
    const n = parseInt(numbers, 10);
    if (n > 0) return n;
  }

  return null;
}

/**
 * التحقق مما إذا كان النص تفاعل كمي (👍 أو إيموجي رقم)
 */
function isQuantityEmoji(text) {
  if (!text) return false;
  const t = text.trim();

  // 👍 مباشرة
  if (t === '👍') return true;

  // إيموجيات الأرقام المعروفة
  const quantityEmojis = [
    '1️⃣','2️⃣','3️⃣','4️⃣','5️⃣',
    '6️⃣','7️⃣','8️⃣','9️⃣','0️⃣','🔟',
    '1⃣','2⃣','3⃣','4⃣','5⃣',
    '6⃣','7⃣','8⃣','9⃣','0⃣',
  ];

  for (const emoji of quantityEmojis) {
    if (t === emoji || t.includes(emoji)) return true;
  }

  // رقم عادي وحده (مثل "3" أو "5")
  if (/^\d+$/.test(t)) return true;

  return false;
}

/**
 * استخراج الكمية من النص أو التفاعل
 */
function extractQuantity(text) {
  if (!text) return 1;
  const t = text.trim();

  // 👍 = 1
  if (t === '👍') return 1;

  // محاولة تحويل الإيموجي
  const emojiNum = emojiToNumber(t);
  if (emojiNum !== null && emojiNum > 0) return emojiNum;

  // رقم عادي في النص
  const numberMatch = t.match(/(\d+)/);
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

  // 👍 أو إيموجي رقم وحده
  if (isQuantityEmoji(cleaned)) return true;

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

    logger.debug('📥 تفاعل وارد', {
      text: reactionText,
      codes: reactionText ? [...reactionText].map(c => c.codePointAt(0).toString(16)).join(',') : 'empty',
      jid: msg.key.participant || msg.key.remoteJid,
    });

    // فقط التفاعلات الكمية
    if (!isQuantityEmoji(reactionText)) {
      logger.debug('تفاعل غير كمي - تجاهل', { text: reactionText });
      return null;
    }

    const targetMessageId = whatsapp.getReactionTargetId(msg);

    // استخراج رقم هاتف من وضع التفاعل
    const senderJid = whatsapp.getSenderJid(msg);
    const acceptorPhone = cleanPhone(senderJid);
    if (!acceptorPhone) {
      logger.warn('⚠️ تفاعل بدون رقم هاتف صالح', {
        participant: msg.key.participant,
        remoteJid: msg.key.remoteJid,
      });
      return null;
    }

    const quantity = extractQuantity(reactionText);
    const transactionId = uuidv4();
    addProcessedId(messageId);

    // جلب بيانات الرسالة الأصلية (صاحب الطلب)
    const originalMsg = whatsapp.getCachedMessage(targetMessageId);
    let orderOwnerPhone = null;
    let quotedText = '';

    if (originalMsg) {
      // صاحب الطلب: participant في رسائل الجروب
      const ownerJid = originalMsg.key.participant;
      orderOwnerPhone = cleanPhone(ownerJid);
      quotedText = whatsapp.extractText(originalMsg) || '';
    }

    logger.info('🎯 تفاعل استلام', {
      id: transactionId.substring(0, 8),
      acceptor: acceptorPhone,
      owner: orderOwnerPhone || 'غير معروف',
      reaction: reactionText,
      qty: quantity,
      targetId: targetMessageId,
      cacheHit: !!originalMsg,
    });

    return {
      transactionId,
      messageId,
      type: 'accept',
      phone: acceptorPhone,          // المستلم → رصيده يقل
      acceptorPhone,
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

  // استخراج رقم هاتف المرسل
  const senderJid = whatsapp.getSenderJid(msg);
  const senderPhone = cleanPhone(senderJid);

  if (!senderPhone) {
    logger.debug('تم تجاهل رسالة بدون رقم هاتف صالح', {
      participant: msg.key.participant,
      remoteJid: msg.key.remoteJid,
    });
    return null;
  }

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

  // استخراج الكمية من النص بعد كلمة الاستلام
  const textAfterWord = text.replace(/^(تم|هات|تن|اوك)\s*/i, '').trim();
  const quantity = extractQuantity(textAfterWord || text);

  const transactionId = uuidv4();
  addProcessedId(messageId);

  logger.info('🎯 رد استلام', {
    id: transactionId.substring(0, 8),
    acceptor: senderPhone,
    owner: orderOwnerPhone || 'غير معروف',
    qty: quantity,
  });

  return {
    transactionId,
    messageId,
    type: 'accept',
    phone: senderPhone,             // المستلم → رصيده يقل
    acceptorPhone: senderPhone,
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
  isQuantityEmoji,
  cleanPhone,
};
