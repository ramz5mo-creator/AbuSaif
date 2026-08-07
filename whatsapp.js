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
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

// ====================================================
// الكاشات (تبقى في الذاكرة طوال عمر البوت)
// ====================================================

const messageCache = new Map();
const tamCache = new Map();
// كاش لربط id رسالة الرد (تم) برقم صاحب الطلب الأصلي
// { replyMsgId: producerPhone }
const orderCache = new Map();

// كاش لربط LID بالأرقام الحقيقية
// { lid@lid: phone@s.whatsapp.net }
const lidToPhoneMap = new Map();

// مسار حفظ lidMap على القرص
const LID_MAP_PATH = path.resolve(config.whatsapp.authPath, '..', 'lid-map.json');

// مرجع لدالة sheets.loadRegisteredUsers (lazy لتجنب circular dependency)
let sheetsModule = null;
function getSheets() {
  if (!sheetsModule) {
    try { sheetsModule = require('./sheets'); } catch (e) { /* تجاهل */ }
  }
  return sheetsModule;
}

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
    const authPath = path.resolve(config.whatsapp.authPath);
    
    // ضمان وجود المجلد قبل البدء
    if (!fs.existsSync(authPath)) {
      fs.mkdirSync(authPath, { recursive: true });
    }

    // تحميل lidMap من القرص عند بدء التشغيل
    loadLidMap();

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
  
  // تحميل أسماء المسجلين لحل LID عبر pushName
  const sheets = getSheets();
  if (sheets && sheets.loadRegisteredUsers) {
    sheets.loadRegisteredUsers().catch(() => {});
  }
  
  // تحديث البيانات كل 10 دقائق لضمان تغطية 100% من الأعضاء
  setInterval(() => {
    loadGroupParticipants();
    // تحديث أسماء المسجلين كل 10 دقائق أيضاً
    const s = getSheets();
    if (s && s.loadRegisteredUsers) s.loadRegisteredUsers(true).catch(() => {});
  }, 10 * 60 * 1000);
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
        
        // حفظ pushName مربوطاً بالرقم لحل LID وتحديث اسم واتساب في الشيت
        if (msg.pushName) {
          const s = getSheets();
          if (senderJid && senderJid.includes('@s.whatsapp.net')) {
            // رقم حقيقي — تحديث اسم واتساب في الشيت
            const phoneNum = senderJid.replace('@s.whatsapp.net', '');
            if (s && s.updateWhatsappName) {
              s.updateWhatsappName(phoneNum, msg.pushName).catch(() => {});
            }
          } else if (senderJid && senderJid.includes('@lid')) {
            // LID — نحاول ربطه بالرقم عبر pushName
            const resolved = resolvePhoneByPushName(msg.pushName);
            if (resolved) {
              addLidMapping(senderJid, resolved);
              logger.info(`✅ ربط LID من pushName عند وصول الرسالة: ${msg.pushName} → ${resolved}`);
              // تحديث اسم واتساب في الشيت
              const phoneNum = resolved.replace('@s.whatsapp.net', '');
              if (s && s.updateWhatsappName) {
                s.updateWhatsappName(phoneNum, msg.pushName).catch(() => {});
              }
            } else {
              // لم يُحل عبر pushName — نحاول senderPn مباشرة من بيانات الرسالة
              const rawSenderPn = msg.key?.senderPn || msg.key?.participantPn;
              if (rawSenderPn) {
                const pnJid = rawSenderPn.includes('@') ? rawSenderPn : `${rawSenderPn}@s.whatsapp.net`;
                addLidMapping(senderJid, pnJid);
                logger.info(`✅ ربط LID من senderPn مباشرة: ${msg.pushName} → ${pnJid}`);
                if (s && s.updateWhatsappName) {
                  const phoneNum = pnJid.replace('@s.whatsapp.net', '');
                  s.updateWhatsappName(phoneNum, msg.pushName).catch(() => {});
                }
              } else {
                // سجل الاسم غير المحلول للمراجعة اليدوية
                logger.warn(`⚠️ LID غير محلول: ${msg.pushName}`, { lid: senderJid?.substring(0, 15) });
              }
            }
          }
        }

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

    // === اكتشاف حذف الرسائل ===
    sock.ev.on('messages.delete', async (item) => {
      try {
        // item قد يكون { keys: [...] } أو { jid, ids: [...] }
        const keys = item?.keys || (item?.ids ? item.ids.map(id => ({ id, remoteJid: item.jid })) : []);
        
        for (const key of keys) {
          const msgId = key?.id || key;
          const remoteJid = key?.remoteJid || item?.jid || '';
          
          // فقط من الجروبات المستهدفة
          const targetGroups = config.whatsapp.targetGroups || [];
          const isTarget = targetGroups.some(g => g.id === remoteJid);
          if (!isTarget) continue;
          
          // جلب الرسالة من الكاش
          const cachedMsg = messageCache.get(msgId);
          
          let phone = '';
          let name = '';
          let text = '';
          
          if (cachedMsg) {
            const senderJid = getSenderJid(cachedMsg);
            phone = senderJid ? senderJid.replace('@s.whatsapp.net', '').replace('@lid', '') : '';
            name = cachedMsg.pushName || '';
            text = extractText(cachedMsg) || '';
            // إذا كان النص فارغاً حدد نوع الرسالة
            if (!text) {
              const m = cachedMsg.message || {};
              if (m.imageMessage) text = `[صورة] ${m.imageMessage.caption || ''}`;
              else if (m.audioMessage) text = '[رسالة صوتية]';
              else if (m.videoMessage) text = `[فيديو] ${m.videoMessage.caption || ''}`;
              else if (m.stickerMessage) text = '[ستيكر]';
              else if (m.documentMessage) text = `[ملف] ${m.documentMessage.fileName || ''}`;
              else text = '[رسالة غير نصية]';
            }
          } else {
            text = '[لم تُخزّن الرسالة]';
          }
          
          // إذا لم يكن لدينا اسم من الكاش، نبحث في المسجلين
          if (!name && phone) {
            const s = getSheets();
            if (s && s.getRegisteredName) name = s.getRegisteredName(phone) || '';
          }
          
          logger.info(`🗑️ حذف رسالة`, { phone, name, msgId: msgId?.substring(0, 12), text: text.substring(0, 50) });
          
          // تسجيل في ورقة المحذوف
          const s = getSheets();
          if (s && s.saveDeletedMessage) {
            s.saveDeletedMessage({ phone, name, text, messageId: msgId }).catch(() => {});
          }
        }
      } catch (err) {
        logger.debug('خطأ في معالجة حذف الرسالة', { error: err.message });
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

/**
 * مزامنة فورية لجميع أعضاء الجروب — يُستدعى بأمر النقطة
 * يجلب groupMetadata ويربط LID بالرقم لكل عضو
 * @param {string} groupId - معرف الجروب (اختياري — إذا فارغ يعمل على جميع الجروبات)
 * @returns {{ newLinks: number, total: number }}
 */
async function syncGroupLids(groupId) {
  if (!sock) return { newLinks: 0, total: 0 };
  
  const targetGroups = config.whatsapp.targetGroups || [];
  const groups = groupId
    ? targetGroups.filter(g => g.id === groupId)
    : targetGroups;
  
  let newLinks = 0;
  let total = 0;
  
  for (const group of groups) {
    try {
      const metadata = await sock.groupMetadata(group.id);
      if (!metadata?.participants) continue;
      
      for (const p of metadata.participants) {
        total++;
        // p.id = الرقم الحقيقي (JID)
        // p.lid = المعرف المشفر
        if (p.lid && p.id) {
          const existed = lidToPhoneMap.has(p.lid);
          lidToPhoneMap.set(p.lid, p.id);
          if (!existed) newLinks++;
        }
        // أيضاً العكس: إذا كان id هو LID وليس رقماً
        if (p.id?.includes('@lid') && p.lid) {
          const existed = lidToPhoneMap.has(p.id);
          lidToPhoneMap.set(p.id, p.lid);
          if (!existed) newLinks++;
        }
      }
      logger.info(`🔄 syncGroupLids: ${group.name} → ${metadata.participants.length} عضو`);
    } catch (e) {
      logger.warn(`فشل مزامنة جروب ${group.name}`, { error: e.message });
    }
  }
  
  // حفظ التحديثات على القرص
  if (newLinks > 0) saveLidMapDebounced();
  
  logger.info(`✅ syncGroupLids: ${newLinks} ربط جديد من إجمالي ${total}`);
  return { newLinks, total };
}

// ====================================================
// حفظ وتحميل lidMap من/إلى القرص
// ====================================================

/**
 * حفظ lidMap على القرص (يُستدعى عند كل تحديث جديد)
 */
function saveLidMap() {
  try {
    const dir = path.dirname(LID_MAP_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(lidToPhoneMap);
    fs.writeFileSync(LID_MAP_PATH, JSON.stringify(obj, null, 2));
    logger.debug(`💾 تم حفظ lidMap (${lidToPhoneMap.size} ربط)`);
  } catch (e) {
    logger.warn('فشل حفظ lidMap', { error: e.message });
  }
}

/**
 * تحميل lidMap من القرص عند بدء التشغيل
 */
function loadLidMap() {
  try {
    if (fs.existsSync(LID_MAP_PATH)) {
      const data = JSON.parse(fs.readFileSync(LID_MAP_PATH, 'utf8'));
      let count = 0;
      for (const [lid, phone] of Object.entries(data)) {
        if (lid && phone) {
          lidToPhoneMap.set(lid, phone);
          count++;
        }
      }
      logger.info(`📂 تم تحميل ${count} ربط LID من القرص`);
    }
  } catch (e) {
    logger.warn('فشل تحميل lidMap من القرص', { error: e.message });
  }
}

/**
 * إضافة ربط جديد لـ lidMap مع حفظ تلقائي
 */
let lidMapDirty = false;
let lidMapSaveTimer = null;

function addLidMapping(lid, phone) {
  if (!lid || !phone) return;
  if (lidToPhoneMap.get(lid) === phone) return; // لا تغيير
  lidToPhoneMap.set(lid, phone);
  lidMapDirty = true;
  // حفظ مؤجل (كل 5 ثواني) لتجنب الكتابة المتكررة
  if (!lidMapSaveTimer) {
    lidMapSaveTimer = setTimeout(() => {
      lidMapSaveTimer = null;
      if (lidMapDirty) {
        saveLidMap();
        lidMapDirty = false;
      }
    }, 5000);
  }
}

/**
 * محاولة حل LID عبر مطابقة pushName مع ورقة المسجلين
 */
function resolveLidByPushName(lid, pushName) {
  if (!lid || !pushName || pushName === 'غير معروف') return null;
  const sheets = getSheets();
  if (!sheets || !sheets.findPhoneByName) return null;
  
  const phone = sheets.findPhoneByName(pushName);
  if (phone) {
    const jid = `${phone}@s.whatsapp.net`;
    addLidMapping(lid, jid);
    logger.info(`🔗 تم ربط LID بالاسم: ${pushName} → ${phone}`, { lid: lid.substring(0, 12) });
    return jid;
  }
  return null;
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
  if (key.senderPn) {
    // بناء خريطة LID تلقائياً من الرسائل الواردة
    if (key.participant && key.participant.includes('@lid')) {
      addLidMapping(key.participant, key.senderPn);
    }
    return key.senderPn;
  }
  if (key.participantPn) {
    if (key.participant && key.participant.includes('@lid')) {
      addLidMapping(key.participant, key.participantPn);
    }
    return key.participantPn;
  }

  // ثانياً: participant إذا كان رقم حقيقي
  if (key.participant && key.participant.includes('@s.whatsapp.net')) return key.participant;

  // ثالثاً: البحث في msg.participant (بعض الرسائل تحمله هنا)
  if (msg.participant && msg.participant.includes('@s.whatsapp.net')) return msg.participant;

  // رابعاً: حل LID من الكاش
  if (key.participant && key.participant.includes('@lid')) {
    const resolved = lidToPhoneMap.get(key.participant);
    if (resolved) return resolved;
    
    // محاولة إضافية: البحث بالجزء الأول من LID
    const lidPrefix = key.participant.split(':')[0];
    for (const [lid, phone] of lidToPhoneMap.entries()) {
      if (lid.split(':')[0] === lidPrefix) return phone;
    }
    
    // خامساً: محاولة حل LID عبر pushName من ورقة المسجلين
    if (msg.pushName) {
      const resolvedByName = resolveLidByPushName(key.participant, msg.pushName);
      if (resolvedByName) return resolvedByName;
    }
  }

  // سادساً: participant حتى لو LID (آخر محاولة) - لكن نسجل تحذير
  if (key.participant && !key.participant.endsWith('@g.us')) {
    if (key.participant.includes('@lid')) {
      logger.warn('⚠️ LID غير محلول', { lid: key.participant, pushName: msg.pushName || '' });
    }
    return key.participant;
  }
  if (key.remoteJid && !key.remoteJid.endsWith('@g.us')) return key.remoteJid;

  return null;
}

/**
 * استخراج اسم المستخدم (Push Name) من الرسالة
 */
function getPushName(msg) {
  return msg?.pushName || 'غير معروف';
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

/**
 * تخزين رقم صاحب الطلب مربوطاً بـ id رسالة الرد (تم)
 * replyMsgId = id رسالة الكابتن التي رد فيها بـ"تم"
 * producerPhone = رقم صاحب الطلب الأصلي (عابدين)
 */
function setOrderForReply(replyMsgId, producerPhone) {
  if (!replyMsgId || !producerPhone) return;
  orderCache.set(replyMsgId, producerPhone);
  logger.debug('💾 orderCache', { replyId: replyMsgId.substring(0, 8), producer: producerPhone, size: orderCache.size });
}

function getOrderByReplyId(replyMsgId) {
  return orderCache.get(replyMsgId) || null;
}

function getCachedMessage(messageId) {
  return messageCache.get(messageId) || null;
}

/**
 * استخراج pushName من رسالة مخزنة في الكاش
 * مفيد لحل LID عبر اسم صاحب الرسالة الأصلية
 */
function getPushNameFromCachedMessage(messageId) {
  const msg = messageCache.get(messageId);
  return msg?.pushName || null;
}

/**
 * محاولة حل رقم الهاتف من pushName عبر ورقة المسجلين
 * يُستخدم عندما يكون LID غير محلول في contextInfo
 * @param {string} pushName - اسم واتساب
 * @returns {string|null} رقم الهاتف كـ JID أو null
 */
function resolvePhoneByPushName(pushName) {
  if (!pushName || pushName === 'غير معروف') return null;
  const sheets = getSheets();
  if (!sheets || !sheets.findPhoneByName) return null;
  const phone = sheets.findPhoneByName(pushName);
  if (phone) return `${phone}@s.whatsapp.net`;
  return null;
}

/**
 * جلب حالة ربط LID لجميع المسجلين
 * يُرجع: { phone, name, lid, resolved }
 */
function getRegisteredLidStatus() {
  const sheets = getSheets();
  if (!sheets || !sheets.getAllRegistered) return [];
  const all = sheets.getAllRegistered();
  const result = [];
  for (const { phone, name } of all) {
    const jid = `${phone}@s.whatsapp.net`;
    // البحث عن LID مرتبط بهذا الرقم
    let lid = null;
    for (const [l, p] of lidToPhoneMap.entries()) {
      const pNum = p.replace('@s.whatsapp.net', '');
      if (pNum === phone || pNum.slice(-9) === phone.slice(-9)) {
        lid = l;
        break;
      }
    }
    result.push({ phone, name, lid, resolved: !!lid });
  }
  return result;
}

/**
 * جلب جميع أعضاء الجروب مع LID وحالة الربط
 */
async function getGroupMembersWithLidStatus(groupId) {
  if (!sock) return [];
  try {
    const metadata = await sock.groupMetadata(groupId);
    const participants = metadata?.participants || [];
    const sheets = getSheets();
    const result = [];
    for (const p of participants) {
      const lid = p.lid || p.id || '';
      if (!lid.includes('@lid')) continue;
      // هل هذا LID محلول؟
      const resolvedJid = lidToPhoneMap.get(lid);
      const resolvedPhone = resolvedJid ? resolvedJid.replace('@s.whatsapp.net', '') : null;
      // اسم من ورقة المسجلين
      const name = resolvedPhone && sheets ? (sheets.getRegisteredName(resolvedPhone) || '') : '';
      // pushName من messageCache
      let pushName = '';
      for (const [, msg] of messageCache.entries()) {
        const k = msg.key || {};
        if ((k.participant === lid) && msg.pushName) {
          pushName = msg.pushName;
          break;
        }
      }
      result.push({ lid, resolvedPhone, name, pushName, resolved: !!resolvedPhone });
    }
    return result;
  } catch(e) {
    logger.warn('فشل جلب أعضاء الجروب', { error: e.message });
    return [];
  }
}

function getCacheStats() {
  return { messageCache: messageCache.size, tamCache: tamCache.size, lidMap: lidToPhoneMap.size };
}

/**
 * إرجاع قائمة الليد غير المحلولة مع pushName من messageCache
 */
function getUnresolvedLids() {
  const result = [];
  const seen = new Set();
  for (const [msgId, msg] of messageCache.entries()) {
    const key = msg.key || {};
    const participant = key.participant || '';
    if (!participant.includes('@lid')) continue;
    if (lidToPhoneMap.has(participant)) continue; // محلول بالفعل
    if (seen.has(participant)) continue;
    seen.add(participant);
    result.push({
      lid: participant,
      pushName: msg.pushName || '',
      msgId: msgId.substring(0, 12),
    });
  }
  return result;
}

function lookupPhone(phone) {
  // البحث عن رقم في lidMap (هل موجود كقيمة)
  const results = [];
  for (const [lid, jid] of lidToPhoneMap.entries()) {
    const num = jid.replace('@s.whatsapp.net', '');
    if (num.includes(phone) || phone.includes(num)) {
      results.push({ lid, jid: num });
    }
  }
  // البحث في tamCache
  const tamEntries = [];
  for (const [msgId, captainPhone] of tamCache.entries()) {
    if (captainPhone.includes(phone) || phone.includes(captainPhone)) {
      tamEntries.push({ msgId: msgId.substring(0, 12), captainPhone });
    }
  }
  return { inLidMap: results.length > 0, lidEntries: results, tamEntries: tamEntries.slice(0, 10) };
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
  getPushName,
  getCachedMessage,
  onQRUpdate,
  getDiscoveredGroups,
  lookupPhone,
  resolveLidByPushName,
  addLidMapping,
  setOrderForReply,
  getOrderByReplyId,
  getPushNameFromCachedMessage,
  resolvePhoneByPushName,
  syncGroupLids,
  getUnresolvedLids,
  getRegisteredLidStatus,
  getGroupMembersWithLidStatus,
};
