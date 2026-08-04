/**
 * server.js - نقطة تشغيل النظام
 * ================================
 * المنطق الكامل:
 *
 * 1. الكابتن يكتب "تم" ردًا على طلب:
 *    → يُحفظ رقمه في tamCache (ذاكرة) + سجل_تم (Google Sheets)
 *    → لا يُسجَّل شيء في الإجمالي
 *
 * 2. المنتج يضع 👍/2️⃣/3️⃣ على رسالة "تم":
 *    → يُسجَّل له "انتاج" في عمود B
 *    → يُسجَّل للكابتن "استلام" في عمود C
 *    → البحث عن الكابتن: tamCache → سجل_تم (Sheets)
 *
 * 3. ❌ على رسالة "تم":
 *    → يُخصم فوراً من انتاج المنتج
 *    → يُخصم فوراً من استلام الكابتن
 */

const http = require('http');
const QRCode = require('qrcode');
const config = require('./config');
const logger = require('./logger');
const whatsapp = require('./whatsapp');
const parser = require('./parser');
const sheets = require('./sheets');

// ====================================================
// خادم ويب بسيط لعرض QR كصفحة
// ====================================================
let currentQR = null;

const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/qr') {
    if (!currentQR) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="background:#000;color:#0f0;font-size:24px;text-align:center;padding:50px;"><h1>✅ البوت متصل بواتساب بنجاح!</h1><p>لا حاجة لمسح QR</p></body></html>');
      return;
    }
    try {
      const qrImage = await QRCode.toDataURL(currentQR, { width: 400 });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="background:#000;text-align:center;padding:30px;">
        <h1 style="color:#fff;">📱 امسح رمز QR بواتساب</h1>
        <img src="${qrImage}" style="width:400px;height:400px;border:10px solid #fff;border-radius:10px;" />
        <p style="color:#ff0;font-size:18px;">الرمز يتغير كل 20 ثانية - حدّث الصفحة إذا انتهت صلاحيته</p>
        <script>setTimeout(()=>location.reload(), 20000);</script>
      </body></html>`);
    } catch (e) {
      res.writeHead(500);
      res.end('Error generating QR');
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('AbuSaif Bot Running');
  }
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  logger.info(`🌐 خادم QR يعمل على البورت ${PORT}`);
});

// دالة لتحديث QR الحالي
function setCurrentQR(qr) {
  currentQR = qr;
}
function clearCurrentQR() {
  currentQR = null;
}

// ====================================================
// دالة مساعدة: البحث عن رقم الكابتن بكل الطرق المتاحة
// ====================================================
async function findCaptainPhone(quotedMessageId, fallbackPhone) {
  // الطريقة 1: tamCache في الذاكرة (الأسرع)
  if (quotedMessageId) {
    const fromCache = whatsapp.getCaptainByMessageId(quotedMessageId);
    if (fromCache) {
      logger.info('💾 الكابتن من tamCache', { captain: fromCache, msgId: quotedMessageId.substring(0, 10) });
      return fromCache;
    }
  }

  // الطريقة 2: من بيانات الرسالة المرفقة (إذا كانت متاحة)
  if (fallbackPhone) {
    logger.info('📱 الكابتن من بيانات الرسالة', { captain: fallbackPhone });
    return fallbackPhone;
  }

  // الطريقة 3: من ورقة سجل_تم في Google Sheets (بعد إعادة الاتصال)
  if (quotedMessageId) {
    const fromSheet = await sheets.getCaptainFromTamSheet(quotedMessageId);
    if (fromSheet) {
      // أعد تحميله في tamCache لتسريع الطلبات القادمة
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
  logger.info('   🚀 نظام AbuSaif - تجريد الطلبات v3');
  logger.info('═══════════════════════════════════════');

  // 1. تهيئة Google Sheets
  try {
    await sheets.initialize();
    logger.info('✅ تم الاتصال بـ Google Sheets');
    await sheets.loadSettings();
    logger.info('✅ تم تحميل الإعدادات');
  } catch (error) {
    logger.warn('⚠️ Google Sheets غير متاح (سيعمل بالإعدادات الافتراضية)', {
      error: error.message,
    });
  }

  // 2. تعيين معالج الرسائل
  whatsapp.setMessageHandler(async (msg, sock) => {

    // ====================================================
    // حالة 1: تفاعل (reaction) 👍 / 2️⃣ / 3️⃣ / ❌
    // ====================================================
    if (whatsapp.isReaction(msg)) {
      const result = await parser.processMessage(msg, sock);
      if (!result) return;

      const producerPhone = result.phone;   // من وضع الإيموجي
      const quantity = result.quantity;
      const quotedMsgId = result.quotedMessageId;

      // البحث عن رقم الكابتن بكل الطرق
      const captainPhone = await findCaptainPhone(
        quotedMsgId,
        result.orderOwnerPhone || result.quotedPhone || null
      );

      if (result.type === 'accept') {
        // ====================================================
        // انتاج + استلام
        // ====================================================
        logger.info('🎯 تفاعل انتاج', {
          producer: producerPhone,
          captain: captainPhone || '❓ غير معروف',
          qty: quantity,
          msgId: quotedMsgId?.substring(0, 10),
        });

        try {
          // تسجيل الانتاج للمنتج (دائماً)
          await sheets.updateTotalsProduction(producerPhone, quantity);
          logger.info(`✅ انتاج مسجّل: ${producerPhone} +${quantity}`);
        } catch (error) {
          logger.error('❌ فشل تسجيل الانتاج', { error: error.message, producer: producerPhone });
        }

        if (captainPhone) {
          try {
            // تسجيل الاستلام للكابتن
            await sheets.updateTotalsReception(captainPhone, quantity);
            logger.info(`✅ استلام مسجّل: ${captainPhone} +${quantity}`);
          } catch (error) {
            logger.error('❌ فشل تسجيل الاستلام', { error: error.message, captain: captainPhone });
          }
        } else {
          logger.warn('⚠️ لم يُعثر على رقم الكابتن - الاستلام لم يُسجَّل', {
            quotedMsgId: quotedMsgId?.substring(0, 10),
          });
        }

      } else if (result.type === 'cancel') {
        // ====================================================
        // إلغاء فوري: خصم من الطرفين
        // ====================================================
        logger.info('❌ إلغاء', {
          producer: producerPhone,
          captain: captainPhone || '❓ غير معروف',
          qty: quantity,
        });

        try {
          await sheets.updateTotalsProduction(producerPhone, -quantity);
          logger.info(`✅ خصم انتاج: ${producerPhone} -${quantity}`);
        } catch (error) {
          logger.error('❌ فشل خصم الانتاج', { error: error.message });
        }

        if (captainPhone) {
          try {
            await sheets.updateTotalsReception(captainPhone, -quantity);
            logger.info(`✅ خصم استلام: ${captainPhone} -${quantity}`);
          } catch (error) {
            logger.error('❌ فشل خصم الاستلام', { error: error.message });
          }
        }
      }

      return;
    }

    // ====================================================
    // حالة 2: رسالة نصية
    // ====================================================
    const result = await parser.processMessage(msg, sock);
    if (!result) return;

    if (result.type === 'order') {
      // طلب أصلي → سجّله في ورقة الطلبات
      try {
        await sheets.recordOrder(result);
        logger.debug('📝 طلب جديد', {
          phone: result.phone,
          text: result.text.substring(0, 40),
        });
      } catch (error) {
        logger.warn('فشل تسجيل الطلب', { error: error.message });
      }

    } else if (result.type === 'accept') {
      // ====================================================
      // رسالة "تم" → احفظ رقم الكابتن في:
      // 1. tamCache (ذاكرة سريعة)
      // 2. سجل_تم في Google Sheets (دائم)
      // ====================================================
      const captainPhone = result.phone;
      const tamMessageId = result.messageId;

      if (captainPhone && tamMessageId) {
        // حفظ في الذاكرة
        whatsapp.setCaptainForMessage(tamMessageId, captainPhone);

        // حفظ دائم في Google Sheets (للاستعادة بعد إعادة الاتصال)
        sheets.saveTamToSheet(tamMessageId, captainPhone).catch((err) => {
          logger.debug('فشل حفظ تم في الجدول', { error: err.message });
        });

        logger.info('💾 تم حفظ رسالة "تم"', {
          captain: captainPhone,
          msgId: tamMessageId.substring(0, 10),
        });
      }
    }
  });

  // 3. ربط QR بالخادم
  whatsapp.onQRUpdate(setCurrentQR, clearCurrentQR);

  // 4. الاتصال بواتساب
  try {
    await whatsapp.connect();
    logger.info('جاري الاتصال بواتساب...');
  } catch (error) {
    logger.error('❌ فشل الاتصال بواتساب', { error: error.message });
    process.exit(1);
  }

  // 4. تحديث الإعدادات دورياً
  setInterval(async () => {
    try {
      await sheets.loadSettings();
      const stats = whatsapp.getCacheStats();
      logger.debug('تحديث الإعدادات', { tamCache: stats.tamCache, msgCache: stats.messageCache });
    } catch (error) {
      logger.debug('فشل تحديث الإعدادات', { error: error.message });
    }
  }, config.general.settingsRefreshInterval);

  logger.info('✅ النظام يعمل الآن. في انتظار الرسائل...');
}

// === معالجة الأخطاء غير المتوقعة ===
process.on('uncaughtException', (error) => {
  logger.error('خطأ غير متوقع', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('وعد مرفوض', { reason: String(reason) });
});

// === بدء التشغيل ===
start().catch((error) => {
  logger.error('فشل بدء التشغيل', { error: error.message });
  process.exit(1);
});
