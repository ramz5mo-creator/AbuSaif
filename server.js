/**
 * server.js - نقطة تشغيل النظام v5 (Self-Healing + Recovery)
 * ================================
 * المنطق:
 *
 * 1. أي رسالة تبدأ بـ "تم" → تُحفظ في tamCache + سجل_تم
 *    (لا تُسجَّل كطلب ولا كانتاج/استلام)
 *
 * 2. إيموجي (👍/2️⃣/3️⃣/5️⃣) على رسالة "تم":
 *    → انتاج لمن وضع الإيموجي (حتى لو وصلت إلى 10 أو أكثر يتم تسجيلها كاملة)
 *    → استلام لمن كتب "تم" (الكابتن)
 *    → يُسجَّل في ورقة يومية (كل يوم ورقة)
 *
 * 3. ❌ على رسالة "تم":
 *    → خصم من الطرفين
 *
 * 4. أي رسالة أخرى → تُتجاهل (لا نسجل الطلبات)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const config = require('./config');

// ====================================================
// تصحيح المسارات تلقائياً لتجنب مشكلة EACCES على Render
// ====================================================
try {
  if (config.whatsapp) {
    if (!config.whatsapp.authPath || config.whatsapp.authPath.startsWith('/app/')) {
      config.whatsapp.authPath = path.join(__dirname, 'auth');
    }
  }
  if (config.volumePath && config.volumePath.startsWith('/app/')) {
    config.volumePath = path.join(__dirname, 'volume');
  }
  if (config.logging && config.logging.logsPath && config.logging.logsPath.startsWith('/app/')) {
    config.logging.logsPath = path.join(__dirname, 'logs');
  }
} catch (e) {}

const logger = require('./logger');
const whatsapp = require('./whatsapp');
const parser = require('./parser');
const sheets = require('./sheets');
const { createOneTimeBroadcastProcessor } = require('./one-time-broadcast');
const { authorizeQuantityReaction } = require('./reaction-authorization');
const { validateQuantityReactionTarget } = require('./reaction-target-validation');
const { classifyOriginalOrder } = require('./order-classification');
const messageLog = require('./message-log');
const telegramMonitor = require('./telegram-monitor');

// ============================================================
// تنظيف السجلات عند بدء التشغيل — يفرّغ كل ملف >10MB فوراً
// ============================================================
(function cleanOldLogs() {
  try {
    const fallbackAuth = path.join(__dirname, 'auth');
    const logsDir = path.join(process.env.VOLUME_PATH || fallbackAuth, 'logs');
    if (!fs.existsSync(logsDir)) return;
    const files = fs.readdirSync(logsDir);
    let freed = 0;
    for (const file of files) {
      const filePath = path.join(logsDir, file);
      try {
        const stat = fs.statSync(filePath);
        const sizeMB = stat.size / (1024 * 1024);
        if (sizeMB > 10) {
          fs.writeFileSync(filePath, '');
          freed += stat.size;
          console.log(`[STARTUP] ✅ تم تفريغ: ${file} (${sizeMB.toFixed(1)} MB محرَّرة)`);
        }
      } catch (e) {}
    }
    if (freed > 0) {
      console.log(`[STARTUP] 🧹 إجمالي المساحة المحرَّرة: ${(freed/1024/1024).toFixed(1)} MB`);
    } else {
      console.log('[STARTUP] ✅ السجلات نظيفة (كل ملف < 10MB)');
    }
  } catch (e) {
    console.error('[STARTUP] خطأ في تنظيف السجلات:', e.message);
  }
})();

const processedMessageIds = new Set();
const PROCESSED_MSG_MAX = 10000;
const pendingEmojiReplace = new Map();
const EMOJI_REPLACEMENT_GRACE_MS = 1200;
const PENDING_EMOJI_TTL = 5000;

function isAlreadyProcessed(msgId) {
  return processedMessageIds.has(msgId);
}

function markAsProcessed(msgId) {
  if (!msgId) return;
  processedMessageIds.add(msgId);
  if (processedMessageIds.size > PROCESSED_MSG_MAX) {
    const oldest = Array.from(processedMessageIds).slice(0, 1000);
    oldest.forEach(id => processedMessageIds.delete(id));
  }
}

async function invalidateVoiceReplyTransactions(voiceStatus) {
  if (!voiceStatus?.invalidated || !Array.isArray(voiceStatus.replyMessageIds)) return;
  for (const replyMessageId of voiceStatus.replyMessageIds) {
    const transaction = await sheets.findTransactionByMessageId(replyMessageId, null);
    if (!transaction || !(transaction.quantity > 0)) continue;

    const quantity = transaction.quantity;
    const groupPrefix = transaction.groupPrefix || '';
    try {
      if (transaction.producerPhone) {
        await sheets.updateTotalsProduction(transaction.producerPhone, -quantity, groupPrefix, 'نظام حماية التسجيل الصوتي');
      }
      if (transaction.captainPhone) {
        await sheets.updateTotalsReception(transaction.captainPhone, -quantity, groupPrefix, 'نظام حماية التسجيل الصوتي');
      }
      await sheets.updateTransactionStatus(transaction.rowIndex, {
        status: 'ملغى - تعدد تم صوتي',
        quantity: 0,
        notes: `إلغاء تلقائي: وُجد أكثر من رد «تم» على التسجيل الصوتي ${voiceStatus.voiceMessageId} | الكمية الأصلية: ${quantity} | ردود تم: ${voiceStatus.replyCount}`,
      });
      await sheets.logEdit({
        editorPhone: 'SYSTEM_VOICE_GUARD',
        editorName: 'نظام حماية التسجيل الصوتي',
        producerPhone: transaction.producerPhone || '',
        captainPhone: transaction.captainPhone || '',
        oldQuantity: quantity,
        newQuantity: 0,
        notes: `تعدد ردود تم على التسجيل ${voiceStatus.voiceMessageId}`,
      });
    } catch (error) {}
  }
}

async function invalidateVoiceEmojiTransaction(voiceEmojiStatus, reason) {
  if (!voiceEmojiStatus?.replyMessageId) return;
  const transaction = await sheets.findTransactionByMessageId(voiceEmojiStatus.replyMessageId, null);
  if (!transaction || !(transaction.quantity > 0)) return;

  const quantity = transaction.quantity;
  const groupPrefix = transaction.groupPrefix || '';
  try {
    if (transaction.producerPhone) {
      await sheets.updateTotalsProduction(transaction.producerPhone, -quantity, groupPrefix, 'نظام حماية إيموجي التسجيل الصوتي');
    }
    if (transaction.captainPhone) {
      await sheets.updateTotalsReception(transaction.captainPhone, -quantity, groupPrefix, 'نظام حماية إيموجي التسجيل الصوتي');
    }
    await sheets.updateTransactionStatus(transaction.rowIndex, {
      status: 'ملغى - إيموجي صوتي متعدد',
      quantity: 0,
      notes: `إلغاء تلقائي: ${reason} | التسجيل:${voiceEmojiStatus.voiceMessageId} | رد تم:${voiceEmojiStatus.replyMessageId} | الإيموجيات النشطة:${voiceEmojiStatus.activeEmojiCount} | الكمية الأصلية: ${quantity}`,
    });
    await sheets.logEdit({
      editorPhone: 'SYSTEM_VOICE_EMOJI_GUARD',
      editorName: 'نظام حماية إيموجي التسجيل الصوتي',
      producerPhone: transaction.producerPhone || '',
      captainPhone: transaction.captainPhone || '',
      oldQuantity: quantity,
      newQuantity: 0,
      notes: `${reason} على التسجيل ${voiceEmojiStatus.voiceMessageId}`,
    });
  } catch (error) {}
}

async function restoreVoiceEmojiTransaction(voiceEmojiStatus) {
  if (!voiceEmojiStatus?.replyMessageId || voiceEmojiStatus.activeEmojiCount !== 1 || !voiceEmojiStatus.singleEmoji) return false;
  const transaction = await sheets.findTransactionByMessageIdIncludingCancelled(voiceEmojiStatus.replyMessageId, null);
  if (!transaction || transaction.quantity > 0) return Boolean(transaction);

  const quantity = parser.extractQuantity(voiceEmojiStatus.singleEmoji);
  if (!(quantity > 0)) return false;
  const groupPrefix = transaction.groupPrefix || '';
  try {
    if (transaction.producerPhone) {
      await sheets.updateTotalsProduction(transaction.producerPhone, quantity, groupPrefix, 'استرجاع إيموجي تسجيل صوتي');
    }
    if (transaction.captainPhone) {
      await sheets.updateTotalsReception(transaction.captainPhone, quantity, groupPrefix, 'استرجاع إيموجي تسجيل صوتي');
    }
    await sheets.updateTransactionStatus(transaction.rowIndex, {
      status: 'نشط',
      quantity,
      notes: `استرجاع تلقائي: بقي إيموجي كمية واحد (${voiceEmojiStatus.singleEmoji}) على التسجيل ${voiceEmojiStatus.voiceMessageId} | msgId:${voiceEmojiStatus.replyMessageId}`,
    });
    await sheets.logEdit({
      editorPhone: 'SYSTEM_VOICE_EMOJI_GUARD',
      editorName: 'نظام حماية إيموجي التسجيل الصوتي',
      producerPhone: transaction.producerPhone || '',
      captainPhone: transaction.captainPhone || '',
      oldQuantity: 0,
      newQuantity: quantity,
      notes: `استرجاع تلقائي بعد حذف الإيموجي الإضافي على التسجيل ${voiceEmojiStatus.voiceMessageId}`,
    });
    return true;
  } catch (error) {
    return false;
  }
}

let currentQR = null;
let oneTimeBroadcast = null;

const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/qr') {
    if (!currentQR) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="background:#111;color:#0f0;font-size:20px;text-align:center;padding:40px;font-family:monospace;">
        <div style="border:2px solid #0f0;padding:20px;border-radius:10px;display:inline-block;">
          <h1>✅ البوت متصل بواتساب</h1>
          <p>tamCache: ${whatsapp.getCacheStats().tamCache} رسالة</p>
          <p>نظام التسجيل: <span style="color:#ff0;">مُفعّل (بدون قيود على الكميات)</span></p>
          <p>آخر تحديث: ${new Date().toLocaleString('ar-JO', {timeZone:'Asia/Amman'})}</p>
        </div>
        <div style="margin-top:30px;">
          ${config.sheets.weeklyReport?.enabled === true
            ? '<a href="/weekly-report" style="color:#0f0;text-decoration:none;border:1px solid #0f0;padding:10px;border-radius:5px;margin-left:10px;">📊 تقرير نهاية الأسبوع</a>'
            : '<span style="color:#888;border:1px solid #555;padding:10px;border-radius:5px;margin-left:10px;">📊 تقرير نهاية الأسبوع (موقوف مؤقتاً)</span>'}
          <a href="/groups" style="color:#0f0;text-decoration:none;border:1px solid #0f0;padding:10px;border-radius:5px;margin-left:10px;">👥 الجروبات</a>
          <a href="/logout" style="color:#f00;text-decoration:none;border:1px solid #f00;padding:10px;border-radius:5px;">⚠️ تسجيل الخروج</a>
        </div>
        <script>setTimeout(()=>location.reload(), 30000);</script>
      </body></html>`);
      return;
    }
    try {
      const qrImage = await QRCode.toDataURL(currentQR, { width: 400 });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="background:#000;text-align:center;padding:30px;">
        <h1 style="color:#fff;">📱 امسح رمز QR بواتساب</h1>
        <img src="${qrImage}" style="width:400px;height:400px;border:10px solid #fff;border-radius:10px;" />
        <p style="color:#ff0;font-size:18px;">يتغير كل 20 ثانية — حدّث الصفحة</p>
        <script>setTimeout(()=>location.reload(), 20000);</script>
      </body></html>`);
    } catch (e) {
      res.writeHead(500);
      res.end('Error');
    }
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ...whatsapp.getCacheStats() }));
  } else if (req.url === '/status') {
    const cm = whatsapp.getConnectionManager ? whatsapp.getConnectionManager() : null;
    const recoveryStats = whatsapp.getRecoveryStats ? whatsapp.getRecoveryStats() : {};
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      version: 'v5',
      connected: whatsapp.isConnected ? whatsapp.isConnected() : false,
      processedMessages: processedMessageIds.size,
      cacheStats: whatsapp.getCacheStats(),
      connectionManager: cm ? { connected: cm.isConnected() } : null,
      recovery: recoveryStats,
      telegramMonitor: telegramMonitor.getStatus(),
      groupMonitoring: whatsapp.getGroupMonitoringStatus ? whatsapp.getGroupMonitoringStatus() : {},
      incompleteMessageReviews: whatsapp.getIncompleteMessageReviews ? whatsapp.getIncompleteMessageReviews().length : 0,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }, null, 2));
  } else if (req.url === '/groups') {
    const groups = whatsapp.getDiscoveredGroups();
    let html = `<html><head><meta charset="utf-8"><style>
      body{background:#111;color:#0f0;font-family:monospace;padding:20px;direction:rtl;}
      table{border-collapse:collapse;width:100%;margin-top:20px;}
      th,td{border:1px solid #0f0;padding:10px;text-align:center;}
      th{background:#0f0;color:#000;}
      tr:hover{background:#1a3a1a;}
      h1{text-align:center;}
      .id{font-size:10px;color:#888;word-break:break-all;}
    </style></head><body>`;
    html += `<h1>📋 الجروبات المكتشفة (${groups.size})</h1>`;
    html += `<table><tr><th>#</th><th>اسم آخر مرسل</th><th>عدد الرسائل</th><th>آخر رسالة</th><th>معرف الجروب</th></tr>`;
    let i = 0;
    for (const [id, info] of groups) {
      i++;
      const lastTime = info.lastMessage ? new Date(info.lastMessage).toLocaleString('ar-JO', {timeZone:'Asia/Amman'}) : '-';
      html += `<tr><td>${i}</td><td>${info.name || '-'}</td><td>${info.messageCount}</td><td>${lastTime}</td><td class="id">${id}</td></tr>`;
    }
    html += `</table>`;
    html += `<script>setTimeout(()=>location.reload(), 15000);</script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (req.url === '/logout') {
    const authPath = path.resolve(config.whatsapp.authPath || path.join(__dirname, 'auth'));
    try {
      if (fs.existsSync(authPath)) {
        const files = fs.readdirSync(authPath);
        for (const file of files) {
          const curPath = path.join(authPath, file);
          if (fs.lstatSync(curPath).isDirectory()) {
            fs.rmSync(curPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(curPath);
          }
        }
      }
    } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><body style="background:#111;color:#ff0;font-size:20px;text-align:center;padding:40px;font-family:monospace;">
      <h1>🗑️ تم مسح الجلسة</h1>
      <p>البوت سيعيد التشغيل الآن...</p>
      <script>setTimeout(()=>location.href='/', 5000);</script>
    </body></html>`);
    setTimeout(() => process.exit(0), 1000);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('AbuSaif Bot v5');
  }
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  logger.info(`🌐 خادم يعمل على البورت ${PORT}`);
});

function setCurrentQR(qr) { currentQR = qr; }

async function processRecoveredMessage(msg) {
  const _msgId = msg?.key?.id;
  if (_msgId && isAlreadyProcessed(_msgId)) return false;
  if (_msgId) markAsProcessed(_msgId);
  try {
    await whatsapp._triggerMessageHandler(msg);
    return true;
  } catch (e) {
    return false;
  }
}
module.exports = { processRecoveredMessage };
function clearCurrentQR() { currentQR = null; }

async function resolveLidPhone(phone) {
  if (!phone) return phone;
  if (!phone.includes('@lid')) return phone;
  
  const fromMap = whatsapp.resolveLid(phone);
  if (fromMap && !fromMap.includes('@lid')) {
    const clean = fromMap.split('@')[0].replace(/\D/g, '');
    if (clean.length >= 9) return clean;
  }
  try {
    const directResolved = await whatsapp.resolveLidDirect(phone);
    if (directResolved && !directResolved.includes('@lid')) {
      const clean = directResolved.split('@')[0].replace(/\D/g, '');
      if (clean.length >= 9) return clean;
    }
  } catch (e) {}
  whatsapp.queueLidForResolve(phone);
  return phone;
}

function normalizePhoneForComparison(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : digits;
}

function isRecordablePhone(phone) {
  const raw = String(phone || '');
  const digits = raw.replace(/\D/g, '');
  return Boolean(raw) && !raw.includes('@lid') && digits.length >= 9 && digits.length <= 12;
}

function getSafePartyName(phone) {
  if (!isRecordablePhone(phone)) return 'مجهول';
  return sheets.getRegisteredName(phone) || 'مجهول';
}

async function queueUnknownParty(phone, role) {
  if (!isRecordablePhone(phone)) return { recordable: false, registered: false };
  const registeredName = sheets.getRegisteredName(phone);
  if (!registeredName) {
    const normalizedPhone = normalizePhoneForComparison(phone);
    await sheets.logUnregisteredNumber(normalizedPhone, 'مجهول');
  }
  return { recordable: true, registered: Boolean(registeredName) };
}

function getCachedMessageContext(message) {
  const payload = message?.message || {};
  return payload.extendedTextMessage?.contextInfo ||
    payload.imageMessage?.contextInfo ||
    payload.videoMessage?.contextInfo ||
    payload.audioMessage?.contextInfo ||
    payload.documentMessage?.contextInfo || null;
}

function getQuotedContextText(contextInfo) {
  if (!contextInfo?.quotedMessage) return '';
  return whatsapp.extractText({ message: contextInfo.quotedMessage }) || '';
}

function formatDeliveryOrderDetails(details) {
  if (!details?.isComplete) return '';
  const payment = details.payment === null || details.payment === undefined ? 'غير مذكور' : details.payment;
  return `من: ${details.from} | إلى: ${details.to} | الدفع: ${payment} | التوصيل: ${details.delivery}`;
}

function buildOrderDetail({ result, msg, quotedMsgId, groupPrefix, producerPhone, captainPhone, reactorPhone, identityIncomplete = false }) {
  const targetMessage = quotedMsgId ? whatsapp.getCachedMessage(quotedMsgId) : null;
  const targetContext = getCachedMessageContext(targetMessage);
  const persistedContext = quotedMsgId ? whatsapp.getOrderContextByReplyId(quotedMsgId) : null;
  const orderMessageId = persistedContext?.orderMessageId || targetContext?.stanzaId || quotedMsgId || '';
  const originalOrderMessage = orderMessageId ? whatsapp.getCachedMessage(orderMessageId) : targetMessage;
  const embeddedOrderText = getQuotedContextText(targetContext);
  const cachedOrderText = whatsapp.extractText(originalOrderMessage) || '';
  const cachedTamText = whatsapp.extractText(targetMessage) || '';
  const orderText = persistedContext?.orderText || cachedOrderText || embeddedOrderText || result.quotedText || 'غير متوفر';
  const deliveryOrderDetails = persistedContext?.deliveryOrderDetails || parser.extractDeliveryOrderDetails(orderText);
  const orderClassification = persistedContext?.orderClassification || result.orderClassification || classifyOriginalOrder({ text: orderText }).classification;
  const confidenceLevel = persistedContext?.confidenceLevel || result.confidenceLevel || classifyOriginalOrder({ text: orderText }).confidenceLevel || 'ambiguous';

  const producerName = getSafePartyName(producerPhone);
  const captainName = getSafePartyName(captainPhone);
  const reactorName = sheets.getRegisteredName(reactorPhone) || whatsapp.getPushName(msg) || '';
  const samePerson = normalizePhoneForComparison(producerPhone) &&
    normalizePhoneForComparison(producerPhone) === normalizePhoneForComparison(captainPhone);

  const needsReview = samePerson || identityIncomplete || confidenceLevel === 'ambiguous';
  const reviewNotes = [
    samePerson ? 'تحذير: رقم المنتج والكابتن متطابقان' : '',
    identityIncomplete ? 'هوية أحد الأطراف غير مكتملة' : '',
    confidenceLevel === 'ambiguous' ? 'طلب مبهم' : '',
    `مستوى الثقة: ${confidenceLevel}`,
    formatDeliveryOrderDetails(deliveryOrderDetails),
  ].filter(Boolean).join(' | ');

  return {
    transactionId: result.transactionId,
    timestamp: result.timestamp,
    groupPrefix,
    producerName,
    producerPhone,
    captainName,
    captainPhone,
    reactorName,
    reactorPhone,
    quantity: result.quantity,
    orderText,
    tamText: persistedContext?.tamText || (targetContext ? (cachedTamText || result.quotedText || 'غير متوفر') : ''),
    emoji: result.text || '',
    status: needsReview ? 'يحتاج مراجعة' : 'نشط',
    tamMessageId: (targetContext || persistedContext) ? quotedMsgId : '',
    orderMessageId,
    source: (targetContext || persistedContext) ? 'تفاعل على رسالة تم' : 'تفاعل على الطلب',
    orderClassification,
    confidenceLevel,
    notes: reviewNotes,
  };
}

async function applyPendingDirectOrderEmoji({ pending, replyMessageId, orderMessageId, producerPhone, captainPhone, groupPrefix, msg, timestamp }) {
  if (!pending || !replyMessageId || !producerPhone || !captainPhone) return false;
  if (pending.appliedReplyMessageId === replyMessageId) return false;

  const quantity = Number(pending.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return false;
  const orderContext = whatsapp.getOrderContextByReplyId(replyMessageId) || {};
  const orderConfidence = orderContext.confidenceLevel || classifyOriginalOrder({ text: orderContext.orderText || '' }).confidenceLevel || 'ambiguous';
  const syntheticResult = {
    transactionId: crypto.randomUUID(),
    timestamp: timestamp || new Date().toISOString(),
    quantity,
    text: pending.emoji,
    quotedText: '',
    confidenceLevel: orderConfidence,
  };
  const existingTransaction = await sheets.findTransactionByMessageId(replyMessageId, producerPhone);
  if (existingTransaction) {
    if (existingTransaction.quantity !== quantity) {
      await sheets.processEdit({
        messageId: replyMessageId,
        editorPhone: pending.senderPhone,
        editorName: sheets.getRegisteredName(pending.senderPhone) || '',
        newQuantity: quantity,
        groupPrefix,
        newEmoji: pending.emoji,
        reason: 'استبدال إيموجي كمية مباشر',
      });
    }
    whatsapp.markDirectOrderEmojiApplied(orderMessageId, replyMessageId);
    return true;
  }

  const producerParty = await queueUnknownParty(producerPhone, 'المنتج');
  const captainParty = await queueUnknownParty(captainPhone, 'الكابتن');
  const identityIncomplete = !producerParty.recordable || !captainParty.recordable;
  if (producerParty.recordable) await sheets.updateTotalsProduction(producerPhone, quantity, groupPrefix, getSafePartyName(producerPhone));
  if (captainParty.recordable) await sheets.updateTotalsReception(captainPhone, quantity, groupPrefix, getSafePartyName(captainPhone));

  await sheets.recordTransaction({
    transactionId: syntheticResult.transactionId,
    timestamp: syntheticResult.timestamp,
    producerPhone,
    captainPhone,
    quantity,
    type: 'انتاج',
    emoji: pending.emoji,
    groupPrefix,
    messageId: replyMessageId,
    status: identityIncomplete ? '⏳ هوية غير مكتملة' : 'نشط',
    notes: 'direct-order-reaction-last-emoji',
  });
  const orderDetail = buildOrderDetail({
    result: syntheticResult,
    msg,
    quotedMsgId: replyMessageId,
    groupPrefix,
    producerPhone,
    captainPhone,
    reactorPhone: pending.senderPhone,
    identityIncomplete,
  });
  await sheets.upsertOrderDetails(orderDetail);
  whatsapp.markDirectOrderEmojiApplied(orderMessageId, replyMessageId);
  return true;
}

// ====================================================
// بدء التشغيل
// ====================================================
async function start() {
  logger.info('═══════════════════════════════════════');
  logger.info('   🚀 نظام AbuSaif v5 — Self-Healing + Recovery');
  logger.info('═══════════════════════════════════════');

  const volumePath = path.resolve(config.volumePath || path.join(__dirname, 'volume'));
  const authSessionPath = path.resolve(config.whatsapp.authPath || path.join(__dirname, 'auth'));
  const logsPath = path.resolve(config.logging.logsPath || path.join(__dirname, 'logs'));

  if (!fs.existsSync(volumePath)) fs.mkdirSync(volumePath, { recursive: true });
  if (!fs.existsSync(authSessionPath)) fs.mkdirSync(authSessionPath, { recursive: true });
  if (!fs.existsSync(logsPath)) fs.mkdirSync(logsPath, { recursive: true });

  logger.info(`💾 VOLUME_PATH: ${volumePath}`);
  logger.info(`🔑 AUTH_PATH: ${authSessionPath}`);

  try {
    await sheets.initialize();
    logger.info('✅ Google Sheets متصل');
    await sheets.loadSettings();
    logger.info('✅ الإعدادات محمّلة');
    await sheets.ensureOrderDetailsSheet();
    await sheets.ensureOperationReviewsSheet();
    await sheets.backfillOperationReviewsFromOrderDetails();
    sheets.createDashboardSheet().catch(() => {});
  } catch (error) {
    logger.warn('⚠️ Google Sheets غير متاح', { error: error.message });
  }

  const telegramVerification = await telegramMonitor.verifyBot();
  if (telegramVerification.ok) {
    logger.info(`✅ بوت تيليجرام للمراقبة جاهز: @${telegramVerification.username}`);
  }

  whatsapp.setMessageHandler(async (msg, sock) => {
    if (whatsapp.isReaction(msg)) {
      const result = await parser.processMessage(msg, sock);
      if (!result) return;

      const producerPhone = result.phone;
      const quantity = result.quantity; // بدون قيود: سيتم تسجيل الكمية مهما بلغت (حتى 10 أو أكثر)
      let quotedMsgId = result.quotedMessageId || result.targetMessageId;
      const remoteJid = msg.key.remoteJid;
      let orderOwnerPhone = result.orderOwnerPhone || result.quotedPhone || null;
      let directOrderMessageId = '';
      let directOrderMode = false;

      const _captainFromTamEarly = quotedMsgId ? whatsapp.getCaptainByMessageId(quotedMsgId) : null;
      const _captainFromSheetEarly = !_captainFromTamEarly && quotedMsgId ? await sheets.getCaptainFromTamSheet(quotedMsgId) : null;
      const _directTargetMsg = quotedMsgId ? whatsapp.getCachedMessage(quotedMsgId) : null;
      const _directTargetText = whatsapp.extractText(_directTargetMsg) || result.quotedText || '';
      const _directClassification = (!_captainFromTamEarly && !_captainFromSheetEarly && quotedMsgId)
        ? classifyOriginalOrder({ text: _directTargetText, messageType: whatsapp.getMessageType(_directTargetMsg) })
        : null;
      const _reactionCanChangeExistingQuantity = ['accept', 'remove', 'unknown_emoji'].includes(result.type);
      const _isQualifiedDirectOrder = _reactionCanChangeExistingQuantity &&
        _directClassification?.confidenceLevel !== 'blocked' &&
        _directClassification?.classification !== 'invalid';
      const _existingReplyForDirectOrder = _isQualifiedDirectOrder ? whatsapp.getLatestReplyForOrder(quotedMsgId) : null;
      
      const _targetValidation = validateQuantityReactionTarget({
        captainFromTam: _captainFromTamEarly,
        captainFromSheet: _captainFromSheetEarly,
        isQualifiedOrder: _isQualifiedDirectOrder,
        hasCaptainReply: Boolean(_existingReplyForDirectOrder),
      });
      if (!_targetValidation.allowed) return;

      if (_isQualifiedDirectOrder) {
        const authorization = authorizeQuantityReaction({
          reactorPhone: producerPhone,
          orderOwnerPhone,
          isSupervisor: await sheets.isSupervisor(producerPhone),
        });
        if (!authorization.allowed) return;
        directOrderMessageId = quotedMsgId;
        directOrderMode = true;
        if (result.type === 'accept') {
          whatsapp.setDirectOrderEmoji(directOrderMessageId, producerPhone, result.text || result.reactionText || '', quantity);
        } else {
          whatsapp.clearDirectOrderEmoji(directOrderMessageId);
        }
        messageLog.markOrderQuantity({
          orderMessageId: directOrderMessageId,
          emoji: result.type === 'accept' ? (result.text || result.reactionText || '') : '',
          quantity: result.type === 'accept' ? quantity : 0,
        });
        if (!_existingReplyForDirectOrder) return;
        quotedMsgId = _existingReplyForDirectOrder.replyMessageId;
        orderOwnerPhone = _existingReplyForDirectOrder.producer || orderOwnerPhone;
      }

      const targetGroups = config.whatsapp.targetGroups || [];
      const groupInfo = targetGroups.find(g => g.id === remoteJid);
      const groupPrefix = groupInfo ? groupInfo.prefix : '';

      const captainFromTam = quotedMsgId ? whatsapp.getCaptainByMessageId(quotedMsgId) : null;
      const producerFromOrder = quotedMsgId ? whatsapp.getOrderByReplyId(quotedMsgId) : null;

      let captainPhone, realProducerPhone;

      if (captainFromTam) {
        captainPhone = captainFromTam;
        realProducerPhone = producerFromOrder || orderOwnerPhone;
      } else {
        const captainFromSheet = quotedMsgId ? await sheets.getCaptainFromTamSheet(quotedMsgId) : null;
        if (captainFromSheet) {
          captainPhone = captainFromSheet;
          realProducerPhone = producerFromOrder || orderOwnerPhone;
        } else {
          captainPhone = producerPhone;
          realProducerPhone = orderOwnerPhone;
        }
      }

      if (result.type === 'accept') {
        const existingTransaction = await sheets.findTransactionByMessageId(quotedMsgId, realProducerPhone || producerPhone);
        if (existingTransaction) {
          if (existingTransaction.quantity !== quantity) {
            await sheets.processEdit({
              messageId: quotedMsgId,
              editorPhone: producerPhone,
              editorName: sheets.getRegisteredName(producerPhone) || '',
              newQuantity: quantity,
              groupPrefix,
              newEmoji: result.reactionText || result.text || '',
              reason: 'استبدال إيموجي كمية',
            });
          }
          if (directOrderMessageId) whatsapp.markDirectOrderEmojiApplied(directOrderMessageId, quotedMsgId);
          return;
        }

        let finalProducerPhone = realProducerPhone || producerPhone;
        if (finalProducerPhone && finalProducerPhone.includes('@lid')) {
          finalProducerPhone = await resolveLidPhone(finalProducerPhone);
        }
        let resolvedCaptainForSheet = captainPhone;
        if (resolvedCaptainForSheet && resolvedCaptainForSheet.includes('@lid')) {
          resolvedCaptainForSheet = await resolveLidPhone(resolvedCaptainForSheet);
        }

        const producerParty = await queueUnknownParty(finalProducerPhone, 'المنتج');
        const captainParty = await queueUnknownParty(resolvedCaptainForSheet, 'الكابتن');
        const identityIncomplete = !producerParty.recordable || !captainParty.recordable;

        if (producerParty.recordable) {
          await sheets.updateTotalsProduction(finalProducerPhone, quantity, groupPrefix, getSafePartyName(finalProducerPhone));
        }
        if (resolvedCaptainForSheet && captainParty.recordable) {
          await sheets.updateTotalsReception(resolvedCaptainForSheet, quantity, groupPrefix, getSafePartyName(resolvedCaptainForSheet));
        }

        await sheets.recordTransaction({
          transactionId: result.transactionId,
          timestamp: result.timestamp,
          producerPhone: finalProducerPhone,
          captainPhone: resolvedCaptainForSheet || '',
          quantity, // تسجيل الكمية بالكامل بدون سقف (حتى 10 أو أكثر)
          type: 'انتاج',
          emoji: result.text,
          groupPrefix,
          messageId: quotedMsgId || '',
          status: identityIncomplete ? '⏳ هوية غير مكتملة' : 'نشط',
          notes: 'reaction'
        });

        const orderDetail = buildOrderDetail({
          result,
          msg,
          quotedMsgId,
          groupPrefix,
          producerPhone: finalProducerPhone,
          captainPhone: resolvedCaptainForSheet || '',
          reactorPhone: producerPhone,
          identityIncomplete,
        });
        await sheets.upsertOrderDetails(orderDetail);
        if (directOrderMessageId) whatsapp.markDirectOrderEmojiApplied(directOrderMessageId, quotedMsgId);
      } else if (result.type === 'cancel' && quotedMsgId) {
        const existingTx = await sheets.findTransactionByMessageId(quotedMsgId, null);
        if (existingTx) {
          const cancelQuantity = existingTx.quantity;
          await sheets.updateTotalsProduction(existingTx.producerPhone, -cancelQuantity, groupPrefix, getSafePartyName(existingTx.producerPhone));
          if (existingTx.captainPhone) {
            await sheets.updateTotalsReception(existingTx.captainPhone, -cancelQuantity, groupPrefix, getSafePartyName(existingTx.captainPhone));
          }
          await sheets.updateTransactionStatus(existingTx.rowIndex, {
            status: 'ملغى',
            quantity: 0,
            notes: `إلغاء بواسطة ${producerPhone} | الكمية: ${cancelQuantity}`
          });
        }
      }
      return;
    }

    const result = await parser.processMessage(msg, sock);
    if (!result) return;
    if (result.type === 'order') return;

    if (result.type === 'accept' && result.quantity > 0) {
      let captainPhone = result.phone;
      const tamMessageId = result.messageId;
      if (captainPhone && captainPhone.includes('@lid')) {
        captainPhone = await resolveLidPhone(captainPhone);
      }
      if (captainPhone && tamMessageId) {
        whatsapp.setCaptainForMessage(tamMessageId, captainPhone);
        sheets.saveTamToSheet(tamMessageId, captainPhone).catch(() => {});
      }
    }
  });

  whatsapp.onQRUpdate(setCurrentQR, clearCurrentQR);
  await whatsapp.connect();

  oneTimeBroadcast = createOneTimeBroadcastProcessor({
    volumePath: config.volumePath || path.join(__dirname, 'volume'),
    targetGroupId: (config.whatsapp.targetGroups || []).find(group => group.prefix === 'السيف')?.id || '',
    getSocket: whatsapp.getSocket,
    isConnected: whatsapp.isConnected,
    logger,
  });
}

start().catch((error) => {
  logger.error('فشل التشغيل', { error: error.message });
  process.exit(1);
});
