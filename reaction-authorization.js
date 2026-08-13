/**
 * صلاحية اعتماد تفاعل الكمية على رسالة «تم».
 * لا تعتمد أي مقارنة على الاسم؛ رقم الهاتف هو مصدر الهوية الوحيد.
 */
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : '';
}

function isSamePhone(first, second) {
  const a = normalizePhone(first);
  const b = normalizePhone(second);
  return Boolean(a && b && a === b);
}

function authorizeQuantityReaction({ reactorPhone, orderOwnerPhone, isSupervisor = false }) {
  if (!normalizePhone(orderOwnerPhone)) {
    return { allowed: false, reason: 'unknown-order-owner' };
  }

  if (isSamePhone(reactorPhone, orderOwnerPhone)) {
    return { allowed: true, reason: 'order-owner' };
  }

  if (isSupervisor) {
    return { allowed: true, reason: 'supervisor' };
  }

  return { allowed: false, reason: 'third-party' };
}

module.exports = {
  normalizePhone,
  isSamePhone,
  authorizeQuantityReaction,
};
