/**
 * whatsapp.js - الاتصال بواتساب v4
 * ================================
 * إصلاحات v4:
 * - keepAlive: إرسال ping كل 25 ثانية لمنع الانقطاع
 * - إعادة اتصال ذكية مع backoff
 * - حل مشكلة LID: استخدام groupMetadata لربط LID بالأرقام الحقيقية
 * - tamCache لا يُمسح أبداً
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

// ====================================================
// الكاشات (تبقى في الذاكرة طوال عمر البوت)
// ====================================================

const messageCache = new Map();
const tamCache = new Map();

// كاش لربط LID بالأرقام الحقيقية
// { lid@lid: phone@s.whatsapp.net }
const lidToPhoneMap = new Map();

// كاش الجروبات المكتشفة { groupId: { name, messageCount, lastMessage } }
const discoveredGroups = new Map();

let sock = null;
let messageHandler = null;
let reconnectAttempts = 0;
let isConnecting = false;
let qrUpdateCallback = null;
let qrClearCallback = null;
let keepAliveInterval = null;

/**
 * تعيين معالج الرسائل
 */
function setMessageHandler(handler) {
  messageHandler = handler;
}

/**
 * بدء الاتصال بواتساب
 */
async function connect() {
  if (isConnecting) {
    logger.debug('الاتصال جارٍ بالفعل');
    return;
  }
  isConnecting = true;

  try {
    const fs = require('fs');
    const authPath = path.resolve(config.whatsapp.authPath);
    
    // ضمان وجود المجلد قبل البدء
    if (!fs.existsSync(authPath)) {
      fs.mkdirSync(authPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    let version;
    try {
      // تعيين timeout لجلب الإصدار
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const result = await fetchLatestBaileysVersion({ signal: controller.signal });
      clearTimeout(timeoutId);
      version = result.version;
    } catch (e) {
      logger.debug('فشل جلب إصدار Baileys، استخدام افتراضي', { error: e.message });
      version = [2, 3000, 1015901307];
    }

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: require('pino')({ level: 'silent' }),
      browser: ['AbuSaif-Bot', 'Safari', '17.0'],
      syncFullHistory: false,
      retryRequestDelayMs: 500,
      // مهم: تفعيل keepAlive لمنع الانقطاع
      keepAliveIntervalMs: 25000,
      // مهم: عدم إرسال presence لتقليل الحمل
      markOnlineOnConnect: false,
      getMessage: async (key) => {
        const cached = messageCache.get(key.id);
        return cached?.message || undefined;
      },
    });

    // === أحداث الاتصال ===
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n========================================');
        console.log('  📱 امسح رمز QR بواتساب');
        console.log('========================================');
        qrcode.generate(qr, { small: true });
        console.log('========================================\n');
        if (qrUpdateCallback) qrUpdateCallback(qr);
      }

      if (connection === 'close') {
        isConnecting = false;
        stopKeepAlive();

        const err = new Boom(lastDisconnect?.error);
        const statusCode = err?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn('انقطع الاتصال', { statusCode, shouldReconnect, attempts: reconnectAttempts });

        if (!shouldReconnect) {
          logger.error('تم تسجيل الخروج! احذف مجلد auth وأعد المسح.');
          return;
        }

        reconnectAttempts++;

        // تأخير ذكي
        let delay;
        if (statusCode === 440) {
          // conflict: ننتظر 45-90 ثانية
          delay = 45000 + Math.random() * 45000;
        } else if (statusCode === 408 || statusCode === 503) {
          // timeout/unavailable: ننتظر 10-20 ثانية
          delay = 10000 + Math.random() * 10000;
        } else if (reconnectAttempts <= 3) {
          delay = 5000;
        } else if (reconnectAttempts <= 10) {
          delay = 15000;
        } else {
          delay = 60000;
        }

        logger.info(`🔄 إعادة الاتصال بعد ${Math.round(delay/1000)}ث (محاولة ${reconnectAttempts})`);
        setTimeout(connect, delay);
      }

      if (connection === 'open') {
        reconnectAttempts = 0;
        isConnecting = false;
        logger.info('✅ تم الاتصال بواتساب بنجاح!');
        logger.info(`📦 tamCache: ${tamCache.size} | msgCache: ${messageCache.size}`);
        if (qrClearCallback) qrClearCallback();

  // بدء keepAlive
  startKeepAlive();

  // تحميل بيانات الجروب لربط LID بالأرقام
  loadGroupParticipants();
  
  // تحديث البيانات كل ساعة لضمان شمولية الأعضاء الجدد
  setInterval(loadGroupParticipants, 60 * 60 * 1000);
}
    });

    sock.ev.on('creds.update', saveCreds);

    // === استقبال الرسائل ===
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;

        // تتبع الجروبات المكتشفة
        const remoteJid = msg.key.remoteJid || '';
        if (remoteJid.endsWith('@g.us')) {
          const existing = discoveredGroups.get(remoteJid) || { name: '', messageCount: 0, lastMessage: '' };
          existing.messageCount++;
          existing.lastMessage = new Date().toISOString();
          if (msg.pushName) existing.name = msg.pushName;
          discoveredGroups.set(remoteJid, existing);
        }

        // فلتر الجروب: قبول الرسائل من الجروبات المستهدفة فقط
        const targetGroups = config.whatsapp.targetGroups || [];
        const isTarget = targetGroups.some(g => g.id === remoteJid);
        if (!isTarget) continue;
        if (!remoteJid.endsWith('@g.us')) continue;

        // تخزين في الكاش (ليس التفاعلات)
        if (msg.key.id && !msg.message.reactionMessage) {
          messageCache.set(msg.key.id, msg);
          if (messageCache.size > 5000) {
            const firstKey = messageCache.keys().next().value;
            messageCache.delete(firstKey);
          }
        }

        // سجل تشخيصي مختصر
        const senderJid = getSenderJid(msg);
        logger.info('📨 رسالة', {
          id: msg.key.id?.substring(0, 8),
          from: senderJid?.split('@')[0] || 'N/A',
          type: msg.message.reactionMessage ? 'reaction' : Object.keys(msg.message)[0],
          name: msg.pushName || '',
        });

        if (messageHandler) {
          try {
            await messageHandler(msg, sock);
          } catch (error) {
            logger.error('خطأ في المعالجة', {
              error: error.message,
              msgId: msg.key.id,
            });
          }
        }
      }
    });

    return sock;
  } catch (error) {
    isConnecting = false;
    logger.error('خطأ في الاتصال', { error: error.message });
    reconnectAttempts++;
    const delay = Math.min(reconnectAttempts * 10000, 60000);
    setTimeout(connect, delay);
  }
}

// ====================================================
// KeepAlive — يمنع الانقطاع
// ====================================================

function startKeepAlive() {
  stopKeepAlive();
  keepAliveInterval = setInterval(() => {
    if (sock && sock.ws?.readyState === 1) {
      // Baileys يرسل keepAlive تلقائياً مع keepAliveIntervalMs
      // لكن نضيف فحص إضافي
      logger.debug('💓 keepAlive OK');
    } else {
      logger.warn('💔 keepAlive: الاتصال مفقود، إعادة...');
      stopKeepAlive();
      if (!isConnecting) {
        setTimeout(connect, 3000);
      }
    }
  }, 30000);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// ====================================================
// تحميل بيانات الجروب (لربط LID بالأرقام الحقيقية)
// ====================================================

async function loadGroupParticipants() {
  try {
    const targetGroups = config.whatsapp.targetGroups || [];
    if (targetGroups.length === 0) return;

    let totalParticipants = 0;
    for (const group of targetGroups) {
      try {
        const metadata = await sock.groupMetadata(group.id);
        if (metadata && metadata.participants) {
          for (const p of metadata.participants) {
            if (p.lid && p.id) {
              lidToPhoneMap.set(p.lid, p.id);
            }
          }
          totalParticipants += metadata.participants.length;
          logger.info(`📋 تم تحميل ${metadata.participants.length} مشارك من جروب: ${group.name}`);
        }
      } catch (e) {
        logger.warn(`فشل تحميل مشاركي جروب ${group.name}`, { error: e.message });
      }
    }
    logger.info(`🔗 الإجمالي: ${lidToPhoneMap.size} ربط LID→Phone لـ ${totalParticipants} مشارك`);
  } catch (error) {
    logger.warn('فشل تحميل بيانات الجروبات', { error: error.message });
  }
}

// ====================================================
// استخراج الأرقام
// ====================================================

/**
 * استخراج النص من الرسالة
 */
function extractText(msg) {
  if (!msg || !msg.message) return null;
  if (msg.message.conversation) return msg.message.conversation;
  if (msg.message.extendedTextMessage?.text) return msg.message.extendedTextMessage.text;
  if (msg.message.imageMessage?.caption) return msg.message.imageMessage.caption;
  if (msg.message.reactionMessage?.text) return msg.message.reactionMessage.text;
  return null;
}

/**
 * استخراج نوع الرسالة
 */
function getMessageType(msg) {
  if (!msg?.message) return 'other';
  const m = msg.message;
  if (m.conversation || m.extendedTextMessage) return 'text';
  if (m.audioMessage) return 'audio';
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.stickerMessage) return 'sticker';
  if (m.documentMessage) return 'document';
  return 'other';
}

/**
 * التحقق مما إذا كانت الرسالة تفاعلاً
 */
function isReaction(msg) {
  return !!msg?.message?.reactionMessage;
}

/**
 * استخراج معرف الرسالة الأصلية التي تفاعل معها
 */
function getReactionTargetId(msg) {
  return msg?.message?.reactionMessage?.key?.id || null;
}

/**
 * استخراج رقم هاتف المرسل (يحل مشكلة LID)
 */
function getSenderJid(msg) {
  const key = msg.key || {};

  // أولاً: الأرقام الحقيقية المباشرة
  if (key.senderPn) return key.senderPn;
  if (key.participantPn) return key.participantPn;

  // ثانياً: participant إذا كان رقم حقيقي
  if (key.participant && key.participant.includes('@s.whatsapp.net')) return key.participant;

  // ثالثاً: حل LID من الكاش
  if (key.participant && key.participant.includes('@lid')) {
    const resolved = lidToPhoneMap.get(key.participant);
    if (resolved) return resolved;
    
    // محاولة إضافية: البحث في الكاش إذا كان الرقم مخزناً بطريقة أخرى
    for (const [lid, phone] of lidToPhoneMap.entries()) {
      if (lid.split(':')[0] === key.participant.split(':')[0]) return phone;
    }
  }

  // رابعاً: participant حتى لو LID (آخر محاولة)
  if (key.participant && !key.participant.endsWith('@g.us')) return key.participant;
  if (key.remoteJid && !key.remoteJid.endsWith('@g.us')) return key.remoteJid;

  return null;
}

/**
 * عرض قائمة الجروبات
 */
async function listGroups() {
  try {
    const groups = await sock.groupFetchAllParticipating();
    const groupList = Object.values(groups);
    logger.info(`═══ الجروبات (${groupList.length}) ═══`);
    groupList.slice(0, 10).forEach((group, i) => {
      logger.info(`  ${i + 1}. ${group.subject} → ${group.id}`);
    });
  } catch (error) {
    logger.warn('لم يتم جلب الجروبات', { error: error.message });
  }
}

// ====================================================
// كاش رسائل "تم"
// ====================================================

function setCaptainForMessage(messageId, captainPhone) {
  if (!messageId || !captainPhone) return;
  tamCache.set(messageId, captainPhone);
  // لا نحذف من tamCache أبداً — الحجم لن يتجاوز بضعة آلاف يومياً
  logger.debug('💾 tamCache', { msgId: messageId.substring(0, 8), captain: captainPhone, size: tamCache.size });
}

function getCaptainByMessageId(messageId) {
  return tamCache.get(messageId) || null;
}

function getCachedMessage(messageId) {
  return messageCache.get(messageId) || null;
}

function getCacheStats() {
  return { messageCache: messageCache.size, tamCache: tamCache.size, lidMap: lidToPhoneMap.size };
}

function getSocket() {
  return sock;
}

/**
 * تعيين callback لتحديث QR
 */
function onQRUpdate(updateFn, clearFn) {
  qrUpdateCallback = updateFn;
  qrClearCallback = clearFn;
}

function getDiscoveredGroups() {
  return discoveredGroups;
}

module.exports = {
  connect,
  setMessageHandler,
  setCaptainForMessage,
  getCaptainByMessageId,
  getCacheStats,
  getSocket,
  extractText,
  getMessageType,
  isReaction,
  getReactionTargetId,
  getSenderJid,
  getCachedMessage,
  onQRUpdate,
  getDiscoveredGroups,
};
