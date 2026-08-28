/**
 * server.js - نقطة تشغيل النظام v5 (Self-Healing + Recovery)
 * ================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const config = require('./config');

// تصحيح المسارات تلقائياً لتجنب مشكلة EACCES على Render
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

// تنظيف السجلات عند بدء التشغيل
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
        if (stat.size / (1024 * 1024) > 10) {
          fs.writeFileSync(filePath, '');
          freed += stat.size;
        }
      } catch (e) {}
    }
  } catch (e) {}
})();

const processedMessageIds = new Set();
const PROCESSED_MSG_MAX = 10000;
const pendingEmojiReplace = new Map();
const EMOJI_REPLACEMENT_GRACE_MS = 1200;

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
        </div>
      </body></html>`);
      return;
    }
    try {
      const qrImage = await QRCode.toDataURL(currentQR, { width: 400 });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="background:#000;text-align:center;padding:30px;">
        <h1 style="color:#fff;">📱 امسح رمز QR بواتساب</h1>
        <img src="${qrImage}" style="width:400px;height:400px;border:10px solid #fff;border-radius:10px;" />
      </body></html>`);
    } catch (e) {
      res.writeHead(500);
      res.end('Error');
    }
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ...whatsapp.getCacheStats() }));
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

function getSafePartyName(phone) {
  const raw = String(phone || '');
  if (!raw || raw.includes('@lid') || raw.replace(/\D/g, '').length < 9) return 'مجهول';
  return sheets.getRegisteredName(phone) || 'مجهول';
}

async function queueUnknownParty(phone) {
  const raw = String(phone || '');
  if (!raw || raw.includes('@lid') || raw.replace(/\D/g, '').length < 9) return { recordable: false };
  const registeredName = sheets.getRegisteredName(phone);
  if (!registeredName) {
    await sheets.logUnregisteredNumber(raw.replace(/\D/g, '').slice(-9), 'مجهول');
  }
  return { recordable: true };
}

function buildOrderDetail({ result, msg, quotedMsgId, groupPrefix, producerPhone, captainPhone, reactorPhone, identityIncomplete = false }) {
  return {
    transactionId: result.transactionId,
    timestamp: result.timestamp,
    groupPrefix,
    producerName: getSafePartyName(producerPhone),
    producerPhone,
    captainName: getSafePartyName(captainPhone),
    captainPhone,
    reactorName: sheets.getRegisteredName(reactorPhone) || whatsapp.getPushName(msg) || '',
    reactorPhone,
    quantity: result.quantity,
    orderText: result.quotedText || 'غير متوفر',
    emoji: result.text || '',
    status: identityIncomplete ? 'يحتاج مراجعة' : 'نشط',
  };
}

async function start() {
  logger.info('   🚀 نظام AbuSaif v5 — Self-Healing + Recovery');

  const volumePath = path.resolve(config.volumePath || path.join(__dirname, 'volume'));
  const authSessionPath = path.resolve(config.whatsapp.authPath || path.join(__dirname, 'auth'));
  const logsPath = path.resolve(config.logging.logsPath || path.join(__dirname, 'logs'));

  if (!fs.existsSync(volumePath)) fs.mkdirSync(volumePath, { recursive: true });
  if (!fs.existsSync(authSessionPath)) fs.mkdirSync(authSessionPath, { recursive: true });
  if (!fs.existsSync(logsPath)) fs.mkdirSync(logsPath, { recursive: true });

  try {
    await sheets.initialize();
    await sheets.loadSettings();
    await sheets.ensureOrderDetailsSheet();
    await sheets.ensureOperationReviewsSheet();
  } catch (error) {}

  whatsapp.setMessageHandler(async (msg, sock) => {
    if (whatsapp.isReaction(msg)) {
      const result = await parser.processMessage(msg, sock);
      if (!result) return;

      const producerPhone = result.phone;
      const quantity = result.quantity; // بدون قيود: يسجل الكمية مهما بلغت (حتى 10 أو أكثر)
      let quotedMsgId = result.quotedMessageId || result.targetMessageId;
      const remoteJid = msg.key.remoteJid;

      const targetGroups = config.whatsapp.targetGroups || [];
      const groupInfo = targetGroups.find(g => g.id === remoteJid);
      const groupPrefix = groupInfo ? groupInfo.prefix : '';

      const captainFromTam = quotedMsgId ? whatsapp.getCaptainByMessageId(quotedMsgId) : null;
      const producerFromOrder = quotedMsgId ? whatsapp.getOrderByReplyId(quotedMsgId) : null;

      let captainPhone = captainFromTam || producerPhone;
      let realProducerPhone = producerFromOrder || result.orderOwnerPhone;

      if (result.type === 'accept') {
        let finalProducerPhone = realProducerPhone || producerPhone;
        if (finalProducerPhone && finalProducerPhone.includes('@lid')) {
          finalProducerPhone = await resolveLidPhone(finalProducerPhone);
        }
        let resolvedCaptainForSheet = captainPhone;
        if (resolvedCaptainForSheet && resolvedCaptainForSheet.includes('@lid')) {
          resolvedCaptainForSheet = await resolveLidPhone(resolvedCaptainForSheet);
        }

        const producerParty = await queueUnknownParty(finalProducerPhone);
        const captainParty = await queueUnknownParty(resolvedCaptainForSheet);
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
          quantity, // تسجيل الكمية بالكامل بدون سقف
          type: 'انتاج',
          emoji: result.text,
          groupPrefix,
          messageId: quotedMsgId || '',
          status: identityIncomplete ? '⏳ هوية غير مكتملة' : 'نشط',
          notes: 'reaction'
        });

        const orderDetail = buildOrderDetail({
          result, msg, quotedMsgId, groupPrefix,
          producerPhone: finalProducerPhone,
          captainPhone: resolvedCaptainForSheet || '',
          reactorPhone: producerPhone,
          identityIncomplete,
        });
        await sheets.upsertOrderDetails(orderDetail);
      }
      return;
    }
  });

  whatsapp.onQRUpdate(setCurrentQR, clearCurrentQR);
  await whatsapp.connect();
}

start().catch((error) => {
  process.exit(1);
});
