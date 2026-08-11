/**
 * قواعد نقية لقراءة قرارات المراجعة اليدوية من Google Sheets.
 * لا تحتوي هذه الوحدة على أي كتابة أرصدة أو اتصال خارجي.
 */
function normalizeReviewAnswer(value) {
  const answer = String(value || '').trim();
  return answer === 'نعم' || answer === 'لا' ? answer : '';
}

function getReviewResolution(answer) {
  if (answer === 'نعم') {
    return {
      status: 'تم التأكيد — لا تعديل رصيد',
      note: 'رد مزامن: نعم',
    };
  }
  if (answer === 'لا') {
    return {
      status: 'يحتاج تصحيح يدوي — لا تعديل رصيد',
      note: 'رد مزامن: لا',
    };
  }
  return null;
}

module.exports = { normalizeReviewAnswer, getReviewResolution };
