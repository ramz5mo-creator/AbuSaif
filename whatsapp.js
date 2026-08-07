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
  USyncQuery,
  USyncUser,
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

// مسار حفظ lidMap على القرص — يستخدم VOLUME_PATH للحفظ الدائم
const LID_MAP_PATH = path.resolve(config.volumePath, 'lid-map.json');

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

// مرجع lazy لـ members-db (lazy لتجنب circular dependency)
let membersDbModule = null;
function getMembersDb() {
  if (!membersDbModule) {
    try { membersDbModule = require('./members-db'); } catch (e) { /* تجاهل */ }
  }
  return membersDbModule;
}

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

  // تحميل أسماء المسجلين
  const sheets = getSheets();
  if (sheets && sheets.loadRegisteredUsers) {
    sheets.loadRegisteredUsers().catch(() => {});
  }

  // الطبقة 1: تحميل قاعدة بيانات Members من Sheets (المصدر الدائم)
  getMembersDb().initialize().then(() => {
    return getMembersDb().loadFromSheets();
  }).then(({ lidToPhone: sheetsLids }) => {
    // دمج بيانات Sheets في lidToPhoneMap المحلية
    let merged = 0;
    for (const [lid, phone] of sheetsLids.entries()) {
      if (lid && phone && !lidToPhoneMap.has(lid)) {
        lidToPhoneMap.set(lid, phone);
        merged++;
      }
    }
    logger.info(`🗃️ دمج ${merged} ربط جديد من Members DB في الخريطة المحلية`);
    
    // الطبقة 2: تحميل بيانات groupMetadata ومقارنتها
    return loadGroupParticipantsAndSync();
  }).catch(e => {
    logger.debug('members-db init error', { error: e.message });
    // فالباك: تحميل من groupMetadata فقط
    loadGroupParticipants();
  });

  // تحديث كل 30 دقيقة: مقارنة الأعضاء وحل الجدد فقط
  setInterval(() => {
    loadGroupParticipantsAndSync().catch(() => {});
    const s = getSheets();
    if (s && s.loadRegisteredUsers) s.loadRegisteredUsers(true).catch(() => {});
  }, 30 * 60 * 1000);

  // بدء الحل التلقائي للـ LIDs بعد 90 ثانية (بعد تحميل Members DB)
  setTimeout(() => {
    startAutoResolveLids().catch(e => logger.debug('startAutoResolveLids error', { error: e.message }));
  }, 90 * 1000);
}
    });

    sock.ev.on('creds.update', saveCreds);

    // === استقبال الرسائل ===
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

            for (const msg of messages) {
        if (!msg.message) continue;

        // تخزين رسائل البوت نفسه (fromMe) في الكاش حتى يمكن استخدامها عند الرد عليها
        if (msg.key.fromMe) {
          if (msg.key.id && msg.message && !msg.message.reactionMessage) {
            const remoteJidBot = msg.key.remoteJid || '';
            const targetGroupsBot = config.whatsapp.targetGroups || [];
            const isTargetBot = targetGroupsBot.some(g => g.id === remoteJidBot);
            if (isTargetBot && remoteJidBot.endsWith('@g.us')) {
              messageCache.set(msg.key.id, msg);
              if (messageCache.size > 5000) {
                const firstKey = messageCache.keys().next().value;
                messageCache.delete(firstKey);
              }
            }
          }
          continue;
        }

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
                // إضافة LID لقائمة الحل التلقائي
                queueLidForResolve(senderJid);
                // محاولة أخيرة 1: جلب بيانات العضو من groupMetadata مباشرة
                if (sock && remoteJid && senderJid && senderJid.includes('@lid')) {
                  (async () => {
                    try {
                      // محاولة groupMetadata أولاً
                      let resolved = false;
                      const meta = await sock.groupMetadata(remoteJid);
                      if (meta?.participants) {
                        for (const p of meta.participants) {
                          const pLid = p.lid || '';
                          const pId = p.id || '';
                          const sLid = senderJid.split(':')[0];
                          const pLidBase = pLid.split(':')[0];
                          if (pLid === senderJid || pLidBase === sLid) {
                            if (pId && pId.includes('@s.whatsapp.net')) {
                              addLidMapping(senderJid, pId);
                              resolved = true;
                              logger.info(`✅ ربط LID من groupMetadata: ${msg.pushName} → ${pId.split('@')[0]}`, { lid: senderJid.substring(0, 15) });
                              const s = getSheets();
                              if (s && s.updateWhatsappName && msg.pushName) {
                                s.updateWhatsappName(pId.replace('@s.whatsapp.net', ''), msg.pushName).catch(() => {});
                              }
                            }
                            break;
                          }
                        }
                      }
                      // محاولة أخيرة 2: USyncQuery.withLid() مباشرة من واتساب
                      if (!resolved) {
                        const directPhone = await resolveLidDirect(senderJid);
                        if (directPhone && !directPhone.includes('@lid')) {
                          logger.info(`✅ ربط LID من USyncQuery عند وصول الرسالة: ${msg.pushName} → ${directPhone.split('@')[0]}`);
                          const s = getSheets();
                          if (s && s.updateWhatsappName && msg.pushName) {
                            s.updateWhatsappName(directPhone.replace('@s.whatsapp.net', ''), msg.pushName).catch(() => {});
                          }
                        }
                      }
                    } catch (e) {
                      logger.debug('فشل جلب groupMetadata لحل LID', { error: e.message });
                    }
                  })();
                }
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

    // === الطبقة 5: أحداث دخول/خروج/تغيير الأعضاء ===
    sock.ev.on('group-participants.update', async ({ id: groupId, participants, action }) => {
      const targetGroups = config.whatsapp.targetGroups || [];
      const isTarget = targetGroups.some(g => g.id === groupId);
      if (!isTarget) return;
      
      logger.info(`👥 حدث جروب: ${action} | عدد: ${participants.length}`);
      
      if (action === 'add') {
        // عضو جديد — تسجيل تلقائي + حل LID
        const groupName = targetGroups.find(g => g.id === groupId)?.name || groupId;
        setTimeout(async () => {
          try {
            const meta = await sock.groupMetadata(groupId);
            if (!meta?.participants) return;
            const sheets = getSheets();
            for (const p of meta.participants) {
              if (!participants.includes(p.id) && !participants.includes(p.lid)) continue;
              const pId = p.id || '';
              const pLid = p.lid || '';
              
              if (pLid && pId.includes('@s.whatsapp.net')) {
                // رقم حقيقي + LID — حفظ الربط
                lidToPhoneMap.set(pLid, pId);
                const base = pLid.split(':')[0];
                if (base !== pLid) lidToPhoneMap.set(base + '@lid', pId);
                // تسجيل تلقائي في ورقة المسجلين
                if (sheets?.addNewMemberToRegistered) {
                  await sheets.addNewMemberToRegistered(pId, p.notify || '', groupName);
                  // ربط LID بالرقم في عمود D
                  const phone9 = pId.split('@')[0].replace(/\D/g,'').slice(-9);
                  if (sheets.updateLidInRegistered) await sheets.updateLidInRegistered(phone9, pLid);
                }
                logger.info(`✅ عضو جديد: ${pId.split('@')[0]} في ${groupName}`);
              } else if (pId.includes('@lid') || pLid.includes('@lid')) {
                const theLid = pLid.includes('@lid') ? pLid : pId;
                queueLidForResolve(theLid);
                // حل فوري
                resolveLidDirect(theLid).then(async r => {
                  if (r) {
                    logger.info(`✅ عضو جديد (LID محلول): ${theLid.substring(0,15)} → ${r.split('@')[0]}`);
                    if (sheets?.addNewMemberToRegistered) {
                      await sheets.addNewMemberToRegistered(r, p.notify || '', groupName);
                    }
                  } else {
                    // لم يُحل — سجل LID مؤقتاً
                    if (sheets?.addNewMemberToRegistered) {
                      await sheets.addNewMemberToRegistered(theLid, p.notify || '', groupName);
                    }
                  }
                }).catch(() => {});
              }
            }
            saveLidMapDebounced();
          } catch(e) {
            logger.debug('فشل تحديث بيانات العضو الجديد', { error: e.message });
          }
        }, 3000); // انتظر 3 ثوانٍ لاستقرار البيانات
      } else if (action === 'promote' || action === 'demote') {
        // تغيير دور — تحديث القائمة فقط
        setTimeout(async () => {
          try {
            const meta = await sock.groupMetadata(groupId);
            if (!meta?.participants) return;
            for (const p of meta.participants) {
              if (!participants.includes(p.id) && !participants.includes(p.lid)) continue;
              const pId = p.id || '';
              const pLid = p.lid || '';
              if (pLid && pId.includes('@s.whatsapp.net')) {
                lidToPhoneMap.set(pLid, pId);
                const base = pLid.split(':')[0];
                if (base !== pLid) lidToPhoneMap.set(base + '@lid', pId);
              }
            }
            saveLidMapDebounced();
          } catch(e) {}
        }, 3000);
      } else if (action === 'remove') {
        // عضو غادر — لا نحذف الربط (قد يعود)
        logger.info(`🚶 عضو غادر الجروب: ${participants[0]?.substring(0,15)}`);
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
          let linked = 0;
          let unlinked = 0;
          for (const p of metadata.participants) {
            const pId = p.id || '';
            const pLid = p.lid || '';
            if (pLid && pId && pId.includes('@s.whatsapp.net')) {
              // ربط LID بالرقم الحقيقي
              lidToPhoneMap.set(pLid, pId);
              // أيضاً: ربط بدون رقم الجلسة (prefix فقط)
              const lidBase = pLid.split(':')[0];
              if (lidBase && lidBase !== pLid) {
                lidToPhoneMap.set(lidBase + '@lid', pId);
              }
              linked++;
            } else if (pId && pId.includes('@s.whatsapp.net') && !pLid) {
              // عضو بدون LID — سيرسل برقمه مباشرة
              unlinked++;
            }
          }
          totalParticipants += metadata.participants.length;
          logger.info(`📋 جروب ${group.name}: ${metadata.participants.length} عضو | مربوط: ${linked} | بدون LID: ${unlinked}`);
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
 * تحميل بيانات groupMetadata ومزامنتها مع Members DB
 * يحل فقط الأعضاء الجدد غير الموجودين في Members DB
 */
async function loadGroupParticipantsAndSync() {
  if (!sock) return;
  const db = getMembersDb();
  const targetGroups = config.whatsapp.targetGroups || [];
  const newMembers = []; // أعضاء جدد لحلهم وحفظهم
  const allMembers = []; // جميع الأعضاء للحفظ الكامل

  for (const group of targetGroups) {
    try {
      const metadata = await sock.groupMetadata(group.id);
      if (!metadata?.participants) continue;

      for (const p of metadata.participants) {
        const pId = p.id || '';
        const pLid = p.lid || '';
        const role = (p.admin === 'admin' || p.admin === 'superadmin') ? 'مشرف' : 'عضو';

        if (pLid && pId.includes('@s.whatsapp.net')) {
          // عضو معروف — ربط LID بالرقم
          const phone = pId.split('@')[0].replace(/\D/g, '').slice(-9);
          lidToPhoneMap.set(pLid, pId);
          const base = pLid.split(':')[0];
          if (base !== pLid) lidToPhoneMap.set(base + '@lid', pId);

          allMembers.push({ lid: pLid, phone, name: '', group: group.name, role });

          // تحديث Members DB في الذاكرة
          if (db) db.upsertMember({ lid: pLid, phone, group: group.name, role });

        } else if (pId.includes('@lid') || (pLid && !pId.includes('@s.whatsapp.net'))) {
          // LID غير محلول — تحقق إذا كان في Members DB
          const effectiveLid = pId.includes('@lid') ? pId : pLid;
          const existingPhone = lidToPhoneMap.get(effectiveLid) || (db && db.resolvePhone(effectiveLid));

          if (!existingPhone) {
            // عضو جديد غير معروف — أضفه لقائمة الحل
            newMembers.push({ lid: effectiveLid, group: group.name, role });
            queueLidForResolve(effectiveLid);
          } else {
            // معروف من Members DB — تحديث الخريطة المحلية
            lidToPhoneMap.set(effectiveLid, existingPhone);
          }
        } else if (pId.includes('@s.whatsapp.net') && !pLid) {
          // عضو بدون LID — حفظ برقمه مباشرة
          const phone = pId.split('@')[0].replace(/\D/g, '').slice(-9);
          allMembers.push({ lid: '', phone, name: '', group: group.name, role });
          if (db) db.upsertMember({ lid: '', phone, group: group.name, role });
        }
      }
      logger.info(`📊 ${group.name}: ${metadata.participants.length} عضو | جدد غير محلول: ${newMembers.length}`);
    } catch (e) {
      logger.warn(`فشل تحميل ${group.name}`, { error: e.message });
    }
  }

  logger.info(`🔗 الإجمالي: ${lidToPhoneMap.size} ربط | جدد للحل: ${newMembers.length}`);
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
      
      const unresolvedLids = [];
      for (const p of metadata.participants) {
        total++;
        // p.id = الرقم الحقيقي (JID)
        // p.lid = المعرف المشفر
        if (p.lid && p.id && p.id.includes('@s.whatsapp.net')) {
          // عضو عادي: ربط LID بالرقم الحقيقي
          const existed = lidToPhoneMap.has(p.lid);
          lidToPhoneMap.set(p.lid, p.id);
          const lidBase = p.lid.split(':')[0];
          if (lidBase && lidBase !== p.lid) lidToPhoneMap.set(lidBase + '@lid', p.id);
          if (!existed) newLinks++;
        } else if (p.id?.includes('@lid') || (p.lid && !p.id?.includes('@s.whatsapp.net'))) {
          // عضو يظهر كـ LID فقط — يحتاج USyncQuery
          const lidToResolve = p.id?.includes('@lid') ? p.id : p.lid;
          if (lidToResolve) unresolvedLids.push(lidToResolve);
        }
      }
      
      // حل الأعضاء غير المحلولين عبر USyncQuery
      if (unresolvedLids.length > 0) {
        logger.info(`🔍 محاولة حل ${unresolvedLids.length} LID غير محلول عبر USyncQuery في ${group.name}`);
        for (const lid of unresolvedLids) {
          try {
            const resolved = await resolveLidDirect(lid);
            if (resolved && resolved.includes('@s.whatsapp.net')) {
              newLinks++;
              logger.info(`✅ حل LID عبر USyncQuery (مزامنة): ${lid.substring(0,15)} → ${resolved.split('@')[0]}`);
            }
          } catch (e) {
            logger.debug(`فشل حل LID ${lid.substring(0,15)}`, { error: e.message });
          }
        }
      }
      
      logger.info(`🔄 syncGroupLids: ${group.name} → ${metadata.participants.length} عضو | غير محلول: ${unresolvedLids.length}`);
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
 * تحميل lidMap من القرص (مؤقت لحين تحميل Sheets)
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
      logger.info(`📂 تم تحميل ${count} ربط LID من القرص (مؤقت)`);
    }
  } catch (e) {
    logger.warn('فشل تحميل lidMap من القرص', { error: e.message });
  }
}

/**
 * تحميل lidMap من Google Sheets (المصدر الدائم)
 * يُستدعى بعد استقرار الاتصال بواتساب
 */
async function loadLidMapFromSheets() {
  const sheets = getSheets();
  if (!sheets || !sheets.loadLidMapFromSheets) return;
  try {
    const sheetsMap = await sheets.loadLidMapFromSheets();
    if (sheetsMap && sheetsMap.size > 0) {
      let added = 0;
      for (const [lid, phone] of sheetsMap.entries()) {
        if (!lidToPhoneMap.has(lid)) {
          lidToPhoneMap.set(lid, phone);
          added++;
        }
      }
      logger.info(`🗃️ تم تحميل خريطة LID من Sheets: ${sheetsMap.size} ربط (جديد: ${added})`);
      // حفظ نسخة محلية أيضاً
      saveLidMap();
    }
  } catch (e) {
    logger.debug('فشل تحميل lidMap من Sheets', { error: e.message });
  }
}

/**
 * حفظ lidMap في Google Sheets (بعد اكتمال بناء الخريطة)
 */
async function saveLidMapToSheets() {
  const sheets = getSheets();
  if (!sheets || !sheets.saveLidMapToSheets) return;
  try {
    await sheets.saveLidMapToSheets(lidToPhoneMap);
  } catch (e) {
    logger.debug('فشل حفظ lidMap في Sheets', { error: e.message });
  }
}

/**
 * إضافة ربطات جديدة فقط لـ Sheets (أسرع من الحفظ الكامل)
 */
async function appendNewLidsToSheets(newEntries) {
  const sheets = getSheets();
  if (!sheets || !sheets.appendLidMapToSheets || !newEntries || newEntries.size === 0) return;
  try {
    await sheets.appendLidMapToSheets(newEntries);
  } catch (e) {
    logger.debug('فشل appendNewLidsToSheets', { error: e.message });
  }
}

/**
 * إضافة ربط جديد لـ lidMap مع حفظ تلقائي
 */
let lidMapDirty = false;
let lidMapSaveTimer = null;

/**
 * حل LID إلى رقم هاتف من lidToPhoneMap
 * يجرب المفتاح الكامل أولاً، ثم البادئة
 */
function resolveLid(lid) {
  if (!lid) return null;
  // الأولوية 1: ورقة المسجلين (مصدر الحقيقة)
  try {
    const sheets = require('./sheets');
    const fromRegistered = sheets.resolvePhoneFromRegistered(lid);
    if (fromRegistered) {
      const jid = `${fromRegistered}@s.whatsapp.net`;
      addLidMapping(lid, jid); // حفظ في الكاش المحلي
      return jid;
    }
  } catch(e) { /* sheets قد يكون غير جاهز */ }
  // الأولوية 2: الكاش المحلي (lid-map.json)
  const direct = lidToPhoneMap.get(lid);
  if (direct) return direct;
  // مطابقة بالبادئة (بدون رقم الجلسة)
  const lidPrefix = lid.split(':')[0];
  const baseKey = lidPrefix + '@lid';
  const baseMatch = lidToPhoneMap.get(baseKey);
  if (baseMatch) {
    addLidMapping(lid, baseMatch);
    return baseMatch;
  }
  // بحث خطي
  for (const [k, v] of lidToPhoneMap.entries()) {
    if (k.split(':')[0] === lidPrefix) {
      addLidMapping(lid, v);
      return v;
    }
  }
  return null;
}
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
 * حل LID مباشرة من واتساب عبر USyncQuery.withLid()
 * الحل الجذري الذي لا يعتمد على الاسم أو groupMetadata
 */
async function resolveLidDirect(lid) {
  if (!sock || !lid || !lid.includes('@lid')) return null;
  // تحقق أولاً من الكاش المحلي
  const cached = resolveLid(lid);
  if (cached && cached.includes('@s.whatsapp.net')) return cached;
  try {
    const query = new USyncQuery().withContactProtocol().withLIDProtocol();
    query.withUser(new USyncUser().withLid(lid));
    const results = await sock.executeUSyncQuery(query);
    if (results && results.list && results.list.length > 0) {
      const item = results.list[0];
      // محاولة 1: item.id مباشرة
      if (item.id && item.id.includes('@s.whatsapp.net')) {
        addLidMapping(lid, item.id);
        const phone9 = item.id.split('@')[0].replace(/\D/g,'').slice(-9);
        const db = getMembersDb();
        if (db) db.upsertMember({ lid, phone: phone9 });
        // تحديث ورقة المسجلين (عمود D)
        try { const sh = require('./sheets'); sh.updateLidInRegistered(phone9, lid).catch(()=>{}); } catch(e){}
        logger.info(`✅ resolveLidDirect: ${lid.substring(0, 15)} → ${item.id.split('@')[0]}`);
        return item.id;
      }
      // محاولة 2: item.contact.id
      if (item.contact && item.contact.id && item.contact.id.includes('@s.whatsapp.net')) {
        addLidMapping(lid, item.contact.id);
        const phone9b = item.contact.id.split('@')[0].replace(/\D/g,'').slice(-9);
        const db2 = getMembersDb();
        if (db2) db2.upsertMember({ lid, phone: phone9b });
        // تحديث ورقة المسجلين (عمود D)
        try { const sh = require('./sheets'); sh.updateLidInRegistered(phone9b, lid).catch(()=>{}); } catch(e){}
        logger.info(`✅ resolveLidDirect(contact): ${lid.substring(0, 15)} → ${item.contact.id.split('@')[0]}`);
        return item.contact.id;
      }
    }
  } catch (e) {
    logger.debug('فشل resolveLidDirect', { error: e.message, lid: lid.substring(0, 15) });
  }
  return null;
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
    // مطابقة تامة
    const resolved = lidToPhoneMap.get(key.participant);
    if (resolved) return resolved;
    // محاولة 1: البحث بالجزء الأول من LID (بدون رقم الجلسة)
    const lidPrefix = key.participant.split(':')[0];
    // جرب المفتاح المخزن بالبادئة
    const baseKey = lidPrefix + '@lid';
    const resolvedBase = lidToPhoneMap.get(baseKey);
    if (resolvedBase) {
      // حددنا الرقم — أضف المفتاح الكامل للمرة القادمة
      addLidMapping(key.participant, resolvedBase);
      return resolvedBase;
    }
    // محاولة 2: بحث خطي في جميع المفاتيح
    for (const [lid, phone] of lidToPhoneMap.entries()) {
      if (lid.split(':')[0] === lidPrefix) {
        addLidMapping(key.participant, phone);
        return phone;
      }
    }
    // محاولة 3: حل LID عبر pushName من ورقة المسجلين
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
    const sheetsModule = getSheets();
    const result = [];
    for (const p of participants) {
      const jid = p.id || '';
      const lid = p.lid || '';
      const isLid = jid.includes('@lid') || lid.includes('@lid');
      const effectiveLid = lid.includes('@lid') ? lid : (jid.includes('@lid') ? jid : null);
      
      // pushName من messageCache
      let pushName = p.notify || '';
      if (!pushName) {
        for (const [, msg] of messageCache.entries()) {
          const k = msg.key || {};
          const sender = k.participant || k.remoteJid || '';
          if ((sender === jid || sender === lid || sender === effectiveLid) && msg.pushName) {
            pushName = msg.pushName;
            break;
          }
        }
      }
      
      if (isLid && effectiveLid) {
        // عضو يرسل كـ LID
        const resolvedJid = lidToPhoneMap.get(effectiveLid);
        const resolvedPhone = resolvedJid ? resolvedJid.replace('@s.whatsapp.net', '') : null;
        const name = resolvedPhone && sheetsModule ? (sheetsModule.getRegisteredName(resolvedPhone) || '') : '';
        result.push({
          lid: effectiveLid,
          phone: resolvedPhone || null,
          name: name || pushName,
          pushName,
          resolved: !!resolvedPhone,
          status: resolvedPhone ? 'resolved' : 'unresolved'
        });
      } else if (jid.includes('@s.whatsapp.net')) {
        // عضو برقم حقيقي
        const phone = jid.replace('@s.whatsapp.net', '');
        const name = sheetsModule ? (sheetsModule.getRegisteredName(phone) || '') : '';
        result.push({
          lid: null,
          phone,
          name: name || pushName,
          pushName,
          resolved: true,
          status: 'real'
        });
      }
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

// ====================================================
// الحل التلقائي للـ LIDs (دفعات آمنة)
// ====================================================

// قائمة انتظار LIDs غير المحلولة
const _lidResolveQueue = new Set();
let _autoResolveRunning = false;

/**
 * إضافة LID لقائمة الحل التلقائي
 */
function queueLidForResolve(lid) {
  if (!lid || !lid.includes('@lid')) return;
  if (lidToPhoneMap.has(lid)) return; // محلول بالفعل
  _lidResolveQueue.add(lid);
}

/**
 * تشغيل الحل التلقائي للـ LIDs بدفعات آمنة
 * 10 LIDs كل 30 ثانية لتجنب الحظر
 */
async function autoResolveLidsBatch() {
  if (_autoResolveRunning) return;
  if (!sock) return;
  if (_lidResolveQueue.size === 0) return;
  
  _autoResolveRunning = true;
  const BATCH_SIZE = 10;
  const batch = [];
  
  for (const lid of _lidResolveQueue) {
    if (batch.length >= BATCH_SIZE) break;
    if (!lidToPhoneMap.has(lid)) { // تأكد أنه لا يزال غير محلول
      batch.push(lid);
    } else {
      _lidResolveQueue.delete(lid); // حُل بطريقة أخرى
    }
  }
  
  if (batch.length === 0) {
    _autoResolveRunning = false;
    return;
  }
  
  logger.info(`🤖 autoResolve: محاولة حل ${batch.length} LID من ${_lidResolveQueue.size} في الانتظار`);
  let resolved = 0;
  
  for (const lid of batch) {
    try {
      const result = await resolveLidDirect(lid);
      if (result) {
        resolved++;
        _lidResolveQueue.delete(lid);
        // تتبع النجاحات لتحديث السجلات القديمة (الطبقة 4)
        const phone = result.split('@')[0].replace(/\D/g, '');
        if (phone.length >= 9) {
          _newlyResolvedLids.set(lid, phone);
          // تحديث Members DB بالرقم الحقيقي
          const db = getMembersDb();
          if (db) db.upsertMember({ lid, phone: phone.slice(-9) });
        }
        logger.info(`✅ autoResolve: ${lid.substring(0,15)} → ${phone}`);
      } else {
        // فشل — احتفظ به في القائمة لمحاولة لاحقة
      }
    } catch(e) {
      logger.debug(`autoResolve فشل: ${lid.substring(0,15)}`, { error: e.message });
    }
    // تأخير 500ms بين كل LID لتجنب الضغط
    await new Promise(r => setTimeout(r, 500));
  }
  
  if (resolved > 0) {
    saveLidMapDebounced();
    // الطبقة 4: تحديث السجلات القديمة في الشيت
    if (_newlyResolvedLids.size > 0) {
      const sheets = getSheets();
      if (sheets && sheets.backfillLidRecords) {
        const toUpdate = new Map(_newlyResolvedLids);
        _newlyResolvedLids.clear();
        sheets.backfillLidRecords(toUpdate).catch(e => 
          logger.debug('فشل backfill سجلات LID', { error: e.message })
        );
      }
    }
  }
  logger.info(`🤖 autoResolve: ${resolved}/${batch.length} تم حلها | متبقي: ${_lidResolveQueue.size}`);
  _autoResolveRunning = false;
}

// تتبع النجاحات الجديدة: { lid → phone } لتحديث السجلات القديمة
const _newlyResolvedLids = new Map();

/**
 * جمع جميع LIDs غير المحلولة من جميع الجروبات وإضافتها للقائمة
 */
async function collectAllUnresolvedLids() {
  if (!sock) return 0;
  const targetGroups = config.whatsapp.targetGroups || [];
  let queued = 0;
  for (const group of targetGroups) {
    try {
      const metadata = await sock.groupMetadata(group.id);
      if (!metadata?.participants) continue;
      for (const p of metadata.participants) {
        const pId = p.id || '';
        const pLid = p.lid || '';
        // طبقة 1: عضو لديه LID ورقم حقيقي — احفظ الربط مباشرة
        if (pLid && pId.includes('@s.whatsapp.net')) {
          if (!lidToPhoneMap.has(pLid)) {
            lidToPhoneMap.set(pLid, pId);
            const base = pLid.split(':')[0];
            if (base !== pLid) lidToPhoneMap.set(base + '@lid', pId);
          }
        }
        // طبقة 2: عضو يظهر كـ LID فقط — أضفه للقائمة
        if (pId.includes('@lid') && !lidToPhoneMap.has(pId)) {
          _lidResolveQueue.add(pId);
          queued++;
        }
        if (pLid && !pId.includes('@s.whatsapp.net') && !lidToPhoneMap.has(pLid)) {
          _lidResolveQueue.add(pLid);
          queued++;
        }
      }
    } catch(e) {
      logger.debug(`collectAllUnresolvedLids: فشل ${group.name}`, { error: e.message });
    }
  }
  if (queued > 0) logger.info(`📝 جمع LIDs: ${queued} جديد في القائمة | إجمالي: ${_lidResolveQueue.size}`);
  return queued;
}

/**
 * نظام LID الشامل من 5 طبقات
 * الطبقة 1: حل عند البدء لجميع الأعضاء
 * الطبقة 2: Job كل 5 دقائق لإعادة المحاولة
 * الطبقة 3: حل فوري عند وصول رسالة من LID غير محلول
 * الطبقة 4: تحديث السجلات القديمة عند حل LID
 * الطبقة 5: تحديث قائمة الأعضاء عند الأحداث
 */
async function startAutoResolveLids() {
  logger.info('🚀 بدء نظام LID الشامل (5 طبقات)');
  
  // الطبقة 1: جمع وحل جميع LIDs عند البدء
  await collectAllUnresolvedLids();
  
  // تشغيل أول دفعة بعد 5 ثوانٍ
  setTimeout(autoResolveLidsBatch, 5 * 1000);
  
  // الطبقة 2: Job كل 5 دقائق — إعادة جمع + حل
  setInterval(async () => {
    await collectAllUnresolvedLids();
    await autoResolveLidsBatch();
  }, 5 * 60 * 1000);
  
  // الطبقة 2b: دفعة اعتيادية كل 30 ثانية للقائمة الحالية
  setInterval(autoResolveLidsBatch, 30 * 1000);
  
  // الطبقة 5: تحديث قائمة الأعضاء كل ساعة
  setInterval(async () => {
    logger.info('🔄 تحديث دوري لقائمة الأعضاء (كل ساعة)');
    await loadGroupParticipants();
    await collectAllUnresolvedLids();
  }, 60 * 60 * 1000);
  
  logger.info(`✅ نظام LID نشط: ${_lidResolveQueue.size} في القائمة`);
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

function getLidToPhoneMap() {
  return lidToPhoneMap;
}

function getMessageCache() {
  return messageCache;
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
  resolveLid,
  resolveLidDirect,
  addLidMapping,
  setOrderForReply,
  getOrderByReplyId,
  getPushNameFromCachedMessage,
  resolvePhoneByPushName,
  syncGroupLids,
  getUnresolvedLids,
  getRegisteredLidStatus,
  getGroupMembersWithLidStatus,
  getLidToPhoneMap,
  getMessageCache,
  queueLidForResolve,
  startAutoResolveLids,
};
