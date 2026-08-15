import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeReviewAnswer, getReviewResolution } = require('./review-workflow.js');

assert.equal(normalizeReviewAnswer(' 1 '), '1');
assert.equal(normalizeReviewAnswer('2'), '2');
assert.equal(normalizeReviewAnswer('نعم'), '');
assert.equal(normalizeReviewAnswer('لا'), '');
assert.equal(normalizeReviewAnswer('ربما'), '');
assert.equal(normalizeReviewAnswer(''), '');

assert.deepEqual(getReviewResolution('1'), {
  action: 'approve',
  status: 'أضيف للطلبات',
  note: 'قرار 1: أُضيفت العملية بعد اعتماد المراجعة',
});
assert.deepEqual(getReviewResolution('2'), {
  action: 'reject',
  status: 'لا يضاف',
  note: 'قرار 2: لم تُضف العملية بعد رفض المراجعة',
});
assert.equal(getReviewResolution(''), null);

assert.equal(getReviewResolution('1').action, 'approve');
assert.equal(getReviewResolution('2').action, 'reject');

console.log('✅ اختبار تدفق مراجعة العمليات: نجح');
