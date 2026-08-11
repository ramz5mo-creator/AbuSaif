/**
 * test.js - اختبار وحدات النظام
 * ================================
 */

const parser = require('./parser');
const fs = require('fs');
const path = require('path');

console.log('═══════════════════════════════════════');
console.log('   اختبار نظام AbuSaif');
console.log('═══════════════════════════════════════\n');

// === اختبار تحويل إيموجيات الأرقام ===
console.log('🔢 اختبار تحويل إيموجيات الأرقام:');
const emojiTests = [
  { input: '2️⃣2️⃣', expected: 22 },
  { input: '1️⃣5️⃣', expected: 15 },
  { input: '5️⃣', expected: 5 },
  { input: '🔟', expected: 10 },
  { input: '3️⃣0️⃣', expected: 30 },
];

emojiTests.forEach(({ input, expected }) => {
  const result = parser.emojiToNumber(input);
  const status = result === expected ? '✅' : '❌';
  console.log(`  ${status} "${input}" → ${result} (متوقع: ${expected})`);
});

// === اختبار استخراج الكمية ===
console.log('\n📊 اختبار استخراج الكمية:');
const quantityTests = [
  { input: '👍', expected: 1 },
  { input: '15', expected: 15 },
  { input: '2️⃣2️⃣', expected: 22 },
  { input: 'تم 5', expected: 5 },
  { input: '', expected: 1 },
  { input: 'هات 10', expected: 10 },
  { input: '3️⃣', expected: 3 },
];

quantityTests.forEach(({ input, expected }) => {
  const result = parser.extractQuantity(input);
  const status = result === expected ? '✅' : '❌';
  console.log(`  ${status} "${input}" → ${result} (متوقع: ${expected})`);
});

// === اختبار كلمات الاستلام ===
console.log('\n📝 اختبار كلمات الاستلام:');
const acceptTests = [
  { input: 'تم', expected: true },
  { input: 'هات', expected: true },
  { input: 'تن', expected: true },
  { input: 'اوك', expected: true },
  { input: '👍', expected: true },
  { input: 'مرحبا', expected: false },
  { input: 'تم 5', expected: true },
  { input: 'هات 15', expected: true },
  { input: 'لا', expected: false },
  { input: 'تم الاستلام', expected: true },
];

acceptTests.forEach(({ input, expected }) => {
  const result = parser.isAcceptMessage(input);
  const status = result === expected ? '✅' : '❌';
  console.log(`  ${status} "${input}" → ${result} (متوقع: ${expected})`);
});

// === اختبار استخراج رقم الهاتف ===
console.log('\n📱 اختبار استخراج رقم الهاتف:');
const phoneTests = [
  { input: '201234567890@s.whatsapp.net', expected: '201234567890' },
  { input: '966501234567@s.whatsapp.net', expected: '966501234567' },
  { input: null, expected: null },
];

phoneTests.forEach(({ input, expected }) => {
  const result = parser.cleanPhone(input);
  const status = result === expected ? '✅' : '❌';
  console.log(`  ${status} "${input}" → "${result}" (متوقع: "${expected}")`);
});

// === اختبار Recovery بعد التشغيل الأولي ===
console.log('\n🔄 اختبار Recovery بعد الاتصال الأولي:');
const whatsappSource = fs.readFileSync(path.join(__dirname, 'whatsapp.js'), 'utf8');
const connectedHandler = whatsappSource.match(/connectionManager\.on\('CONNECTED',[\s\S]*?\n  \}\);/);
const initialConnectionRunsRecovery = Boolean(
  connectedHandler && connectedHandler[0].includes('await _onConnected(sock, true);')
);
console.log(`  ${initialConnectionRunsRecovery ? '✅' : '❌'} الاتصال الأولي يفعّل Recovery`);
if (!initialConnectionRunsRecovery) process.exitCode = 1;

console.log('\n═══════════════════════════════════════');
console.log('   انتهى الاختبار');
console.log('═══════════════════════════════════════');
