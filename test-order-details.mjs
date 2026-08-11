import { createRequire } from 'node:module';

process.env.VOLUME_PATH = '/tmp/abusaif-order-details-test';
const require = createRequire(import.meta.url);
const whatsapp = require('./whatsapp');

const quotedOrder = {
  extendedTextMessage: { text: 'طلب محفوظ داخل الاقتباس' },
};
if (whatsapp.extractText({ message: quotedOrder }) !== 'طلب محفوظ داخل الاقتباس') {
  throw new Error('فشل استخراج نص الطلب من الاقتباس المضمّن');
}

whatsapp.setOrderForReply('TEST_DETAIL_001', '797210303', {
  orderMessageId: 'ORDER_001',
  orderText: 'طلب تجريبي',
  tamText: 'تم',
});

const context = whatsapp.getOrderContextByReplyId('TEST_DETAIL_001');
if (!context ||
    context.producer !== '797210303' ||
    context.orderMessageId !== 'ORDER_001' ||
    context.orderText !== 'طلب تجريبي' ||
    context.tamText !== 'تم') {
  throw new Error('فشل حفظ واسترجاع سياق تفاصيل الطلب');
}

console.log('✅ اختبار سياق تفاصيل الطلبات ناجح');
process.exit(0);
