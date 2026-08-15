/**
 * قواعد نقية لقراءة قرارات المراجعة اليدوية من Google Sheets.
 * لا تحتوي هذه الوحدة على أي كتابة أرصدة أو اتصال خارجي.
 */
function normalizeReviewAnswer(value) {
  const answer = String(value || '').trim();
  return answer === '1' || answer === '2' ? answer : '';
}

function getReviewResolution(answer) {
  if (answer === '1') {
    return {
      action: 'approve',
      status: 'أضيف للطلبات',
      note: 'قرار 1: أُضيفت العملية بعد اعتماد المراجعة',
    };
  }
  if (answer === '2') {
    return {
      action: 'reject',
      status: 'لا يضاف',
      note: 'قرار 2: لم تُضف العملية بعد رفض المراجعة',
    };
  }
  return null;
}

module.exports = { normalizeReviewAnswer, getReviewResolution };
