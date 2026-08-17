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
const { classifyOriginalOrder, extractDeliveryOrderDetails } = require('./order-classification');
let _sheets = null;
function getSheets() {
  if (!_sheets) _sheets = require('./sheets');
  return _sheets;
}
// مجموعة المعرفات المعالجة لمنع التكرار
const processedIds = new Set();

// كلمات الاستلام المستقلة فقط (تُحدّث من Google Sheets).
// الرد المقتبس على طلب نصي يقبل بأي نص؛ أما هذه الكلمات فتمنع رسائل التأكيد
// الشائعة إذا أُرسلت بلا رد من التحول إلى طلب أصلي بالخطأ.
const standaloneConfirmationWords = ['تم', 'تمم', 'تا', 'ت', 'tam', 'tm'];
let acceptWords = [...new Set([...config.defaultAcceptWords, ...standaloneConfirmationWords])];

function updateAcceptWords(words) {
  if (Array.isArray(words) && words.length > 0) {
    acceptWords = [...new Set([
      ...words.map((w) => w.trim().toLowerCase()),
      ...standaloneConfirmationWords,
    ])];
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
  const t = text.trim();

  // 👍 = 1 (قاعدة خاصة)
  if (t === '👍') return 1;
  
  // 🔟 = 10 (إيموجي واحد)
  if (t === '🔟') return 10;

  // نستخدم regex لاستخراج كل إيموجي رقمي بشكل منفصل
  // نمط الإيموجي الرقمي: رقم (0-9) + variation selector (️ اختياري) + ⃣
  const keycapRegex = /([0-9])️?⃣/g;
  let combinedNumberStr = '';
  let lastIndex = 0;
  let match;
  
  // معالجة 🔟 أولاً إذا كان ضمن نص
  const textWithoutTen = t.replace(/🔟/g, '10');
  
  // استخراج كل إيموجي رقمي
  const keycapRegex2 = /([0-9])️?⃣/g;
  let result2 = '';
  let m;
  while ((m = keycapRegex2.exec(textWithoutTen)) !== null) {
    result2 += m[1];
  }
  
  // إضافة أرقام النص العادي (10، 20...) إذا كان النص أرقام فقط
  if (!result2) {
    const numMatch = textWithoutTen.match(/^(\d+)$/);
    if (numMatch) result2 = numMatch[1];
  }

  if (result2) {
    const n = parseInt(result2, 10);
    if (!isNaN(n) && n > 0) return n;
  }

  return null;
}

/**
 * التحقق مما إذا كان النص تفاعل كمي (👍 أو إيموجي رقم)
 * يدعم أي إيموجي كمية موجب: 👍، 1️⃣، 5️⃣، 8️⃣، 🔟، 1️⃣2️⃣ (12)، أو أي تركيبة إيموجية رقمية موجبة
 */
function isQuantityEmoji(text) {
  if (!text) return false;
  const t = text.trim();

  // 👍 مباشرة
  if (t === '👍') return true;
  
  // 🔟 (رقم 10 كإيموجي واحد)
  if (t === '🔟') return true;

  // تحقق: هل يحتوي على إيموجي رقمي واحد على الأقل
  const hasKeycapEmoji = /[\u0030-\u0039]\uFE0F?\u20E3/.test(t);
  if (!hasKeycapEmoji) return false;
  
  // تأكد أن النتيجة بعد تحويل الإيموجيات هي رقم صحيح
  const converted = emojiToNumber(t);
  return converted !== null && converted > 0;
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

/**
 * رسالة قبول لا ترد على طلب أصلي لا تمثل عملية. مثال: يكتب الشخص «تم»
 * كرسالة مستقلة ثم يضع تفاعلاً عليها. لا يجوز إنشاء رصيد من هذا المسار.
 */
function isStandaloneAcceptWithoutOrder(text, isReply) {
  return !isReply && isAcceptMessage(text);
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
    const cancelEmojis = ['\u274c', '\u2716\ufe0f', '\u2716', '\u274e', '\xd7', 'x', 'X'];
    const isCancelEmoji = reactionText && cancelEmojis.includes(reactionText.trim());
    
    // نص فارغ = حذف الإيموجي (عكس العملية تماماً)
    const isRemoveEmoji = reactionText === '' || reactionText === null || reactionText === undefined;

    // فقط التفاعلات الكمية أو الإلغاء أو الحذف
    if (!isQuantityEmoji(reactionText) && !isCancelEmoji && !isRemoveEmoji) {
      logger.debug('تفاعل غير كمي وغير إلغاء - إرجاع unknown_emoji', { text: reactionText });
      // نُرجع unknown_emoji بدلاً من null حتى يتمكن server.js من تتبعه
      // (مثلاً: تغيير 👍 إلى 🙏 يُرسَل كـ remove + add، نحتاج معرفة الإيموجي الجديد)
      return {
        type: 'unknown_emoji',
        messageId,
        phone: cleanPhone(whatsapp.getSenderJid(msg)) || (whatsapp.getSenderJid(msg) || '').split(':')[0],
        reactionText,
        targetMessageId: whatsapp.getReactionTargetId(msg),
        timestamp: new Date().toISOString(),
        groupId: msg.key.remoteJid,
      };
    }

    const targetMessageId = whatsapp.getReactionTargetId(msg);

    // استخراج رقم هاتف من وضع التفاعل
    const senderJid = whatsapp.getSenderJid(msg);
    let acceptorPhone = cleanPhone(senderJid);
    
    // إذا كان المرسل LID غير محلول — نحاول حله بثلاث طرق
    if (!acceptorPhone && senderJid && senderJid.includes('@lid')) {
      // محاولة 1: الكاش المحلي (base-prefix matching)
      const resolved = whatsapp.resolveLid(senderJid);
      if (resolved && !resolved.includes('@lid')) {
        acceptorPhone = cleanPhone(resolved);
        if (!acceptorPhone) acceptorPhone = resolved.split('@')[0].replace(/\D/g, '') || senderJid;
        logger.info(`✅ حل LID في التفاعل (كاش): ${senderJid.substring(0,15)} → ${acceptorPhone}`);
      } else {
        // محاولة 2: ورقة المسجلين (عمود D)
        try {
          const sheetsInst = getSheets();
          if (sheetsInst?.resolvePhoneFromRegistered) {
            const fromReg = sheetsInst.resolvePhoneFromRegistered(senderJid);
            if (fromReg) {
              acceptorPhone = fromReg;
              whatsapp.addLidMapping(senderJid, fromReg + '@s.whatsapp.net');
              logger.info(`✅ حل LID في التفاعل (ورقة المسجلين): ${senderJid.substring(0,15)} → ${fromReg}`);
            }
          }
        } catch(e) {}
        // محاولة 3: استخدام LID كمعرف مؤقت
        if (!acceptorPhone) {
          acceptorPhone = senderJid.split(':')[0];
          logger.warn(`⚠️ تفاعل من LID غير محلول — معرف مؤقت`, { lid: senderJid.substring(0, 15) });
          whatsapp.queueLidForResolve(senderJid);
        }
      }
    }
    
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
      // إذا كان صاحب الرسالة LID غير محلول — ثلاث طرق
      if (!orderOwnerPhone && ownerJid && ownerJid.includes('@lid')) {
        // محاولة 1: كاش محلي
        const resolvedOwner = whatsapp.resolveLid(ownerJid);
        if (resolvedOwner && !resolvedOwner.includes('@lid')) {
          orderOwnerPhone = cleanPhone(resolvedOwner);
          if (!orderOwnerPhone) orderOwnerPhone = resolvedOwner.split('@')[0].replace(/\D/g, '') || ownerJid;
        } else {
          // محاولة 2: ورقة المسجلين
          try {
            const sheetsInst = getSheets();
            if (sheetsInst?.resolvePhoneFromRegistered) {
              const fromReg2 = sheetsInst.resolvePhoneFromRegistered(ownerJid);
              if (fromReg2) {
                orderOwnerPhone = fromReg2;
                whatsapp.addLidMapping(ownerJid, fromReg2 + '@s.whatsapp.net');
                logger.info(`✅ حل LID صاحب رسالة تم (ورقة المسجلين): → ${fromReg2}`);
              }
            }
          } catch(e) {}
          // محاولة 3: معرف مؤقت
          if (!orderOwnerPhone) {
            orderOwnerPhone = ownerJid.split(':')[0];
            whatsapp.queueLidForResolve(ownerJid);
          }
        }
      }
      quotedText = whatsapp.extractText(originalMsg) || '';
    }
    
    // محاولة استرجاع صاحب الرسالة من tamCache إذا لم يوجد في الكاش
    if (!orderOwnerPhone) {
      const captainFromCache = whatsapp.getCaptainByMessageId(targetMessageId);
      if (captainFromCache) {
        orderOwnerPhone = captainFromCache.includes('@lid') ? captainFromCache : cleanPhone(captainFromCache + '@s.whatsapp.net') || captainFromCache;
      }
    }

    // حساب الكمية (بعد تعريف quotedText)
    // عند حذف الإيموجي: لا نعرف الكمية من النص (فارغ)، سيبحث server.js عنها في سجل الحركات
    const quantity = isCancelEmoji ? extractQuantity(quotedText) :
                     isRemoveEmoji ? 0 :  // 0 = سيجلبها server.js من السجل
                     extractQuantity(reactionText);

    const resultType = isCancelEmoji ? 'cancel' : isRemoveEmoji ? 'remove' : 'accept';

    logger.info(`🎯 تفاعل ${isCancelEmoji ? 'إلغاء' : isRemoveEmoji ? 'حذف إيموجي' : 'انتاج'}`, {
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
  // إذا كان المرسل LID غير محلول، نستخدم LID نفسه كمعرف مؤقت
  // حتى نتمكن من تخزين رسالة “تم” في tamCache
  const effectiveSenderPhone = senderPhone || 
    (senderJid && senderJid.includes('@lid') ? senderJid : null);
  if (!effectiveSenderPhone) {
    logger.debug('تم تجاهل رسالة بدون رقم هاتف صالح', {
      participant: msg.key.participant,
      remoteJid: msg.key.remoteJid,
    });
    return null;
  }

  // التحقق من نوع الرسالة
  const text = whatsapp.extractText(msg);
  const msgType = whatsapp.getMessageType(msg); // 'text' | 'audio' | 'image' | 'video' | 'other'

  // قاعدة صريحة: الملصقات ليست طلبات، ولا يجوز أن تكون مرجعاً لعملية.
  // نضيف المعرّف كمعالج كي لا يعاد فحصه أثناء الاستعادة، من دون إنشاء cache أو رصيد.
  if (msgType === 'sticker') {
    addProcessedId(messageId);
    logger.info('⚠️ تجاهل ملصق: لا يُحتسب كطلب أو حركة', {
      phone: effectiveSenderPhone,
      msgId: messageId.substring(0, 8),
    });
    return null;
  }

  // التحقق من الرد — نبحث عن contextInfo في جميع أنواع الرسائل
  const msgObj = msg.message || {};
  const contextInfo =
    msgObj.extendedTextMessage?.contextInfo ||
    msgObj.imageMessage?.contextInfo ||
    msgObj.videoMessage?.contextInfo ||
    msgObj.audioMessage?.contextInfo ||
    msgObj.documentMessage?.contextInfo ||
    msgObj.stickerMessage?.contextInfo ||
    msgObj.buttonsResponseMessage?.contextInfo ||
    msgObj.listResponseMessage?.contextInfo ||
    msgObj.conversation && null; // conversation لا يحمل contextInfo
  const isReply = !!contextInfo?.quotedMessage;
  const isVoiceReply = Boolean(contextInfo?.quotedMessage?.audioMessage);
  const voiceMessageId = isVoiceReply ? (contextInfo?.stanzaId || '') : '';

  // حتى لو كان الرد نصاً مثل «تم»، لا نسمح بتحويل الرد على ملصق إلى استلام.
  if (contextInfo?.quotedMessage?.stickerMessage) {
    addProcessedId(messageId);
    logger.info('⚠️ تجاهل رد على ملصق: لا يُحتسب كاستلام أو حركة', {
      phone: effectiveSenderPhone,
      msgId: messageId.substring(0, 8),
    });
    return null;
  }

  // ====================================================
  // حالة 2أ: رسالة أصلية (ليست ردًا)
  // أي رسالة ليست رداً تعتبر "طلب" (Production)
  // ====================================================
  if (!isReply) {
    // «تم» أو أي كلمة استلام مستقلة ليست طلباً ولا تُحفظ كمرجع لعملية.
    // يحمي ذلك من احتساب تفاعل الشخص على رسالة «تم» كتبها بنفسه.
    if (isStandaloneAcceptWithoutOrder(text, isReply)) {
      addProcessedId(messageId);
      logger.info('⚠️ تجاهل رسالة استلام مستقلة بلا طلب مقتبس', {
        phone: effectiveSenderPhone,
        text: (text || '').substring(0, 30),
        msgId: messageId.substring(0, 8),
      });
      return null;
    }

    // إذا كانت الرسالة مجرد إيموجي رقمي أو 👍 بدون رد → نتجاهلها كطلب لأنها غالباً خطأ
    if (text && isQuantityEmoji(text)) {
      logger.debug('تجاهل إيموجي كمي بدون رد', { phone: effectiveSenderPhone, text });
      return null;
    }

    const orderClassification = classifyOriginalOrder({ text, messageType: msgType });
    addProcessedId(messageId);
    return {
      type: 'order',
      messageId,
      phone: effectiveSenderPhone,
      text: text ? text.substring(0, 500) : `[رسالة ${msgType}]`,
      orderClassification: orderClassification.classification,
      orderClassificationReason: orderClassification.reason,
      deliveryOrderDetails: orderClassification.deliveryDetails || extractDeliveryOrderDetails(text),
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
  let quotedOwnerJid = 
    contextInfo?.senderPn ||
    contextInfo?.participantPn ||
    (contextInfo?.participant?.includes('@s.whatsapp.net') ? contextInfo.participant : null);
  
  // إذا كان participant هو LID، نحاول حله بأربع طرق متدرجة
  if (!quotedOwnerJid && contextInfo?.participant) {
    if (contextInfo.participant.includes('@lid')) {
      const lid = contextInfo.participant;
      const quotedMsgId = contextInfo?.stanzaId;
      
      // طريقة 1: الرسالة المقتبسة مخزنة في messageCache
      const cachedQuotedMsg = quotedMsgId ? whatsapp.getCachedMessage(quotedMsgId) : null;
      if (cachedQuotedMsg) {
        const resolved = whatsapp.getSenderJid(cachedQuotedMsg);
        if (resolved && !resolved.includes('@lid')) {
          quotedOwnerJid = resolved;
          logger.debug('✅ حل LID من messageCache', { lid: lid.substring(0, 12), resolved });
        }
      }
      
      // طريقة 2: pushName من الرسالة المخزنة + بحث في المسجلين
      if (!quotedOwnerJid || quotedOwnerJid.includes('@lid')) {
        const cachedPushName = quotedMsgId ? whatsapp.getPushNameFromCachedMessage(quotedMsgId) : null;
        if (cachedPushName) {
          const resolved = whatsapp.resolvePhoneByPushName(cachedPushName);
          if (resolved) {
            quotedOwnerJid = resolved;
            // ربط LID بالرقم للمستقبل
            whatsapp.addLidMapping(lid, resolved);
            logger.info(`✅ حل LID من pushName الكاش: ${cachedPushName} → ${resolved}`, { lid: lid.substring(0, 12) });
          }
        }
      }
      
      // طريقة 3: pushName من الرسالة الحالية (contextInfo.pushName)
      if (!quotedOwnerJid || quotedOwnerJid.includes('@lid')) {
        const ctxPushName = contextInfo?.pushName || contextInfo?.quotedMessage?.extendedTextMessage?.contextInfo?.pushName;
        if (ctxPushName) {
          const resolved = whatsapp.resolvePhoneByPushName(ctxPushName);
          if (resolved) {
            quotedOwnerJid = resolved;
            whatsapp.addLidMapping(lid, resolved);
            logger.info(`✅ حل LID من contextInfo.pushName: ${ctxPushName} → ${resolved}`, { lid: lid.substring(0, 12) });
          }
        }
      }
      
      // طريقة 4: استخدام LID كما هو (آخر خيار)
      if (!quotedOwnerJid || quotedOwnerJid.includes('@lid')) {
        quotedOwnerJid = lid;
        logger.warn('⚠️ LID غير محلول بعد كل المحاولات', { lid: lid.substring(0, 12) });
      }
    } else {
      quotedOwnerJid = contextInfo.participant;
    }
  }
  // إذا كان quotedOwnerJid لا يزال LID — جرب base-prefix matching ثم ورقة المسجلين
  if (quotedOwnerJid && quotedOwnerJid.includes('@lid')) {
    // محاولة 1: base-prefix matching في الكاش المحلي
    const resolvedFromMap = whatsapp.resolveLid(quotedOwnerJid);
    if (resolvedFromMap && !resolvedFromMap.includes('@lid')) {
      quotedOwnerJid = resolvedFromMap;
      logger.info(`✅ حل LID صاحب الطلب (base-prefix): ${quotedOwnerJid.substring(0,15)} → ${resolvedFromMap}`);
    } else {
      // محاولة 2: ورقة المسجلين (عمود D)
      try {
        const sheetsInst = getSheets();
        if (sheetsInst?.resolvePhoneFromRegistered) {
          const fromRegistered = sheetsInst.resolvePhoneFromRegistered(quotedOwnerJid);
          if (fromRegistered) {
            quotedOwnerJid = fromRegistered + '@s.whatsapp.net';
            whatsapp.addLidMapping(quotedOwnerJid.includes('@lid') ? quotedOwnerJid : (contextInfo?.participant || quotedOwnerJid), quotedOwnerJid);
            logger.info(`✅ حل LID صاحب الطلب (ورقة المسجلين): → ${fromRegistered}`);
          }
        }
      } catch(e) {}
      // إذا لم يُحل — أضف للقائمة التلقائية
      if (quotedOwnerJid && quotedOwnerJid.includes('@lid')) {
        whatsapp.queueLidForResolve(quotedOwnerJid);
      }
    }
  }
  let resolvedOrderOwnerPhone = cleanPhone(quotedOwnerJid);
  // إذا لم يُحل لكنه LID — استخدم الجزء الرقمي كمعرف مؤقت
  if (!resolvedOrderOwnerPhone && quotedOwnerJid && quotedOwnerJid.includes('@lid')) {
    resolvedOrderOwnerPhone = quotedOwnerJid.split(':')[0];
  }
  const quotedText =
    contextInfo?.quotedMessage?.conversation ||
    contextInfo?.quotedMessage?.extendedTextMessage?.text ||
    contextInfo?.quotedMessage?.imageMessage?.caption ||
    '';
  const quotedMessageId = contextInfo?.stanzaId || '';
  // ردٌ مقتبس لا يصبح تأكيداً مالياً إلا إذا كانت الرسالة الأصلية طلباً فعلياً.
  // الصوت يبقى مؤهلاً وفق قواعد التسجيلات الصوتية المعتمدة.
  const orderClassification = classifyOriginalOrder({
    text: quotedText,
    messageType: isVoiceReply ? 'audio' : 'text',
    isVoiceOrder: isVoiceReply,
  });

  // معالجة خاصة: إذا لم يُحل صاحب الطلب بعد، نحاول من messageCache
  if (!resolvedOrderOwnerPhone && quotedMessageId) {
    const cachedQuoted = whatsapp.getCachedMessage(quotedMessageId);
    if (cachedQuoted) {
      if (cachedQuoted.key?.fromMe) {
        // رسالة البوت: نحاول استخراج رقم المنتج من orderCache أولاً
        const fromOrderCache = whatsapp.getOrderByReplyId(quotedMessageId);
        if (fromOrderCache) {
          resolvedOrderOwnerPhone = fromOrderCache;
          logger.info('✅ صاحب الطلب من orderCache (رد على رسالة بوت)', { phone: resolvedOrderOwnerPhone });
        } else {
          // استخراج رقم الهاتف من نص رسالة البوت
          const botMsgText =
            cachedQuoted.message?.conversation ||
            cachedQuoted.message?.extendedTextMessage?.text || '';
          const phoneMatch = botMsgText.match(/(?:^|\s)(\d{9,12})(?:\s|$|\n)/);
          if (phoneMatch) {
            resolvedOrderOwnerPhone = cleanPhone(phoneMatch[1]);
            logger.info('✅ صاحب الطلب من نص رسالة البوت', { phone: resolvedOrderOwnerPhone });
          } else {
            logger.warn('⚠️ رد على رسالة بوت بدون رقم مستخرج', { text: botMsgText.substring(0, 80) });
          }
        }
      } else {
        // رسالة عادية — نستخرج صاحبها من messageCache
        const cachedSender = whatsapp.getSenderJid(cachedQuoted);
        if (cachedSender && !cachedSender.includes('@lid')) {
          resolvedOrderOwnerPhone = cleanPhone(cachedSender);
          logger.info('✅ صاحب الطلب من messageCache', { phone: resolvedOrderOwnerPhone });
        }
      }
    }
  }
  const orderOwnerPhone = resolvedOrderOwnerPhone;

  // التحقق من الكمية في نص الرد (إذا كان إيموجيات أرقام فقط)
  const quantity = isQuantityEmoji(text) ? emojiToNumber(text) : 0;

  const transactionId = uuidv4();
  addProcessedId(messageId);

  logger.info('🎯 رد استلام (محاولة)', {
    id: transactionId.substring(0, 8),
    acceptor: effectiveSenderPhone,
    owner: orderOwnerPhone || 'غير معروف',
    qty: quantity,
    text: text.substring(0, 30)
  });

  return {
    transactionId,
    messageId,
    type: 'accept',
    phone: effectiveSenderPhone,    // المستلم (LID أو رقم حقيقي)
    acceptorPhone: effectiveSenderPhone,
    quotedPhone: orderOwnerPhone || '',
    orderOwnerPhone: orderOwnerPhone || '',
    quantity,                       // قد يكون 0 إذا لم يكن إيموجي رقمي
    text,
    quotedText: quotedText.substring(0, 200),
    quotedMessageId,
    orderClassification: orderClassification.classification,
    confidenceLevel: orderClassification.confidenceLevel || (orderClassification.classification === 'invalid' ? 'blocked' : 'ambiguous'),
    orderClassificationReason: orderClassification.reason,
    deliveryOrderDetails: orderClassification.deliveryDetails || extractDeliveryOrderDetails(quotedText),
    isVoiceReply,
    voiceMessageId,
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
  isStandaloneAcceptWithoutOrder,
  isQuantityEmoji,
  cleanPhone,
  classifyOriginalOrder,
  extractDeliveryOrderDetails,
};
