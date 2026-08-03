/**
 * test-sheets.js - اختبار الاتصال بـ Google Sheets
 * ================================
 * يختبر القراءة والكتابة في الجدول الحقيقي.
 */

const sheets = require('./sheets');
const logger = require('./logger');

async function runTests() {
  console.log('═══════════════════════════════════════');
  console.log('   اختبار الاتصال بـ Google Sheets');
  console.log('═══════════════════════════════════════\n');

  // 1. اختبار التهيئة
  console.log('1️⃣ اختبار التهيئة والاتصال...');
  try {
    await sheets.initialize();
    console.log('   ✅ تم الاتصال بالجدول بنجاح\n');
  } catch (error) {
    console.log(`   ❌ فشل الاتصال: ${error.message}\n`);
    process.exit(1);
  }

  // 2. اختبار تحميل الإعدادات
  console.log('2️⃣ اختبار تحميل الإعدادات...');
  try {
    await sheets.loadSettings();
    console.log('   ✅ تم تحميل الإعدادات\n');
  } catch (error) {
    console.log(`   ❌ فشل تحميل الإعدادات: ${error.message}\n`);
  }

  // 3. اختبار تسجيل عملية تجريبية
  console.log('3️⃣ اختبار تسجيل عملية تجريبية...');
  try {
    const testTransaction = {
      transactionId: 'TEST-' + Date.now(),
      messageId: 'MSG-TEST-001',
      type: 'accept',
      phone: '201000000000',
      quotedPhone: '201111111111',
      quantity: 5,
      text: 'تم 5 (اختبار)',
      quotedText: 'طلب تجريبي للاختبار',
      timestamp: new Date().toISOString(),
      groupId: 'test@g.us',
    };

    await sheets.recordTransaction(testTransaction);
    console.log('   ✅ تم تسجيل العملية التجريبية\n');
  } catch (error) {
    console.log(`   ❌ فشل تسجيل العملية: ${error.message}\n`);
  }

  // 4. اختبار جلب الرصيد
  console.log('4️⃣ اختبار جلب الرصيد...');
  try {
    const balance = await sheets.getBalance('201000000000');
    if (balance) {
      console.log(`   ✅ الرصيد: ${balance.totalAmount} | العمليات: ${balance.totalOps}\n`);
    } else {
      console.log('   ⚠️ لم يتم العثور على رصيد\n');
    }
  } catch (error) {
    console.log(`   ❌ فشل جلب الرصيد: ${error.message}\n`);
  }

  console.log('═══════════════════════════════════════');
  console.log('   انتهى اختبار Google Sheets');
  console.log('═══════════════════════════════════════');
}

runTests().catch(console.error);
