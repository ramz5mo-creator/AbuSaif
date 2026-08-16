/**
 * test.js - اختبار وحدات النظام
 * ================================
 */

const parser = require('./parser');
const whatsapp = require('./whatsapp');
const config = require('./config');
const fs = require('fs');
const path = require('path');
const { authorizeQuantityReaction } = require('./reaction-authorization');
const { validateQuantityReactionTarget } = require('./reaction-target-validation');
const { classifyOriginalOrder, extractDeliveryOrderDetails } = require('./order-classification');
const { buildReviewEvidenceFields, buildConversationSummary, isAdoptableManualName, getTodaySheetName } = require('./sheets');
const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

console.log('═══════════════════════════════════════');
console.log('   اختبار نظام AbuSaif');
console.log('═══════════════════════════════════════\n');

// === اختبار دليل المراجعة الواضح ===
console.log('🔎 اختبار دليل رد الكابتن وإيموجي الكمية في المراجعة:');
const reviewEvidence = buildReviewEvidenceFields({
  orderText: '3 اوردرات من حي عدن ل بيادر توصيلك 7.5',
  captainReplyText: 'تم بيادر',
  quantityEmoji: '3️⃣',
  reactorName: 'المنتج',
  reactorPhone: '799999999',
});
const evidenceExpected = ['3 اوردرات من حي عدن ل بيادر توصيلك 7.5', 'تم بيادر', '3️⃣', 'المنتج | 799999999'];
const evidencePassed = evidenceExpected.every((value, index) => reviewEvidence[index] === value);
console.log(`  ${evidencePassed ? '✅' : '❌'} يحفظ النص والرد والإيموجي وصاحب التفاعل بوضوح`);
if (!evidencePassed) process.exitCode = 1;

const conversationSummary = buildConversationSummary({
  producerName: 'أحمد',
  orderText: '3 اوردرات من حي عدن ل بيادر توصيلك 7.5',
  captainName: 'محمد',
  captainReplyText: 'تم بيادر',
  quantity: 3,
  quantityEmoji: '3️⃣',
  reactorName: 'أحمد',
});
const summaryExpected = [
  '📦 المنتج: أحمد',
  '"3 اوردرات من حي عدن ل بيادر توصيلك 7.5"',
  '✅ الكابتن: محمد',
  '"تم بيادر"',
  '3️⃣ الكمية: 3 (من: أحمد)',
].every(value => conversationSummary.includes(value));
console.log(`  ${summaryExpected ? '✅' : '❌'} يبني ملخص محادثة كاملاً ومقروءاً لصف المراجعة`);
if (!summaryExpected) process.exitCode = 1;

// === اختبار اعتماد الاسم اليدوي بدلاً من مجهول ===
console.log('\n👤 اختبار معيار اعتماد الاسم اليدوي:');
const manualNameTests = [
  { input: 'أنس الجعيدي', expected: true, label: 'اسم يدوي صحيح يُعتمد' },
  { input: '  أنس   الجعيدي  ', expected: true, label: 'المسافات الزائدة لا تمنع الاعتماد' },
  { input: 'مجهول', expected: false, label: 'مجهول لا يُعاد اعتماده' },
  { input: 'غير معروف', expected: false, label: 'غير معروف لا يُعتمد' },
  { input: '', expected: false, label: 'الاسم الفارغ لا يُعتمد' },
];
manualNameTests.forEach(({ input, expected, label }) => {
  const result = isAdoptableManualName(input);
  console.log(`  ${result === expected ? '✅' : '❌'} ${label}`);
  if (result !== expected) process.exitCode = 1;
});
const todaySheetName = getTodaySheetName();
const fullDatePassed = /^\d{4}-\d{2}-\d{2}$/.test(todaySheetName);
console.log(`  ${fullDatePassed ? '✅' : '❌'} اسم ورقة اليوم يحتفظ بالتاريخ الكامل (${todaySheetName})`);
if (!fullDatePassed) process.exitCode = 1;

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
  { input: 'تمم', expected: true },
  { input: 'تم 👇', expected: true },
  { input: 'تا', expected: true },
  { input: 'ت', expected: true },
  { input: 'tam', expected: true },
  { input: 'tm', expected: true },
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

// === اختبار منع «تم» المستقلة بلا طلب ===
console.log('\n🚫 اختبار منع التأكيد الذاتي بلا طلب:');
const standaloneAcceptTests = [
  { text: 'تم', isReply: false, expected: true, label: 'تم مستقلة تُهمل' },
  { text: 'تمم', isReply: false, expected: true, label: 'تمم مستقلة تُهمل' },
  { text: 'تم', isReply: true, expected: false, label: 'تم رداً على طلب تبقى صالحة' },
  { text: 'طلب الجبيهة', isReply: false, expected: false, label: 'طلب أصلي لا يُهمل' },
];
standaloneAcceptTests.forEach(({ text, isReply, expected, label }) => {
  const result = parser.isStandaloneAcceptWithoutOrder(text, isReply);
  const status = result === expected ? '✅' : '❌';
  console.log(`  ${status} ${label}`);
  if (result !== expected) process.exitCode = 1;
});

// === اختبار منع التفاعل المباشر على منشور تحذيري أو إعلان ===
console.log('\n🛡️ اختبار إلزام رد التأكيد الموثق قبل تفاعل الكمية:');
const directWarningReaction = validateQuantityReactionTarget({
  captainFromTam: null,
  captainFromSheet: null,
});
const cachedConfirmationReaction = validateQuantityReactionTarget({
  captainFromTam: '962798765432',
  captainFromSheet: null,
});
const recoveredConfirmationReaction = validateQuantityReactionTarget({
  captainFromTam: null,
  captainFromSheet: '962798765432',
});
const qualifiedOrderPendingReaction = validateQuantityReactionTarget({
  captainFromTam: null,
  captainFromSheet: null,
  isQualifiedOrder: true,
  hasCaptainReply: false,
});
const qualifiedOrderConfirmedReaction = validateQuantityReactionTarget({
  captainFromTam: null,
  captainFromSheet: null,
  isQualifiedOrder: true,
  hasCaptainReply: true,
});
const reactionTargetGuardIsApplied =
  serverSource.includes('validateQuantityReactionTarget') &&
  serverSource.includes('تجاهل تفاعل ليس على رد تأكيد موثق') &&
  serverSource.includes('setDirectOrderEmoji') &&
  serverSource.includes('getLatestReplyForOrder');
const confirmedReactionTargetRule =
  directWarningReaction.allowed === false &&
  directWarningReaction.reason === 'confirmation-not-recorded' &&
  cachedConfirmationReaction.allowed === true &&
  recoveredConfirmationReaction.allowed === true &&
  qualifiedOrderPendingReaction.allowed === true &&
  qualifiedOrderPendingReaction.pendingConfirmation === true &&
  qualifiedOrderConfirmedReaction.allowed === true &&
  qualifiedOrderConfirmedReaction.pendingConfirmation === false &&
  reactionTargetGuardIsApplied;
console.log(`  ${confirmedReactionTargetRule ? '✅' : '❌'} التحذير مرفوض؛ الطلب المؤهل يحتفظ بآخر كمية فقط إلى أن يثبت رد الكابتن`);
if (!confirmedReactionTargetRule) process.exitCode = 1;

// === اختبار أن التحذيرات والإعلانات لا تصبح طلبات عبر الرد المقتبس ===
console.log('\n🧾 اختبار تصنيف الطلب الأصلي قبل حفظ رد التأكيد:');
const originalOrderClassificationTests = [
  {
    input: { text: 'تحذير: ممنوع تأكيد أي طلب وأنت بعيد عن منطقة الاستلام' },
    expected: 'invalid',
    label: 'منشور تحذيري لا يصبح طلباً',
  },
  {
    input: { text: 'ادخل على كشفك من هنا https://example.com ثم اتبع الخطوات' },
    expected: 'invalid',
    label: 'إعلان يحتوي رابطاً لا يصبح طلباً',
  },
  {
    input: { text: 'من دوار الاول لصوفيه\nتوصيل 3' },
    expected: 'valid',
    label: 'طلب مسار وتسعيرة يبقى مؤهلاً',
  },
  {
    input: { text: '@49560130949346 معك طلب باشا' },
    expected: 'valid',
    label: 'إسناد صريح بطلب يبقى مؤهلاً',
  },
  {
    input: { text: 'دوار الشعب توصيل' },
    expected: 'valid',
    label: 'ذكر توصيل يجعل الرسالة طلباً مرشحاً لإيموجي صاحب الطلب',
  },
  {
    input: { text: 'الرابية دفع 0' },
    expected: 'valid',
    label: 'ذكر دفع يجعل الرسالة طلباً مرشحاً لإيموجي صاحب الطلب',
  },
  {
    input: { text: '3 اوردرات من حي عدن ل بيادر بيادر بيادر توصيلك 7.5' },
    expected: 'valid',
    label: 'صيغة توصيلك وقيمة 7.5 تصبح طلباً مؤهلاً',
  },
  {
    input: { text: 'كاش نقدي بال 50 او 60 + النخيل لـ جبل النظيف قليل' },
    expected: 'valid',
    label: 'قيمة رقمية مع مسار بين منطقتين تصبح طلباً مؤهلاً',
  },
  {
    input: { text: '٣ من الرابية إلى عبدون' },
    expected: 'valid',
    label: 'رقم عربي مع مسار بين منطقتين يصبح طلباً مؤهلاً',
  },
  {
    input: { text: 'سلط دبابنه ٠\nبيادر ٥' },
    expected: 'valid',
    expectedReason: 'numeric-value-with-two-free-route-areas',
    label: 'منطقتان حرتان مع رقم تصبحان طلباً مؤهلاً',
  },
  {
    input: { text: 'ماركا الجنوبية\nالمقابلين\n٣' },
    expected: 'valid',
    expectedReason: 'numeric-value-with-two-free-route-areas',
    label: 'منطقتان حرتان مفصولتان بأسطر مع رقم تصبحان طلباً مؤهلاً',
  },
  {
    input: { text: 'السابع خلف الموصلي 25\nام السماق 3\nمستلزمات تدخين' },
    expected: 'valid',
    expectedReason: 'numeric-value-with-two-free-route-areas',
    label: 'السابع خلف الموصلي وأم السماق مع رقم تصبح طلباً مؤهلاً',
  },
  {
    input: { text: 'البيادر ٢٠\nالسيتي مول ٣' },
    expected: 'valid',
    expectedReason: 'numeric-value-with-two-free-route-areas',
    label: 'البيادر والسيتي مول مع أرقام عربية تصبح طلباً مؤهلاً لا مراجعة',
  },
  {
    input: { text: 'مدينة النصر 5\nالجامعة 3\nاكسسوارات سيارات' },
    expected: 'valid',
    expectedReason: 'numeric-value-with-two-free-route-areas',
    label: 'أي منطقتين غير مدرجتين مسبقاً مع رقم تصبحان طلباً مؤهلاً',
  },
  {
    input: { text: 'معك كمان 3 طلبات' },
    expected: 'valid',
    expectedReason: 'additional-order-assignment',
    label: 'معك كمان 3 طلبات تصبح طلباً مستقلاً مؤهلاً',
  },
  {
    input: { text: 'ماركا الجنوبية المقابلين' },
    expected: 'review',
    label: 'منطقتان بلا رقم لا تصبحان طلباً تلقائياً',
  },
  {
    input: { text: 'إعلان: خدمة توصيل جديدة للجميع' },
    expected: 'invalid',
    label: 'إعلان يذكر توصيل يبقى مرفوضاً',
  },
  {
    input: { text: 'إعلان: خصم ٣ دنانير على خدمة التوصيل' },
    expected: 'invalid',
    label: 'إعلان يذكر قيمة رقمية وتوصيل يبقى مرفوضاً',
  },
  {
    input: { text: 'عرض خصم 3 دنانير على خدمة التوصيل 4' },
    expected: 'invalid',
    label: 'نص ترويجي بأرقام متعددة لا يتحول إلى طلب منطقتين',
  },
  {
    input: { text: '٣' },
    expected: 'review',
    label: 'قيمة رقمية بلا مسار أو توصيل لا تصبح طلباً',
  },
  {
    input: { text: 'شباب عند البوابة' },
    expected: 'review',
    label: 'صيغة غير واضحة تذهب للمراجعة بلا رصيد',
  },
  {
    input: { text: '', messageType: 'audio', isVoiceOrder: true },
    expected: 'valid',
    label: 'التسجيل الصوتي يبقى مؤهلاً وفق قاعدته الخاصة',
  },
];
originalOrderClassificationTests.forEach(({ input, expected, expectedReason, label }) => {
  const result = classifyOriginalOrder(input);
  const status = result.classification === expected && (!expectedReason || result.reason === expectedReason) ? '✅' : '❌';
  console.log(`  ${status} ${label} (${result.classification})`);
  if (result.classification !== expected || (expectedReason && result.reason !== expectedReason)) process.exitCode = 1;
});

// === اختبار صيغ التوصيل الطبيعية بلا كلمة «طلب» ===
console.log('\n🚕 اختبار استخراج صيغ المسار والدفع والتوصيل المختصرة:');
const naturalDeliveryOrderTests = [
  {
    input: 'بداية الرابية إلى الحسين، دفع 0، توصيل 3',
    expected: { from: 'بدايه الرابيه', to: 'الحسين', payment: 0, delivery: 3 },
    label: 'مسار مع دفع وتوصيل بلا كلمة طلب',
  },
  {
    input: 'تكسي من رابية الي خدا 4 مقطوع',
    expected: { from: 'رابيه', to: 'خدا', payment: null, delivery: 4 },
    label: 'تكسي من وإلى بقيمة مقطوع',
  },
  {
    input: 'تكسي من رابية الي خدا مقطوع',
    expected: null,
    label: 'مسار بلا أجرة يبقى للمراجعة',
  },
];
naturalDeliveryOrderTests.forEach(({ input, expected, label }) => {
  const details = extractDeliveryOrderDetails(input);
  const classification = classifyOriginalOrder({ text: input });
  const passed = expected
    ? details.isComplete && classification.classification === 'valid' &&
      details.from === expected.from && details.to === expected.to &&
      details.payment === expected.payment && details.delivery === expected.delivery
    : !details.isComplete && classification.classification === 'review';
  console.log(`  ${passed ? '✅' : '❌'} ${label}`);
  if (!passed) process.exitCode = 1;
});

async function runNaturalDeliveryOrderRuntimeTest() {
  console.log('\n🔬 اختبار تشغيل طلب طبيعي بلا كلمة طلب:');
  const naturalOrderMessage = {
    key: {
      id: 'test-natural-delivery-order',
      remoteJid: 'test-group@g.us',
      participant: '962798765432@s.whatsapp.net',
      fromMe: false,
    },
    message: { conversation: 'بداية الرابية إلى الحسين، دفع 0، توصيل 3' },
  };
  const result = await parser.processMessage(naturalOrderMessage, null);
  const details = result?.deliveryOrderDetails;
  const passed = result?.type === 'order' &&
    result.orderClassification === 'valid' &&
    details?.from === 'بدايه الرابيه' && details?.to === 'الحسين' &&
    details?.payment === 0 && details?.delivery === 3 && details?.isComplete === true;
  console.log(`  ${passed ? '✅' : '❌'} الطلب الطبيعي يمرر من وإلى والدفع والتوصيل إلى سياق التأكيد`);
  if (!passed) process.exitCode = 1;
}
const replyClassificationGuardIsApplied =
  serverSource.includes("result.orderClassification === 'invalid'") &&
  serverSource.includes("result.orderClassification === 'review'") &&
  serverSource.includes('رد على طلب غير واضح حُفظ للمراجعة بلا رصيد');
console.log(`  ${replyClassificationGuardIsApplied ? '✅' : '❌'} رد التحذير أو الطلب غير الواضح لا يدخل سجل تم ولا ينشئ رصيداً`);
if (!replyClassificationGuardIsApplied) process.exitCode = 1;

// === اختبار صلاحية تفاعل الكمية على رسالة «تم» ===
console.log('\n🔐 اختبار صلاحية صاحب التفاعل:');
const reactionAuthorizationTests = [
  {
    input: { reactorPhone: '962785891255', orderOwnerPhone: '785891255', isSupervisor: false },
    expected: true,
    label: 'صاحب الطلب يضع التفاعل',
  },
  {
    input: { reactorPhone: '962799999999', orderOwnerPhone: '785891255', isSupervisor: true },
    expected: true,
    label: 'المشرف المعتمد يضع التفاعل',
  },
  {
    input: { reactorPhone: '962788888888', orderOwnerPhone: '785891255', isSupervisor: false },
    expected: false,
    label: 'طرف ثالث لا يعتمد تفاعله',
  },
  {
    input: { reactorPhone: '962788888888', orderOwnerPhone: '', isSupervisor: false },
    expected: false,
    label: 'لا يعتمد التفاعل عند غياب صاحب الطلب',
  },
];
reactionAuthorizationTests.forEach(({ input, expected, label }) => {
  const result = authorizeQuantityReaction(input);
  const status = result.allowed === expected ? '✅' : '❌';
  console.log(`  ${status} ${label} (${result.reason})`);
  if (result.allowed !== expected) process.exitCode = 1;
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

const restartRequiredSavesNewAuth = connectionManagerSource.includes('this._pendingCredsSave = Promise.resolve()') &&
  connectionManagerSource.includes("sock.ev.on('creds.update', () => this._queueCredsSave())") &&
  connectionManagerSource.includes('code === DisconnectReason.restartRequired') &&
  connectionManagerSource.includes('await this._pendingCredsSave') &&
  connectionManagerSource.includes("_scheduleReconnect(1_000, reason || 'restartRequired')");
console.log(`  ${restartRequiredSavesNewAuth ? '✅' : '❌'} يحفظ QR الجديد قبل إعادة التشغيل المطلوبة`);
if (!restartRequiredSavesNewAuth) process.exitCode = 1;

// === اختبار عدم ضياع الطرف غير المسجل ===
console.log('\n🧾 اختبار الطرف غير المسجل:');
const sheetsSource = fs.readFileSync(path.join(__dirname, 'sheets.js'), 'utf8');
const parserSource = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');
const unknownPartyFallbackIsSafe = serverSource.includes('async function queueUnknownParty(phone, role)') &&
  serverSource.includes("return sheets.getRegisteredName(phone) || 'مجهول';") &&
  serverSource.includes("await sheets.logUnregisteredNumber(normalizedPhone, 'مجهول');") &&
  serverSource.includes('const producerParty = await queueUnknownParty(finalProducerPhone') &&
  serverSource.includes('const captainParty = await queueUnknownParty(resolvedCaptainForSheet') &&
  serverSource.includes('captainPhone: resolvedCaptainForSheet || \'\',') &&
  sheetsSource.includes("'رقم الكابتن'") &&
  sheetsSource.includes('review.captainPhone || \'\'') &&
  sheetsSource.includes('captainPhone: row[6] || \'\'') &&
  sheetsSource.includes('logUnregisteredNumber,');
console.log(`  ${unknownPartyFallbackIsSafe ? '✅' : '❌'} الرقم غير المسجل يُحفظ باسم مجهول في السجل والتفاصيل والمراجعة`);
if (!unknownPartyFallbackIsSafe) process.exitCode = 1;

const unresolvedOwnerIsSavedForReview =
  serverSource.includes('targetContextInfo.senderPn') &&
  serverSource.includes('targetContextInfo.participantPn') &&
  serverSource.includes("type: 'تفاعل كمية (هوية غير مكتملة)'") &&
  serverSource.includes('حُفظت العملية للمراجعة ولم تُسقط') &&
  serverSource.includes("status: '⏳ هوية غير مكتملة'");
console.log(`  ${unresolvedOwnerIsSavedForReview ? '✅' : '❌'} غياب رقم صاحب الطلب يُحفظ للمراجعة بدلاً من إسقاط التفاعل`);
if (!unresolvedOwnerIsSavedForReview) process.exitCode = 1;

// === اختبار حماية التفاعل على «تم» مستقلة ===
console.log('\n🛑 اختبار حارس التفاعل الذاتي:');
const standaloneAcceptReactionIsIgnored =
  serverSource.includes('parser.isStandaloneAcceptWithoutOrder(_targetTextEarly, _isTargetAReply)') &&
  serverSource.includes('تجاهل تفاعل على رسالة استلام مستقلة بلا طلب مقتبس');
console.log(`  ${standaloneAcceptReactionIsIgnored ? '✅' : '❌'} لا يُنشئ التفاعل على «تم» بلا طلب أي عملية`);
if (!standaloneAcceptReactionIsIgnored) process.exitCode = 1;

// === اختبار حماية الملصقات ===
console.log('\n🧷 اختبار حماية الملصقات:');
const stickerIsBlockedEverywhere =
  parserSource.includes("if (msgType === 'sticker')") &&
  parserSource.includes('تجاهل ملصق: لا يُحتسب كطلب أو حركة') &&
  parserSource.includes('contextInfo?.quotedMessage?.stickerMessage') &&
  serverSource.includes('_targetMsgObjEarly.stickerMessage') &&
  serverSource.includes('تجاهل تفاعل على ملصق: لا يُحتسب كطلب أو حركة');
console.log(`  ${stickerIsBlockedEverywhere ? '✅' : '❌'} الملصق والرد أو التفاعل عليه لا يصلان إلى الأرصدة`);
if (!stickerIsBlockedEverywhere) process.exitCode = 1;

// === اختبار قاعدة التسجيل الصوتي ===
console.log('\n🎙️ اختبار قاعدة التسجيل الصوتي:');
const voiceReplyRuleIsPersistent =
  parserSource.includes('const isVoiceReply = Boolean(contextInfo?.quotedMessage?.audioMessage);') &&
  parserSource.includes('voiceMessageId,') &&
  whatsappSource.includes('const voiceReplyCache = new Map();') &&
  whatsappSource.includes('function registerVoiceReply(voiceMessageId, replyMessageId') &&
  whatsappSource.includes('voiceReplyCache: voiceObj') &&
  serverSource.includes('getVoiceReplyStatusByReplyId') &&
  serverSource.includes('invalidateVoiceReplyTransactions') &&
  serverSource.includes('تجاهل تفاعل على تسجيل صوتي غير مؤهل');
console.log(`  ${voiceReplyRuleIsPersistent ? '✅' : '❌'} عدّاد الردود الصوتية دائم ويمنع التفاعل عند تعدد ردود تم`);
if (!voiceReplyRuleIsPersistent) process.exitCode = 1;

const voiceSingleEmojiGuardIsPresent =
  whatsappSource.includes('function addVoiceEmoji(replyMessageId, senderPhone, emoji)') &&
  whatsappSource.includes('function removeVoiceEmoji(replyMessageId, senderPhone)') &&
  whatsappSource.includes('emojiReactions:') &&
  serverSource.includes('invalidateVoiceEmojiTransaction') &&
  serverSource.includes('restoreVoiceEmojiTransaction') &&
  serverSource.includes('يجب وجود إيموجي كمية واحد فقط');
console.log(`  ${voiceSingleEmojiGuardIsPresent ? '✅' : '❌'} قاعدة إيموجي كمية واحد محفوظة وتبطل الحركة عند التعدد`);
if (!voiceSingleEmojiGuardIsPresent) process.exitCode = 1;

// === اختبار تعطيل تقرير نهاية الأسبوع ===
console.log('\n📊 اختبار تعطيل تقرير نهاية الأسبوع:');
const weeklyReportIsDisabled = config.sheets.weeklyReport?.enabled === false &&
  serverSource.includes("config.sheets.weeklyReport?.enabled === true");
console.log(`  ${weeklyReportIsDisabled ? '✅' : '❌'} التقرير لا يعمل يدوياً أو تلقائياً عندما يكون موقوفاً`);
if (!weeklyReportIsDisabled) process.exitCode = 1;

// === اختبار تشغيل فعلي: رسالة «تم» مستقلة لا تعبر محلل الرسائل ===
async function runStandaloneAcceptRuntimeTest() {
  console.log('\n🔬 اختبار تشغيل رسالة «تم» مستقلة:');
  const standaloneTam = {
    key: {
      id: 'test-standalone-tam-no-order',
      remoteJid: 'test-group@g.us',
      participant: '962798765432@s.whatsapp.net',
      fromMe: false,
    },
    message: { conversation: 'تم' },
  };
  const result = await parser.processMessage(standaloneTam, null);
  const ignored = result === null;
  console.log(`  ${ignored ? '✅' : '❌'} رسالة «تم» بلا رد على طلب لا تصل لمسار الأرصدة`);
  if (!ignored) process.exitCode = 1;
}

async function runStickerRuntimeTests() {
  console.log('\n🔬 اختبار تشغيل الملصقات:');
  const stickerMessage = {
    key: {
      id: 'test-sticker-not-an-order',
      remoteJid: 'test-group@g.us',
      participant: '962798765432@s.whatsapp.net',
      fromMe: false,
    },
    message: { stickerMessage: { fileSha256: Buffer.from('sticker') } },
  };
  const replyToSticker = {
    key: {
      id: 'test-reply-to-sticker-not-a-receipt',
      remoteJid: 'test-group@g.us',
      participant: '962798765433@s.whatsapp.net',
      fromMe: false,
    },
    message: {
      extendedTextMessage: {
        text: 'تم',
        contextInfo: {
          participant: '962798765432@s.whatsapp.net',
          stanzaId: 'test-sticker-not-an-order',
          quotedMessage: { stickerMessage: { fileSha256: Buffer.from('sticker') } },
        },
      },
    },
  };
  const [stickerResult, replyResult] = await Promise.all([
    parser.processMessage(stickerMessage, null),
    parser.processMessage(replyToSticker, null),
  ]);
  const ignored = stickerResult === null && replyResult === null;
  console.log(`  ${ignored ? '✅' : '❌'} الملصق والرد عليه لا يصلان لمسار الأرصدة`);
  if (!ignored) process.exitCode = 1;
}

async function runQuotedTextReplyRuntimeTests() {
  console.log('\n🔬 اختبار قبول أي رد نصي مقتبس على طلب نصي:');
  const replies = ['تم', 'تمم', 'تم 👇', 'تا', 'ت', 'تم ٢٠', 'تم رابية', 'tam', 'tm', 'باصي'];
  const results = await Promise.all(replies.map((text, index) => parser.processMessage({
    key: {
      id: `test-general-text-reply-${index}`,
      remoteJid: 'test-group@g.us',
      participant: '962798765433@s.whatsapp.net',
      fromMe: false,
    },
    message: {
      extendedTextMessage: {
        text,
        contextInfo: {
          participant: '962798765432@s.whatsapp.net',
          stanzaId: 'test-original-text-order',
          quotedMessage: { conversation: 'من دوار الثاني للشميساني، توصيل 3' },
        },
      },
    },
  }, null)));
  const accepted = results.every((result, index) =>
    result?.type === 'accept' &&
    result.text === replies[index] &&
    result.isVoiceReply === false &&
    result.orderClassification === 'valid'
  );
  console.log(`  ${accepted ? '✅' : '❌'} تم، تم 👇، تا، ت، تم ٢٠، تم رابية، tam، tm وأي نص مقتبس تصل كتأكيد مبدئي`);
  if (!accepted) process.exitCode = 1;

  const additionalOrderReply = await parser.processMessage({
    key: {
      id: 'test-additional-order-captain-reply',
      remoteJid: 'test-group@g.us',
      participant: '962798765433@s.whatsapp.net',
      fromMe: false,
    },
    message: {
      extendedTextMessage: {
        text: 'تم',
        contextInfo: {
          participant: '962798765432@s.whatsapp.net',
          stanzaId: 'test-additional-order-message',
          quotedMessage: { conversation: 'معك كمان 3 طلبات' },
        },
      },
    },
  }, null);
  const additionalOrderAccepted = additionalOrderReply?.type === 'accept' &&
    additionalOrderReply?.orderClassification === 'valid' &&
    additionalOrderReply?.orderClassificationReason === 'additional-order-assignment' &&
    additionalOrderReply?.quotedMessageId === 'test-additional-order-message';
  console.log(`  ${additionalOrderAccepted ? '✅' : '❌'} معك كمان 3 طلبات → تم مقتبس يصل لمسار إيموجي الكمية`);
  if (!additionalOrderAccepted) process.exitCode = 1;

  // صيغ تشغيلية فعلية اعتمدها المستخدم: لا نبحث عن كلمة ثابتة ما دامت الرسالة
  // رداً مقتبساً مباشراً على طلب مؤهل؛ إيموجي الكمية المخوّل يبقى شرط التسجيل المالي.
  const approvedNaturalCaptainReplies = [
    'تم عبي👆', 'تم 👆', 'تم دوار خلدا', 'تم دوار الشعب', 'بدر تم',
    'تم تنسيق شوي', 'تن', 'تم تنسيق', 'تم ثلث اي وقت', 'تم 20',
    'تم ١٥', '٢٠تم', 'تم مدينه رياضيه', 'تم ربع كلك', 'تم مدينه رياضيه بس',
    'معو وقت استلام', 'تم بعد', 'نتمتم', 'تم اذا بزبط بعد', 'تم جسر مادبا',
    'تم كليك وكاش', 'تم 🤍', 'تم رجوع تنسيق مش مباشر', 'تم تم تم',
    'تم مع الحوراني', 'تم لعيونك', 'تم 👆 ثلث', 'تم ربع ساعة', 'ثلث هات',
    'تم الان', 'هات', 'تم 10', 'تم عبدون', 'تم ثلث', 'تم واحه',
    'تم عشرين كلك', 'اذا بيجي باي ستار تم', 'تم بدن شنته', 'تم بدون شنته',
    'تم شنطة', 'تم لعيونك الاثنين', 'تم خارج المطار بحطه', 'تم ض الرشيد',
    'تم اذا مش اكل', 'تم أيونك', 'تم نوع سيارة', 'تم دوار المدينة',
    'تلاع العلي تم', 'تم عبدون بس اذا بزبط',
  ];
  const naturalReplyResults = await Promise.all(approvedNaturalCaptainReplies.map((text, index) =>
    parser.processMessage({
      key: {
        id: `test-approved-natural-captain-reply-${index}`,
        remoteJid: 'test-group@g.us',
        participant: '962798765433@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        extendedTextMessage: {
          text,
          contextInfo: {
            participant: '962798765432@s.whatsapp.net',
            stanzaId: 'test-original-qualified-order-natural-replies',
            quotedMessage: { conversation: 'من دوار الثاني للشميساني، توصيل 3' },
          },
        },
      },
    }, null)
  ));
  const allApprovedNaturalRepliesAccepted = naturalReplyResults.every((result, index) =>
    result?.type === 'accept' &&
    result.text === approvedNaturalCaptainReplies[index] &&
    result.orderClassification === 'valid' &&
    result.quotedMessageId === 'test-original-qualified-order-natural-replies'
  );
  console.log(`  ${allApprovedNaturalRepliesAccepted ? '✅' : '❌'} جميع صيغ الكابتن المعتمدة تمر عند اقتباس طلب مؤهل`);
  if (!allApprovedNaturalRepliesAccepted) process.exitCode = 1;

  const standaloneNaturalReplyResults = await Promise.all(
    ['تم دوار خلدا', 'بدر تم', 'معو وقت استلام', 'تلاع العلي تم'].map((text, index) =>
      parser.processMessage({
        key: {
          id: `test-natural-captain-reply-without-quote-${index}`,
          remoteJid: 'test-group@g.us',
          participant: '962798765433@s.whatsapp.net',
          fromMe: false,
        },
        message: { conversation: text },
      }, null)
    )
  );
  const noStandaloneNaturalReplyIsReceipt = standaloneNaturalReplyResults.every(
    (result) => result?.type !== 'accept'
  );
  console.log(`  ${noStandaloneNaturalReplyIsReceipt ? '✅' : '❌'} الصيغ نفسها بلا Reply لا تصبح تأكيداً أو حركة`);
  if (!noStandaloneNaturalReplyIsReceipt) process.exitCode = 1;

  const warningReply = await parser.processMessage({
    key: {
      id: 'test-reply-to-warning-no-ledger',
      remoteJid: 'test-group@g.us',
      participant: '962798765433@s.whatsapp.net',
      fromMe: false,
    },
    message: {
      extendedTextMessage: {
        text: 'تم',
        contextInfo: {
          participant: '962798765432@s.whatsapp.net',
          stanzaId: 'test-warning-post',
          quotedMessage: { conversation: 'تحذير: ممنوع التأكيد قبل الوصول إلى الاستلام' },
        },
      },
    },
  }, null);
  const warningIsClassifiedForRejection =
    warningReply?.type === 'accept' &&
    warningReply.orderClassification === 'invalid' &&
    warningReply.orderClassificationReason === 'general-post-or-announcement';
  console.log(`  ${warningIsClassifiedForRejection ? '✅' : '❌'} الرد المقتبس على تحذير يحمل وسم الرفض قبل سجل تم والأرصدة`);
  if (!warningIsClassifiedForRejection) process.exitCode = 1;
}

async function runVoiceReplyRuntimeTest() {
  console.log('\n🔬 اختبار تشغيل رد «تم» على تسجيل صوتي:');
  const voiceReply = {
    key: {
      id: 'test-voice-tam-reply',
      remoteJid: 'test-group@g.us',
      participant: '962798765433@s.whatsapp.net',
      fromMe: false,
    },
    message: {
      extendedTextMessage: {
        text: 'تم',
        contextInfo: {
          participant: '962798765432@s.whatsapp.net',
          stanzaId: 'test-original-voice-order',
          quotedMessage: { audioMessage: { ptt: true, seconds: 12 } },
        },
      },
    },
  };
  const result = await parser.processMessage(voiceReply, null);
  const tagged = result?.type === 'accept' && result.isVoiceReply === true && result.voiceMessageId === 'test-original-voice-order';
  console.log(`  ${tagged ? '✅' : '❌'} رد تم على تسجيل صوتي يحمل معرف التسجيل الأصلي`);
  if (!tagged) process.exitCode = 1;
}

// الرد النصي الواحد على تسجيل صوتي لا يرتبط بكلمة قبول محددة، لكنه يبقى
// خاضعاً لشرط الرد الوحيد والتفاعل الكمي المصرح به في server.js.
const voiceReplyAcceptsAnyText =
  serverSource.includes("String(result.text || '').trim().length > 0") &&
  !serverSource.includes('result.isVoiceReply && result.voiceMessageId && parser.isAcceptMessage(result.text)');
console.log(`  ${voiceReplyAcceptsAnyText ? '✅' : '❌'} رد التسجيل الصوتي يقبل أي نص مع بقاء شرط الرد الوحيد`);
if (!voiceReplyAcceptsAnyText) process.exitCode = 1;

async function runVoiceReplyStateTest() {
  console.log('\n🔬 اختبار عدّاد ردود التسجيل الصوتي:');
  const voiceMessageId = `test-voice-state-${Date.now()}`;
  const first = whatsapp.registerVoiceReply(voiceMessageId, `${voiceMessageId}-tam-1`, '962798765433');
  const second = whatsapp.registerVoiceReply(voiceMessageId, `${voiceMessageId}-tam-2`, '962798765434');
  const byReply = whatsapp.getVoiceReplyStatusByReplyId(`${voiceMessageId}-tam-1`);
  const invalidated = first?.replyCount === 1 && first.invalidated === false &&
    second?.replyCount === 2 && second.invalidated === true &&
    byReply?.replyMessageIds?.length === 2 && byReply.invalidated === true;
  console.log(`  ${invalidated ? '✅' : '❌'} الرد الثاني يبطل التسجيل الصوتي ويظل قابلاً للاستعلام بمعرف رد تم`);
  if (!invalidated) process.exitCode = 1;
}

async function runVoiceEmojiStateTest() {
  console.log('\n🔬 اختبار إيموجي الكمية الواحد على التسجيل الصوتي:');
  const voiceMessageId = `test-voice-emoji-${Date.now()}`;
  const replyMessageId = `${voiceMessageId}-tam-1`;
  whatsapp.registerVoiceReply(voiceMessageId, replyMessageId, '962798765433');

  const singleEmojiCases = [
    { emoji: '👍', quantity: 1 },
    { emoji: '1️⃣', quantity: 1 },
    { emoji: '2️⃣', quantity: 2 },
    { emoji: '6️⃣', quantity: 6 },
  ];
  const singlesValid = singleEmojiCases.every(({ emoji, quantity }, index) => {
    const voiceId = `${voiceMessageId}-single-${index}`;
    const replyId = `${voiceId}-tam`;
    whatsapp.registerVoiceReply(voiceId, replyId, '962798765433');
    const state = whatsapp.addVoiceEmoji(replyId, `9627987654${index}`, emoji);
    return state?.activeEmojiCount === 1 && state.singleEmoji === emoji && parser.extractQuantity(emoji) === quantity;
  });

  const one = whatsapp.addVoiceEmoji(replyMessageId, '962798765432', '6️⃣');
  const two = whatsapp.addVoiceEmoji(replyMessageId, '962798765431', '👍');
  const afterRemovingSecond = whatsapp.removeVoiceEmoji(replyMessageId, '962798765431');
  const replacingSamePerson = whatsapp.addVoiceEmoji(replyMessageId, '962798765432', '2️⃣');

  const correct =
    singlesValid &&
    one?.activeEmojiCount === 1 && one.singleEmoji === '6️⃣' &&
    two?.activeEmojiCount === 2 && two.singleEmoji === '' &&
    afterRemovingSecond?.activeEmojiCount === 1 && afterRemovingSecond.singleEmoji === '6️⃣' &&
    replacingSamePerson?.activeEmojiCount === 1 && replacingSamePerson.singleEmoji === '2️⃣';
  console.log(`  ${correct ? '✅' : '❌'} 👍 و1️⃣ و2️⃣ و6️⃣ منفردة تُقبل، والثاني يُبطل، وحذفه يعيد الإيموجي المتبقي`);
  if (!correct) process.exitCode = 1;
}

async function runDirectOrderEmojiStateTest() {
  console.log('\n🔬 اختبار قاعدة آخر إيموجي مباشر للطلب المؤهل:');
  const orderMessageId = `test-direct-order-${Date.now()}`;
  const replyMessageId = `${orderMessageId}-tam`;
  const first = whatsapp.setDirectOrderEmoji(orderMessageId, '962798765432', '👍', 1);
  const replacement = whatsapp.setDirectOrderEmoji(orderMessageId, '962798765432', '3️⃣', 3);
  whatsapp.setOrderForReply(replyMessageId, '962798765432', {
    orderMessageId,
    orderClassification: 'valid',
    orderText: 'من الرابية إلى الحسين توصيل 3',
  });
  const replyLink = whatsapp.getLatestReplyForOrder(orderMessageId);
  const supervisorReplacement = whatsapp.setDirectOrderEmoji(orderMessageId, '962799999999', '2️⃣', 2);
  const finalState = whatsapp.getDirectOrderEmoji(orderMessageId);
  const correct =
    first?.quantity === 1 &&
    replacement?.quantity === 3 &&
    replyLink?.replyMessageId === replyMessageId &&
    replyLink?.producer === '962798765432' &&
    supervisorReplacement?.quantity === 2 &&
    finalState?.quantity === 2 &&
    finalState?.emoji === '2️⃣';
  console.log(`  ${correct ? '✅' : '❌'} 👍 ثم 3️⃣ ثم 2️⃣ تعني 2 فقط، مع بقاء مفتاح الحركة رد الكابتن`);
  if (!correct) process.exitCode = 1;
  whatsapp.clearDirectOrderEmoji(orderMessageId);
}

runNaturalDeliveryOrderRuntimeTest()
  .then(runStandaloneAcceptRuntimeTest)
  .then(runStickerRuntimeTests)
  .then(runQuotedTextReplyRuntimeTests)
  .then(runVoiceReplyRuntimeTest)
  .then(runVoiceReplyStateTest)
  .then(runVoiceEmojiStateTest)
  .then(runDirectOrderEmojiStateTest)
  .catch((error) => {
    console.error('❌ فشل اختبار رسالة تم المستقلة:', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    console.log('\n═══════════════════════════════════════');
    console.log('   انتهى الاختبار');
    console.log('═══════════════════════════════════════');
  });
