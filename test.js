/**
 * test.js - اختبار وحدات النظام
 * ================================
 */

const parser = require('./parser');
const config = require('./config');
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
const connectionManagerSource = fs.readFileSync(path.join(__dirname, 'connection-manager.js'), 'utf8');
const connectedHandler = whatsappSource.match(/connectionManager\.on\('CONNECTED',[\s\S]*?\n  \}\);/);
const initialConnectionRunsRecovery = Boolean(
  connectedHandler && connectedHandler[0].includes('await _onConnected(sock, true);')
);
console.log(`  ${initialConnectionRunsRecovery ? '✅' : '❌'} الاتصال الأولي يفعّل Recovery`);
if (!initialConnectionRunsRecovery) process.exitCode = 1;

// === اختبار منع تكرار عملية مسجلة في Google Sheets ===
console.log('\n🛡️ اختبار منع التكرار الدائم:');
const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const persistentDuplicateIsIgnored = serverSource.includes('تفاعل مسترجع مكرر — العملية موجودة بالكمية نفسها');
console.log(`  ${persistentDuplicateIsIgnored ? '✅' : '❌'} العملية المطابقة في Google Sheets لا تعيد الأرصدة`);
if (!persistentDuplicateIsIgnored) process.exitCode = 1;

// === اختبار الاستعادة التاريخية المقيدة ===
console.log('\n🕓 اختبار الاستعادة التاريخية المقيدة:');
const recoverySource = fs.readFileSync(path.join(__dirname, 'recovery-service.js'), 'utf8');
const historicalWindowIsBounded = recoverySource.includes('runHistoricalRecovery') &&
  recoverySource.includes('timestamp <= toTimestamp') &&
  recoverySource.includes('_cursors = cursorsBefore');
console.log(`  ${historicalWindowIsBounded ? '✅' : '❌'} الاستعادة التاريخية مقيدة زمنياً ولا تغيّر مؤشر الرسائل الحي`);
if (!historicalWindowIsBounded) process.exitCode = 1;

const approvedHistoricalRecoveryRunsOnce = whatsappSource.includes('historical-recovery-dreamax-2026-08-12.complete.json') &&
  whatsappSource.includes('RECOVERY_DREAMAX_HISTORICAL_COMPLETED') &&
  whatsappSource.includes('runApprovedDreamaxHistoricalRecoveryOnce(sock)');
console.log(`  ${approvedHistoricalRecoveryRunsOnce ? '✅' : '❌'} استعادة دريمكس المعتمدة تنفذ مرة واحدة مع إيصال دائم`);
if (!approvedHistoricalRecoveryRunsOnce) process.exitCode = 1;

const historicalRecoveryStatusIsReadOnly = serverSource.includes("req.url === '/recovery-status/dreamax-2026-08-12'") &&
  serverSource.includes("completed: Boolean(receipt)");
console.log(`  ${historicalRecoveryStatusIsReadOnly ? '✅' : '❌'} حالة الاستعادة قراءة فقط ولا تعيد التنفيذ`);
if (!historicalRecoveryStatusIsReadOnly) process.exitCode = 1;

// === اختبار رمز الربط البديل ===
console.log('\n📲 اختبار رمز الربط البديل:');
const pairingCodeUsesManagedSocket = whatsappSource.includes('async function requestPairingCode(phoneNumber)') &&
  whatsappSource.includes('return connectionManager.requestPairingCode(phoneNumber);') &&
  connectionManagerSource.includes('const pairingCode = await sock.requestPairingCode(this._pairingPhone);') &&
  connectionManagerSource.includes('_requestPairingCodeAtReadyEvent(sourceSock)') &&
  connectionManagerSource.includes('Boolean(qr)') &&
  connectionManagerSource.includes('تم تجاوز QR لأن رمز الربط قيد الإصدار') &&
  whatsappSource.includes('requestPairingCode,');
const pairingCodeRouteIsPostOnly = serverSource.includes("req.method === 'POST' && req.url === '/pairing-code'") &&
  serverSource.includes("'Cache-Control': 'no-store'");
console.log(`  ${pairingCodeUsesManagedSocket && pairingCodeRouteIsPostOnly ? '✅' : '❌'} رمز الربط يستخدم Socket المُدار ولا يُخزّن في الاستجابة المؤقتة`);
if (!pairingCodeUsesManagedSocket || !pairingCodeRouteIsPostOnly) process.exitCode = 1;

const qrRefreshReturnsToQrMode = whatsappSource.includes('async function refreshQRCode()') &&
  whatsappSource.includes('connectionManager.cancelPairingModeAndRefreshQR()') &&
  connectionManagerSource.includes('async cancelPairingModeAndRefreshQR()') &&
  serverSource.includes("req.method === 'POST' && req.url === '/qr/refresh'");
console.log(`  ${qrRefreshReturnsToQrMode ? '✅' : '❌'} يمكن إلغاء رمز الهاتف والعودة إلى QR`);
if (!qrRefreshReturnsToQrMode) process.exitCode = 1;

// === اختبار تعطيل تقرير نهاية الأسبوع ===
console.log('\n📊 اختبار تعطيل تقرير نهاية الأسبوع:');
const weeklyReportIsDisabled = config.sheets.weeklyReport?.enabled === false &&
  serverSource.includes("config.sheets.weeklyReport?.enabled === true");
console.log(`  ${weeklyReportIsDisabled ? '✅' : '❌'} التقرير لا يعمل يدوياً أو تلقائياً عندما يكون موقوفاً`);
if (!weeklyReportIsDisabled) process.exitCode = 1;

console.log('\n═══════════════════════════════════════');
console.log('   انتهى الاختبار');
console.log('═══════════════════════════════════════');
