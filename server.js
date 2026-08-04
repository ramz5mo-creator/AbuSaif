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

    // استخراج النص والمرسل
    const text = whatsapp.extractText ? whatsapp.extractText(msg) : null;
    const sender = msg.key.participant || msg.key.remoteJid;
    const phone = sender ? sender.replace(/@.*$/, '') : null;
    const messageId = msg.key.id;
    const timestamp = new Date().toISOString();

    // التحقق من الرد (contextInfo)
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
    const isReply = !!contextInfo?.quotedMessage;

    if (text && phone) {
      if (!isReply) {
        // === رسالة طلب أصلية (ليست ردًا) → سجّلها في ورقة الطلبات ===
        try {
          await sheets.recordOrder({
            phone,
            text: text.substring(0, 500),
            timestamp,
            messageId,
          });
          logger.debug('📝 تم تسجيل طلب جديد', { phone, text: text.substring(0, 40) });
        } catch (error) {
          logger.warn('فشل تسجيل الطلب', { error: error.message });
        }
      }
    }

    // === معالجة رسائل الاستلام (الردود) ===
    const result = await parser.processMessage(msg, sock);
    if (result) {
      // تسجيل العملية في سجل الحركات
      try {
        await sheets.recordTransaction(result);
        logger.info('✅ تم تسجيل العملية', {
          type: result.type,
          phone: result.phone,
          quantity: result.quantity,
        });
      } catch (error) {
        logger.error('❌ فشل تسجيل العملية في Sheets', {
          error: error.message,
        });
      }

      // تحديث حالة الطلب الأصلي في ورقة الطلبات
      const quotedMessageId = contextInfo?.stanzaId;
      if (quotedMessageId) {
        try {
          await sheets.updateOrderStatus(quotedMessageId, result.phone, result.quantity);
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
