/**
 * server.js - نقطة تشغيل النظام
 * ================================
 * يبدأ جميع الخدمات ويربطها ببعض.
 */

const config = require('./config');
const logger = require('./logger');
const whatsapp = require('./whatsapp');
const parser = require('./parser');
const sheets = require('./sheets');

// === بدء التشغيل ===
async function start() {
  logger.info('═══════════════════════════════════════');
  logger.info('   🚀 نظام AbuSaif - تجريد الطلبات');
  logger.info('═══════════════════════════════════════');
  logger.info('جاري بدء التشغيل...');

  // 1. تهيئة Google Sheets
  try {
    await sheets.initialize();
    logger.info('✅ تم الاتصال بـ Google Sheets');

    // تحميل كلمات الاستلام من ورقة الإعدادات
    await sheets.loadSettings();
    logger.info('✅ تم تحميل الإعدادات من Sheets');
  } catch (error) {
    logger.warn('⚠️ لم يتم الاتصال بـ Google Sheets (سيعمل بالإعدادات الافتراضية)', {
      error: error.message,
    });
  }

  // 2. تعيين معالج الرسائل
  whatsapp.setMessageHandler(async (msg, sock) => {

    // ====================================================
    // حالة 1: تفاعل (reaction) مثل 👍 / 2️⃣ / 3️⃣
    // المنتج (صاحب الطلب) يضع الإيموجي → يُسجّل له "انتاج"
    // ====================================================
    if (whatsapp.isReaction(msg)) {
      const result = await parser.processMessage(msg, sock);
      if (!result) return;

      // إذا كان صاحب رسالة "تم" غير معروف (الكاش فارغ) → ابحث في الجدول
      let captainPhone = result.orderOwnerPhone || result.quotedPhone || '';
      if (!captainPhone && result.quotedMessageId) {
        captainPhone = await sheets.getOrderOwnerByMessageId(result.quotedMessageId) || '';
        if (captainPhone) {
          logger.info('📋 وجدنا الكابتن من الجدول', { captain: captainPhone });
        }
      }

      if (result.type === 'accept') {
        // 👍/2️⃣/3️⃣ = انتاج للمنتج + استلام للكابتن
        try {
          const producerPhone = result.phone;
          const quantity = result.quantity;

          // تسجيل الانتاج للمنتج
          await sheets.updateTotalsProduction(producerPhone, quantity);

          // تسجيل الاستلام للكابتن
          if (captainPhone) {
            await sheets.updateTotalsReception(captainPhone, quantity);
          }

          logger.info('✅ تفاعل انتاج مسجّل', {
            producer: producerPhone,
            captain: captainPhone || 'غير معروف',
            qty: quantity,
          });
        } catch (error) {
          logger.error('❌ فشل تسجيل الانتاج', { error: error.message });
        }

      } else if (result.type === 'cancel') {
        // ❌ = إلغاء فوري → يخصم من الطرفين
        try {
          const producerPhone = result.phone;
          const quantity = result.quantity;

          // خصم من انتاج المنتج
          await sheets.updateTotalsProduction(producerPhone, -quantity);

          // خصم من استلام الكابتن
          if (captainPhone) {
            await sheets.updateTotalsReception(captainPhone, -quantity);
          }

          logger.info('❌ إلغاء مسجّل', {
            producer: producerPhone,
            captain: captainPhone || 'غير معروف',
            qty: quantity,
          });
        } catch (error) {
          logger.error('❌ فشل تسجيل الإلغاء', { error: error.message });
        }
      }
      return;
    }

    // ====================================================
    // حالة 2: رسالة نصية (طلب أو رد استلام)
    // ====================================================
    const result = await parser.processMessage(msg, sock);
    if (!result) return;

    if (result.type === 'order') {
      // رسالة طلب أصلية → سجّلها في ورقة الطلبات
      try {
        await sheets.recordOrder(result);
        logger.debug('📝 طلب جديد مسجّل', {
          phone: result.phone,
          text: result.text.substring(0, 40),
        });
      } catch (error) {
        logger.warn('فشل تسجيل الطلب', { error: error.message });
      }

    } else if (result.type === 'accept') {
      // رد بـ "تم" → لا يُسجّل شيء في الإجمالي
      // التسجيل يحدث فقط عند وضع المنتج الإيموجي على رسالة "تم"
      logger.debug('تم تجاهل رسالة "تم" - التسجيل يكون عند وضع الإيموجي', {
        phone: result.phone,
      });
    }
  });

  // 3. الاتصال بواتساب
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
      logger.debug('تم تحديث الإعدادات من Sheets');
    } catch (error) {
      logger.debug('فشل تحديث الإعدادات', { error: error.message });
    }
  }, config.general.settingsRefreshInterval);

  logger.info('النظام يعمل الآن. في انتظار الرسائل...');
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
