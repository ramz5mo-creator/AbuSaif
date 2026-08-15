/**
 * حارس موحّد للتفاعل الكمي.
 *
 * لا يكفي أن تكون الرسالة المستهدفة "رداً" في messageCache؛ فذلك قد يكون
 * رداً على إعلان أو تحذير. التفاعل المالي صالح فقط إذا كان هدفه رد تأكيد
 * سبق توثيقه في tamCache أو في سجل_تم الدائم. الاستثناء الوحيد هو طلب
 * مؤهل فعلياً؛ عندها تحفظ كمية معلقة ولا يضاف رصيد قبل رد كابتن مقتبس.
 */
function validateQuantityReactionTarget({ captainFromTam, captainFromSheet, isQualifiedOrder = false, hasCaptainReply = false }) {
  if (captainFromTam) {
    return { allowed: true, source: 'tam-cache' };
  }

  if (captainFromSheet) {
    return { allowed: true, source: 'tam-sheet' };
  }

  if (isQualifiedOrder) {
    return {
      allowed: true,
      source: hasCaptainReply ? 'qualified-order-with-confirmation' : 'qualified-order-pending-confirmation',
      pendingConfirmation: !hasCaptainReply,
    };
  }

  return {
    allowed: false,
    reason: 'confirmation-not-recorded',
  };
}

module.exports = { validateQuantityReactionTarget };
