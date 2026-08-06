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

  // رفض معرفات LID (ليست أرقام هاتف)
  if (jid.includes('@lid')) return null;

  // إزالة الجزء بعد @
  let phone = jid.split('@')[0].trim();

  // إزالة أي حروف غير رقمية
  phone = phone.replace(/\D/g, '');

  if (!phone) return null;

  // إذا كان أطول من 12 → احذف من البداية
  while (phone.length > 12) {
    phone = phone.substring(1);
  }

  // أقل من 9 أرقام → غير صالح
  if (phone.length < 9) return null;

  // === توحيد الصيغة: دائماً 9 أرقام (بدون مفتاح الدولة 962) ===
  if (phone.length === 12 && phone.startsWith('962')) {
    phone = phone.substring(3); // 962791234567 → 791234567
  } else if (phone.length === 11 && phone.startsWith('96')) {
    phone = phone.substring(2); // 9679... → 79...
  } else if (phone.length === 10 && phone.startsWith('0')) {
    phone = phone.substring(1); // 0791234567 → 791234567
  }

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

  // 👍 = 1 (قاعدة خاصة)
  if (text.trim() === '👍') return 1;

  // خريطة الإيموجيات الأساسية (بما فيها الأشكال المختلفة)
  const emojiMap = {
    '0️⃣': '0', '1️⃣': '1', '2️⃣': '2', '3️⃣': '3', '4️⃣': '4',
    '5️⃣': '5', '6️⃣': '6', '7️⃣': '7', '8️⃣': '8', '9️⃣': '9',
    '🔟': '10', '0⃣': '0', '1⃣': '1', '2⃣': '2', '3⃣': '3', 
    '4⃣': '4', '5⃣': '5', '6⃣': '6', '7⃣': '7', '8⃣': '8', '9⃣': '9',
    '0': '0', '1': '1', '2': '2', '3': '3', '4': '4',
    '5': '5', '6': '6', '7': '7', '8': '8', '9': '9'
  };

  // تنظيف النص من variation selectors لتسهيل المطابقة
  let result = text.replace(/\uFE0F|\u20E3/g, '');
  
  // استبدال الإيموجيات بأرقام نصية
  let combinedNumberStr = '';
  // نقوم بالمرور على النص حرفاً حرفاً (أو إيموجي إيموجي)
  const characters = [...result];
  for (const char of characters) {
    if (emojiMap[char] !== undefined) {
      combinedNumberStr += emojiMap[char];
    } else if (/\d/.test(char)) {
      combinedNumberStr += char;
    }
  }

  if (combinedNumberStr) {
    const n = parseInt(combinedNumberStr, 10);
    if (!isNaN(n) && n > 0) return n;
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

  // تنظيف الـ variation selectors للتحقق
  const cleaned = t.replace(/\uFE0F|\u20E3/g, '');
  
  // إذا كان النص بعد التنظيف يحتوي فقط على أرقام، فهو إيموجي رقمي (لأن الأرقام العادية ستظهر كأرقام)
  // ولكن المستخدم طلب إيموجيات الأرقام فقط، لذا نتحقق أن النص الأصلي يحتوي على إيموجيات
  const hasEmojiDigits = /[\u0030-\u0039]\u20E3/.test(t) || t.includes('🔟');
  const isPureNumber = /^\d+$/.test(cleaned);

  return (hasEmojiDigits || t === '👍') && isPureNumber;
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
 * "تم" + أي شيء بعدها = رسالة قبول
 * مثل: "تم", "تم ثلث", "تم 3", "تم الجامعة", "تم اذا بزبط"
 */
function isAcceptMessage(text) {
  if (!text) return false;
  const cleaned = text.trim().toLowerCase();

  for (const word of acceptWords) {
    if (
      cleaned === word ||
      cleaned.startsWith(word + ' ') ||
      cleaned.startsWith(word + '\n') ||
      cleaned.startsWith(word)
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

    // ❌ = إلغاء (بكل الأشكال الممكنة)
    const cancelEmojis = ['❌', '✖️', '✖', '❎', '×', 'x', 'X'];
    const isCancelEmoji = reactionText && cancelEmojis.includes(reactionText.trim());

    // فقط التفاعلات الكمية أو الإلغاء
    if (!isQuantityEmoji(reactionText) && !isCancelEmoji) {
      logger.debug('تفاعل غير كمي وغير إلغاء - تجاهل', { text: reactionText });
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

    const transactionId = uuidv4();
    addProcessedId(messageId);

    // جلب بيانات الرسالة الأصلية (صاحب رسالة "تم")
    const originalMsg = whatsapp.getCachedMessage(targetMessageId);
    let orderOwnerPhone = null;
    let quotedText = '';

    if (originalMsg) {
      const ownerJid = whatsapp.getSenderJid(originalMsg);
      orderOwnerPhone = cleanPhone(ownerJid);
      quotedText = whatsapp.extractText(originalMsg) || '';
    }

    // حساب الكمية (بعد تعريف quotedText)
    const quantity = isCancelEmoji ? extractQuantity(quotedText) : extractQuantity(reactionText);

    const resultType = isCancelEmoji ? 'cancel' : 'accept';

    logger.info(`🎯 تفاعل ${isCancelEmoji ? 'إلغاء' : 'انتاج'}`, {
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
      type: resultType,
      phone: acceptorPhone,          // من وضع الإيموجي
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
  // حالة 2: رسالة نصية أو صوتية أو مرئية
  // ====================================================

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

  // التحقق من نوع الرسالة
  const text = whatsapp.extractText(msg);
  const msgType = whatsapp.getMessageType(msg); // 'text' | 'audio' | 'image' | 'video' | 'other'

  // التحقق من الرد (contextInfo موجود في الرسائل النصية فقط)
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  const isReply = !!contextInfo?.quotedMessage;

  // ====================================================
  // حالة 2أ: رسالة أصلية (ليست ردًا)
  // أي رسالة ليست رداً تعتبر "طلب" (Production)
  // ====================================================
  if (!isReply) {
    // إذا كانت الرسالة مجرد إيموجي رقمي أو 👍 بدون رد → نتجاهلها كطلب لأنها غالباً خطأ
    if (text && isQuantityEmoji(text)) {
      logger.debug('تجاهل إيموجي كمي بدون رد', { phone: senderPhone, text });
      return null;
    }

    addProcessedId(messageId);
    return {
      type: 'order',
      messageId,
      phone: senderPhone,
      text: text ? text.substring(0, 500) : `[رسالة ${msgType}]`,
      timestamp: new Date().toISOString(),
      groupId: msg.key.remoteJid,
    };
  }

  // ====================================================
  // حالة 2ب: رد على رسالة (Reply)
  // أي رد على رسالة يعتبر "استلام" (Receipt) بغض النظر عن النص
  // ولكن التسجيل الفعلي يعتمد على الإيموجيات لاحقاً
  // ====================================================
  
  // استخراج بيانات صاحب الطلب الأصلي من الرد
  const quotedOwnerJid = 
    contextInfo?.senderPn ||
    contextInfo?.participantPn ||
    (contextInfo?.participant?.includes('@s.whatsapp.net') ? contextInfo.participant : null) ||
    contextInfo?.participant;
  const orderOwnerPhone = cleanPhone(quotedOwnerJid);
  const quotedText =
    contextInfo?.quotedMessage?.conversation ||
    contextInfo?.quotedMessage?.extendedTextMessage?.text ||
    contextInfo?.quotedMessage?.imageMessage?.caption ||
    '';
  const quotedMessageId = contextInfo?.stanzaId || '';

  // التحقق من الكمية في نص الرد (إذا كان إيموجيات أرقام فقط)
  const quantity = isQuantityEmoji(text) ? emojiToNumber(text) : 0;

  const transactionId = uuidv4();
  addProcessedId(messageId);

  logger.info('🎯 رد استلام (محاولة)', {
    id: transactionId.substring(0, 8),
    acceptor: senderPhone,
    owner: orderOwnerPhone || 'غير معروف',
    qty: quantity,
    text: text.substring(0, 30)
  });

  return {
    transactionId,
    messageId,
    type: 'accept',
    phone: senderPhone,             // المستلم
    acceptorPhone: senderPhone,
    quotedPhone: orderOwnerPhone || '',
    orderOwnerPhone: orderOwnerPhone || '',
    quantity,                       // قد يكون 0 إذا لم يكن إيموجي رقمي
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
