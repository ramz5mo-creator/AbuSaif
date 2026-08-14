/**
 * حارس موحّد للتفاعل الكمي.
 *
 * لا يكفي أن تكون الرسالة المستهدفة "رداً" في messageCache؛ فذلك قد يكون
 * رداً على إعلان أو تحذير. التفاعل المالي صالح فقط إذا كان هدفه رد تأكيد
 * سبق توثيقه في tamCache أو في سجل_تم الدائم.
 */
function validateQuantityReactionTarget({ captainFromTam, captainFromSheet }) {
  if (captainFromTam) {
    return { allowed: true, source: 'tam-cache' };
  }

  if (captainFromSheet) {
    return { allowed: true, source: 'tam-sheet' };
  }

  return {
    allowed: false,
    reason: 'confirmation-not-recorded',
  };
}

module.exports = { validateQuantityReactionTarget };
