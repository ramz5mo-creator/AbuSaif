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
        <h1>✅ البوت متصل بواتساب</h1>
        <p>tamCache: ${whatsapp.getCacheStats().tamCache} رسالة</p>
        <p>آخر تحديث: ${new Date().toLocaleString('ar-JO', {timeZone:'Asia/Amman'})}</p>
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
        });

        try {
          await sheets.updateTotalsProduction(producerPhone, quantity);
          logger.info(`✅ انتاج: ${producerPhone} +${quantity}`);
        } catch (error) {
          logger.error('❌ فشل انتاج', { error: error.message });
        }

        if (captainPhone) {
          try {
            await sheets.updateTotalsReception(captainPhone, quantity);
            logger.info(`✅ استلام: ${captainPhone} +${quantity}`);
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
        logger.info('❌ إلغاء', { producer: producerPhone, captain: captainPhone || '❓' });

        try {
          await sheets.updateTotalsProduction(producerPhone, -quantity);
        } catch (error) {
          logger.error('فشل خصم انتاج', { error: error.message });
        }

        if (captainPhone) {
          try {
            await sheets.updateTotalsReception(captainPhone, -quantity);
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

  // 4. الاتصال بواتساب
  try {
    await whatsapp.connect();
    logger.info('جاري الاتصال بواتساب...');
  } catch (error) {
    logger.error('❌ فشل الاتصال', { error: error.message });
    process.exit(1);
  }

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
