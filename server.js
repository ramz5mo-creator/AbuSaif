/**
 * server.js - نقطة تشغيل النظام v4
 * ================================
 * المنطق:
 *
 * 1. أي رسالة تبدأ بـ "تم" → تُحفظ في tamCache + سجل_تم
 *    (لا تُسجَّل كطلب ولا كانتاج/استلام)
 *
 * 2. إيموجي (👍/2️⃣/3️⃣/5️⃣) على رسالة "تم":
 *    → انتاج لمن وضع الإيموجي
 *    → استلام لمن كتب "تم" (الكابتن)
 *    → يُسجَّل في ورقة يومية (كل يوم ورقة)
 *
 * 3. ❌ على رسالة "تم":
 *    → خصم من الطرفين
 *
 * 4. أي رسالة أخرى → تُتجاهل (لا نسجل الطلبات)
 */

const http = require('http');
const QRCode = require('qrcode');
const config = require('./config');
const logger = require('./logger');
const whatsapp = require('./whatsapp');
const parser = require('./parser');
const sheets = require('./sheets');

// ====================================================
// خادم ويب لعرض QR + حالة البوت
// ====================================================
let currentQR = null;

const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/qr') {
    if (!currentQR) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="background:#111;color:#0f0;font-size:20px;text-align:center;padding:40px;font-family:monospace;">
        <div style="border:2px solid #0f0;padding:20px;border-radius:10px;display:inline-block;">
          <h1>✅ البوت متصل بواتساب</h1>
          <p>tamCache: ${whatsapp.getCacheStats().tamCache} رسالة</p>
          <p>آخر تحديث: ${new Date().toLocaleString('ar-JO', {timeZone:'Asia/Amman'})}</p>
        </div>
        <div style="margin-top:30px;">
          <a href="/logout" style="color:#f00;text-decoration:none;border:1px solid #f00;padding:10px;border-radius:5px;">⚠️ تسجيل الخروج ومسح الجلسة</a>
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
    html += `<p style="text-align:center;margin-top:20px;color:#ff0;">حدّث الصفحة بعد إرسال رسائل في الجروبات</p>`;
    html += `<script>setTimeout(()=>location.reload(), 15000);</script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (req.url === '/all-groups') {
    const sock = whatsapp.getSocket();
    if (!sock) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('البوت غير متصل حالياً');
      return;
    }
    try {
      const groups = await sock.groupFetchAllParticipating();
      const groupList = Object.values(groups);
      let html = `<html><head><meta charset="utf-8"><style>
        body{background:#111;color:#0f0;font-family:monospace;padding:20px;direction:rtl;}
        table{border-collapse:collapse;width:100%;margin-top:20px;}
        th,td{border:1px solid #0f0;padding:10px;text-align:center;}
        th{background:#0f0;color:#000;}
        tr:hover{background:#1a3a1a;}
        h1{text-align:center;}
        .id{font-size:12px;color:#fff;word-break:break-all;user-select:all;background:#333;padding:5px;}
      </style></head><body>`;
      html += `<h1>📋 كافة الجروبات المشترك بها (${groupList.length})</h1>`;
      html += `<table><tr><th>#</th><th>اسم الجروب</th><th>معرف الجروب (JID)</th></tr>`;
      groupList.forEach((group, i) => {
        html += `<tr><td>${i+1}</td><td>${group.subject}</td><td><div class="id">${group.id}</div></td></tr>`;
      });
      html += `</table></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Error: ' + e.message);
    }
  } else if (req.url === '/logout') {
    // مسح ملفات الجلسة وإعادة التشغيل
    const fs = require('fs');
    const path = require('path');
    const authPath = path.resolve(config.whatsapp.authPath);
    try {
      if (fs.existsSync(authPath)) {
        // بما أننا نستخدم مجلد فرعي 'session'، يمكننا حذفه بالكامل بأمان
        fs.rmSync(authPath, { recursive: true, force: true });
        logger.info('🗑️ تم مسح مجلد الجلسة بالكامل');
      }
    } catch (e) {
      logger.error('خطأ في مسح الجلسة', { error: e.message });
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><body style="background:#111;color:#ff0;font-size:20px;text-align:center;padding:40px;font-family:monospace;">
      <h1>🗑️ تم مسح الجلسة</h1>
      <p>البوت سيعيد التشغيل الآن...</p>
      <p>انتظر دقيقة ثم افتح الصفحة الرئيسية لمسح QR الجديد</p>
      <script>setTimeout(()=>location.href='/', 5000);</script>
    </body></html>`);
    // إعادة التشغيل فوراً
    setTimeout(() => process.exit(0), 1000);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('AbuSaif Bot v4');
  }
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  logger.info(`🌐 خادم يعمل على البورت ${PORT}`);
});

function setCurrentQR(qr) { currentQR = qr; }
function clearCurrentQR() { currentQR = null; }

// ====================================================
// البحث عن رقم الكابتن
// ====================================================
async function findCaptainPhone(quotedMessageId, fallbackPhone) {
  // 1. tamCache (الأسرع)
  if (quotedMessageId) {
    const fromCache = whatsapp.getCaptainByMessageId(quotedMessageId);
    if (fromCache) {
      logger.info('💾 كابتن من tamCache', { captain: fromCache });
      return fromCache;
    }
  }

  // 2. من بيانات الرسالة (orderOwnerPhone)
  if (fallbackPhone) {
    logger.info('📱 كابتن من بيانات الرسالة', { captain: fallbackPhone });
    return fallbackPhone;
  }

  // 3. من ورقة سجل_تم (بعد إعادة الاتصال)
  if (quotedMessageId) {
    const fromSheet = await sheets.getCaptainFromTamSheet(quotedMessageId);
    if (fromSheet) {
      whatsapp.setCaptainForMessage(quotedMessageId, fromSheet);
      return fromSheet;
    }
  }

  return null;
}

// ====================================================
// بدء التشغيل
// ====================================================
async function start() {
  logger.info('═══════════════════════════════════════');
  logger.info('   🚀 نظام AbuSaif v4 — ورقة يومية');
  logger.info('═══════════════════════════════════════');

  // 1. تهيئة Google Sheets
  try {
    await sheets.initialize();
    logger.info('✅ Google Sheets متصل');
    await sheets.loadSettings();
    logger.info('✅ الإعدادات محمّلة');
  } catch (error) {
    logger.warn('⚠️ Google Sheets غير متاح', { error: error.message });
  }

  // 2. معالج الرسائل
  whatsapp.setMessageHandler(async (msg, sock) => {

    // ====================================================
    // حالة 1: تفاعل (reaction) 👍 / 2️⃣ / 3️⃣ / ❌
    // ====================================================
    if (whatsapp.isReaction(msg)) {
      const result = await parser.processMessage(msg, sock);
      if (!result) return;

      const producerPhone = result.phone;
      const quantity = result.quantity;
      const quotedMsgId = result.quotedMessageId;
      const remoteJid = msg.key.remoteJid;

      // تحديد بادئة الجروب
      const targetGroups = config.whatsapp.targetGroups || [];
      const groupInfo = targetGroups.find(g => g.id === remoteJid);
      const groupPrefix = groupInfo ? groupInfo.prefix : '';

      const captainPhone = await findCaptainPhone(
        quotedMsgId,
        result.orderOwnerPhone || result.quotedPhone || null
      );

      if (result.type === 'accept') {
        // === انتاج + استلام ===
        logger.info('🎯 تسجيل انتاج+استلام', {
          producer: producerPhone,
          captain: captainPhone || '❓',
          qty: quantity,
          group: groupInfo ? groupInfo.name : 'Unknown'
        });

        try {
          await sheets.updateTotalsProduction(producerPhone, quantity, groupPrefix);
          logger.info(`✅ انتاج: ${producerPhone} +${quantity} [${groupPrefix}]`);
        } catch (error) {
          logger.error('❌ فشل انتاج', { error: error.message });
        }

        if (captainPhone) {
          try {
            await sheets.updateTotalsReception(captainPhone, quantity, groupPrefix);
            logger.info(`✅ استلام: ${captainPhone} +${quantity} [${groupPrefix}]`);
          } catch (error) {
            logger.error('❌ فشل استلام', { error: error.message });
          }
        } else {
          logger.warn('⚠️ لم يُعثر على الكابتن!', { msgId: quotedMsgId?.substring(0, 8) });
        }

        // تسجيل في سجل الحركات
        sheets.recordTransaction({
          transactionId: result.transactionId,
          timestamp: result.timestamp,
          producerPhone,
          captainPhone: captainPhone || '',
          quantity,
          type: 'انتاج',
          emoji: result.text,
        }).catch(() => {});

      } else if (result.type === 'cancel') {
        // === إلغاء ===
        logger.info('❌ إلغاء', { 
          producer: producerPhone, 
          captain: captainPhone || '❓',
          group: groupInfo ? groupInfo.name : 'Unknown'
        });

        try {
          await sheets.updateTotalsProduction(producerPhone, -quantity, groupPrefix);
        } catch (error) {
          logger.error('فشل خصم انتاج', { error: error.message });
        }

        if (captainPhone) {
          try {
            await sheets.updateTotalsReception(captainPhone, -quantity, groupPrefix);
          } catch (error) {
            logger.error('فشل خصم استلام', { error: error.message });
          }
        }

        sheets.recordTransaction({
          transactionId: result.transactionId,
          timestamp: result.timestamp,
          producerPhone,
          captainPhone: captainPhone || '',
          quantity,
          type: 'إلغاء',
          emoji: '❌',
        }).catch(() => {});
      }

      return;
    }

    // ====================================================
    // حالة 2: رسالة نصية
    // ====================================================
    const result = await parser.processMessage(msg, sock);
    if (!result) return;

    if (result.type === 'accept') {
      // رسالة "تم" → حفظ في tamCache + سجل_تم فقط
      const captainPhone = result.phone;
      const tamMessageId = result.messageId;

      if (captainPhone && tamMessageId) {
        whatsapp.setCaptainForMessage(tamMessageId, captainPhone);

        sheets.saveTamToSheet(tamMessageId, captainPhone).catch((err) => {
          logger.debug('فشل حفظ تم', { error: err.message });
        });

        logger.info('💾 حفظ "تم"', { captain: captainPhone, msgId: tamMessageId.substring(0, 8) });
      }
    }
    // أي شيء آخر (order) → نتجاهله — لا نسجل الطلبات
  });

  // 3. ربط QR
  whatsapp.onQRUpdate(setCurrentQR, clearCurrentQR);

  // 4. الاتصال بواتساب (بدون await لمنع تعليق السيرفر)
  whatsapp.connect().then(() => {
    logger.info('جاري الاتصال بواتساب...');
  }).catch((error) => {
    logger.error('❌ فشل الاتصال الأولي', { error: error.message });
  });

  // 5. تحديث الإعدادات دورياً
  setInterval(async () => {
    try {
      await sheets.loadSettings();
    } catch (error) {
      logger.debug('فشل تحديث الإعدادات');
    }
  }, config.general.settingsRefreshInterval);

  logger.info('✅ النظام جاهز. في انتظار الرسائل...');
}

// === معالجة الأخطاء ===
process.on('uncaughtException', (error) => {
  logger.error('خطأ غير متوقع', { error: error.message });
});
process.on('unhandledRejection', (reason) => {
  logger.error('وعد مرفوض', { reason: String(reason) });
});

start().catch((error) => {
  logger.error('فشل التشغيل', { error: error.message });
  process.exit(1);
});
