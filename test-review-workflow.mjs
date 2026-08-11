import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeReviewAnswer, getReviewResolution } = require('./review-workflow.js');

assert.equal(normalizeReviewAnswer(' نعم '), 'نعم');
assert.equal(normalizeReviewAnswer('لا'), 'لا');
assert.equal(normalizeReviewAnswer('ربما'), '');
assert.equal(normalizeReviewAnswer(''), '');

assert.deepEqual(getReviewResolution('نعم'), {
  status: 'تم التأكيد — لا تعديل رصيد',
  note: 'رد مزامن: نعم',
});
assert.deepEqual(getReviewResolution('لا'), {
  status: 'يحتاج تصحيح يدوي — لا تعديل رصيد',
  note: 'رد مزامن: لا',
});
assert.equal(getReviewResolution(''), null);

// اختيار المستخدم لا يحمل أي قيمة كمية، لذلك لا يمكن أن يسبب تعديل رصيد.
assert.equal(Object.hasOwn(getReviewResolution('نعم'), 'quantity'), false);
assert.equal(Object.hasOwn(getReviewResolution('لا'), 'quantity'), false);

console.log('✅ اختبار تدفق مراجعة العمليات: نجح');
