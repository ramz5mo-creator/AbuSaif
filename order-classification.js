/**
 * يميّز بين طلب توصيل قابل للاحتساب، ومنشور عام مرفوض، وصيغة غير واضحة.
 * لا ينشئ هذا الملف أي حركة أو رصيد؛ القرار المالي يبقى في server.js.
 */

function normalizeOrderText(value) {
  const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
  return String(value || '')
    .toLowerCase()
    .replace(/[٠-٩]/g, digit => String(arabicDigits.indexOf(digit)))
    .replace(/[إأآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u0000-\u001F\u007F-\u009F\u0670]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyOriginalOrder({ text, messageType = 'text', isVoiceOrder = false } = {}) {
  if (isVoiceOrder || messageType === 'audio') {
    return { classification: 'valid', reason: 'voice-order' };
  }

  const normalized = normalizeOrderText(text);
  if (!normalized) {
    return { classification: 'review', reason: 'empty-or-non-text-original' };
  }

  const generalPostTerms = [
    'تحذير', 'تنبيه', 'اعلان', 'قواعد', 'تعليمات', 'نظامنا', 'نظام ',
    'عموله', 'اشتراك', 'كشفك', 'الخطوات', 'ممنوع', 'سياسه', 'مؤسسه',
  ];
  if (/https?:\/\/|www\./i.test(normalized) || generalPostTerms.some(term => normalized.includes(term))) {
    return { classification: 'invalid', reason: 'general-post-or-announcement' };
  }

  const hasNumber = /\d/.test(normalized);
  const hasOrderAssignment = /(?:معك|عندك)\s*(?:\d+\s*)?(?:طلب|طلبات)/.test(normalized);
  const hasRoute = /(?:من\s+\S[\s\S]{0,140}(?:\s+(?:الى|الي|لـ|ل|لل)\s*)\S)|(?:\S+\s+(?:الى|الي|لـ|ل|لل)\s+\S)/.test(normalized);
  const hasDeliveryDetail = /(?:توصيل|دفع|مقطوع|سكوتر|مباشر|كليك|استلام|تسليم)/.test(normalized);

  if (hasOrderAssignment || (hasNumber && (hasRoute || hasDeliveryDetail))) {
    return { classification: 'valid', reason: hasOrderAssignment ? 'explicit-order-assignment' : 'route-or-delivery-details' };
  }

  return { classification: 'review', reason: 'insufficient-order-evidence' };
}

module.exports = { classifyOriginalOrder, normalizeOrderText };
