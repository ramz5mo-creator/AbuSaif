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
    const result = await parser.processMessage(msg, sock);
    if (result) {
      // تسجيل العملية في Google Sheets
      try {
        await sheets.recordTransaction(result);
        logger.info('✅ تم تسجيل العملية', {
          type: result.type,
          phone: result.phone,
          amount: result.amount,
        });
      } catch (error) {
        logger.error('❌ فشل تسجيل العملية في Sheets', {
          error: error.message,
          result,
        });
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
