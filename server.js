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
    // ====================================================
    if (whatsapp.isReaction(msg)) {
      const result = await parser.processMessage(msg, sock);
      if (result && result.type === 'accept') {
        try {
          // إذا كان صاحب الطلب غير معروف (الكاش فارغ) → ابحث في الجدول
          if (!result.orderOwnerPhone && result.quotedMessageId) {
            const ownerFromSheet = await sheets.getOrderOwnerByMessageId(result.quotedMessageId);
            if (ownerFromSheet) {
              result.orderOwnerPhone = ownerFromSheet;
              result.quotedPhone = ownerFromSheet;
              logger.info('📋 وجدنا صاحب الطلب من الجدول (تفاعل)', { owner: ownerFromSheet });
            }
          }

          await sheets.recordTransaction(result);
          if (result.quotedMessageId) {
            await sheets.updateOrderStatus(
              result.quotedMessageId,
              result.phone,
              result.quantity
            );
          }
          logger.info('✅ تفاعل استلام مسجّل', {
            phone: result.phone,
            owner: result.quotedPhone || 'غير معروف',
            qty: result.quantity,
          });
        } catch (error) {
          logger.error('❌ فشل تسجيل التفاعل', { error: error.message });
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
      // رد استلام → سجّله في سجل الحركات وحدّث الأرصدة
      // المستلم (phone) → -quantity
      // صاحب الطلب (quotedPhone) → +quantity
      try {
        // إذا كان صاحب الطلب غير معروف (الكاش فارغ أو LID) → ابحث في الجدول
        if (!result.orderOwnerPhone && result.quotedMessageId) {
          const ownerFromSheet = await sheets.getOrderOwnerByMessageId(result.quotedMessageId);
          if (ownerFromSheet) {
            result.orderOwnerPhone = ownerFromSheet;
            result.quotedPhone = ownerFromSheet;
            logger.info('📋 وجدنا صاحب الطلب من الجدول (رد)', { owner: ownerFromSheet });
          }
        }

        await sheets.recordTransaction(result);
        logger.info('✅ استلام مسجّل', {
          phone: result.phone,
          owner: result.quotedPhone || 'غير معروف',
          qty: result.quantity,
        });
      } catch (error) {
        logger.error('❌ فشل تسجيل الاستلام', { error: error.message });
      }

      // تحديث حالة الطلب الأصلي في ورقة الطلبات
      if (result.quotedMessageId) {
        try {
          await sheets.updateOrderStatus(
            result.quotedMessageId,
            result.phone,
            result.quantity
          );
        } catch (error) {
          logger.warn('فشل تحديث حالة الطلب', { error: error.message });
        }
      }
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
