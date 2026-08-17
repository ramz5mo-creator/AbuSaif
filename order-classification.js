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

function toAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function extractLabeledAmount(text, labels) {
  const labelsPattern = labels.join('|');
  const match = new RegExp(`(?:${labelsPattern})\\s*[:：=-]?\\s*(\\d+(?:\\.\\d+)?)`, 'i').exec(text);
  return toAmount(match?.[1]);
}

// أسماء شائعة لتحسين التعرّف فقط؛ لا يشترط النظام أن تكون المنطقة ضمن هذه القائمة.
// يُستكمل ذلك بمعيار عام لاستخراج عبارتين مكانيّتين مرتبطتين برقم.
const FREE_ROUTE_LOCALITIES = [
  { key: 'السابع', terms: ['السابع', 'سابع'] },
  { key: 'أم السماق', terms: ['ام السماق', 'ام السمانق'] },
  { key: 'الملكية', terms: ['الملكيه', 'ملكيه'] },
  { key: 'غوشة', terms: ['غوشه'] },
  { key: 'السلط', terms: ['السلط', 'سلط'] },
  { key: 'الدبابنة', terms: ['الدبابنه', 'دبابنه'] },
  { key: 'البيادر', terms: ['البيادر', 'بيادر'] },
  { key: 'السيتي مول', terms: ['السيتي مول', 'سيتي مول'] },
  { key: 'ماركا الجنوبية', terms: ['ماركا الجنوبيه', 'ماركا'] },
  { key: 'المقابلين', terms: ['المقابلين'] },
  { key: 'الرابية', terms: ['الرابيه', 'رابيه'] },
  { key: 'عبدون', terms: ['عبدون'] },
  { key: 'خلدا', terms: ['خلدا'] },
  { key: 'الجبيهة', terms: ['الجبيهه', 'جبيهه'] },
  { key: 'الصويفية', terms: ['الصويفيه', 'صويفيه'] },
  { key: 'النخيل', terms: ['النخيل'] },
  { key: 'جبل النظيف', terms: ['جبل النظيف'] },
  { key: 'الحسين', terms: ['الحسين'] },
  { key: 'خدا', terms: ['خدا'] },
];

/** يستخرج مناطق معروفة من نص حر لا يستعمل «من/إلى». */
function extractFreeRouteAreas(value) {
  const searchable = ` ${normalizeOrderText(value).replace(/[،,;:()\-–—]+/g, ' ')} `;
  return FREE_ROUTE_LOCALITIES
    .filter(({ terms }) => terms.some(term => searchable.includes(` ${term} `)))
    .map(({ key }) => key);
}

/**
 * يستخرج أي عبارتين مكانيّتين ظاهرياً من صيغة «اسم موقع ... رقم».
 * العبارة من كلمة إلى ثلاث كلمات عربية أمام رقم، ولا يشترط أن تكون ضمن قائمة أسماء.
 * لا ينشئ هذا الدليل أي رصيد بمفرده؛ الرد المقتبس والإيموجي المخوّل ما زالا إلزاميين.
 */
function extractNumberedRouteAreaCandidates(value) {
  const searchable = normalizeOrderText(value).replace(/[،,;:()\-–—]+/g, ' ');
  const pattern = /(?:^|\s)((?:\p{L}{2,}\s+){1,3})\d+(?:\.\d+)?(?=\s|$)/gu;
  const areas = [];
  for (const match of searchable.matchAll(pattern)) {
    const candidate = match[1].trim().replace(/\s+/g, ' ');
    if (candidate && !areas.includes(candidate)) areas.push(candidate);
  }
  return areas;
}

/**
 * يستخرج بيانات التوصيل من صياغة طبيعية؛ لا يتطلب كلمة «طلب».
 * مثالان مدعومان:
 * - بداية الرابية إلى الحسين، دفع 0، توصيل 3
 * - تكسي من رابية إلى خدا 4 مقطوع
 */
function extractDeliveryOrderDetails(value) {
  const text = normalizeOrderText(value);
  if (!text) return { from: '', to: '', payment: null, delivery: null, isComplete: false };

  const routeMatch = /(?:^|[\n،,;]\s*|\s)(?:(?:تكسي|تاكسي)\s+)?(?:من\s+)?(.+?)\s+(?:الى|الي|لل|لـ|ل)\s*(.+?)(?=\s*(?:[\n،,;]|(?:دفع|الدفع|توصيل|توصيلك|التوصيله|مقطوع|المقطوع|سعر|اجره|استلام|تسليم)\s*[:：=-]?\s*\d|\d+(?:\.\d+)?\s+مقطوع)|$)/i.exec(text);
  const from = (routeMatch?.[1] || '').trim();
  const to = (routeMatch?.[2] || '').trim();
  const payment = extractLabeledAmount(text, ['دفع', 'الدفع']);
  let delivery = extractLabeledAmount(text, ['توصيل', 'توصيلك', 'التوصيله', 'مقطوع', 'المقطوع', 'سعر', 'اجره']);
  if (delivery === null) {
    const fixedFareMatch = /(\d+(?:\.\d+)?)\s+مقطوع/.exec(text);
    delivery = toAmount(fixedFareMatch?.[1]);
  }

  return {
    from,
    to,
    payment,
    delivery,
    // اكتمال مسار واضح مع أجرة يجعل الرسالة طلباً؛ الدفع اختياري وقد تكون قيمته 0.
    isComplete: Boolean(from && to && delivery !== null),
  };
}

function classifyOriginalOrder({ text, messageType = 'text', isVoiceOrder = false } = {}) {
  if (isVoiceOrder || messageType === 'audio') {
    return { classification: 'valid', confidenceLevel: 'clear', reason: 'voice-order' };
  }

  const normalized = normalizeOrderText(text);
  if (!normalized) {
    return { classification: 'review', confidenceLevel: 'ambiguous', reason: 'empty-or-non-text-original' };
  }

  const generalPostTerms = [
    'تحذير', 'تنبيه', 'اعلان', 'قواعد', 'تعليمات', 'نظامنا', 'نظام ',
    'عموله', 'اشتراك', 'كشفك', 'الخطوات', 'ممنوع', 'سياسه', 'مؤسسه',
    'عرض', 'خصم', 'خدمه توصيل',
  ];
  if (/https?:\/\/|www\./i.test(normalized) || generalPostTerms.some(term => normalized.includes(term))) {
    return { classification: 'invalid', confidenceLevel: 'blocked', reason: 'general-post-or-announcement' };
  }

  const hasOrderAssignment = /(?:معك|عندك)\s*(?:\d+\s*)?(?:طلب|طلبات)/.test(normalized);
  // صيغة متابعة طلب مؤكد: «معك كمان 3 طلبات». تعد طلباً مستقلاً بالقيمة المذكورة.
  const hasAdditionalOrderAssignment = /(?:معك|عندك)\s*(?:كمان|ايضا)\s*(?:\d+\s*)?(?:طلب|طلبات)/.test(normalized);
  const deliveryDetails = extractDeliveryOrderDetails(normalized);
  // قرار المستخدم: ذكر «توصيل» أو «توصيلك» أو «دفع» يكفي لاعتبار الرسالة طلباً مرشحاً؛
  // لا تنشأ حركة إلا لاحقاً مع رد الكابتن المقتبس وإيموجي كمية مخوّل.
  // يبقى فحص التحذيرات والإعلانات أعلاه سابقاً على هذا الاستثناء.
  const hasDeliveryOrPaymentKeyword = /(?:^|[\s،,:;])(?:توصيل(?:ه|ك)?|دفع|الدفع)(?=$|[\s،,:;\d])/.test(normalized);
  // لا تكفي القيمة الرقمية وحدها؛ لا بد من مسار واضح بين منطقتين أو من سياق توصيل.
  // فحص المنشورات العامة يقع أعلاه، لذلك لا يتحول الإعلان الرقمي إلى طلب.
  const hasNumericValue = /\d+(?:\.\d+)?/.test(normalized);
  const hasRouteContext = Boolean(deliveryDetails.from && deliveryDetails.to);
  // صيغة الجروبات الحرة: أي منطقتين مع رقم، سواء كانتا ضمن قائمة معروفة أم لا.
  // لا يترتب عليها رصيد بمفردها؛ ما زال يلزم رد كابتن مقتبس وإيموجي كمية مخوّل لاحقاً.
  const knownFreeRouteAreas = extractFreeRouteAreas(normalized);
  const numberedRouteAreaCandidates = extractNumberedRouteAreaCandidates(normalized);
  const hasFreeRouteWithNumber = hasNumericValue && (
    knownFreeRouteAreas.length >= 2 || numberedRouteAreaCandidates.length >= 2
  );
  const hasNumericOrderContext = hasNumericValue && (hasRouteContext || hasDeliveryOrPaymentKeyword || hasFreeRouteWithNumber);

  // المستوى الواضح: صياغة الطلب نفسها تقدم دليلاً مكتفياً (تكليف صريح،
  // مسار كامل مع أجرة، أو منطقتان ورقم). ما زال الرد المباشر والإيموجي
  // المخوّل شرطين مستقلين في server.js قبل أي أثر مالي.
  if (hasOrderAssignment || hasAdditionalOrderAssignment || deliveryDetails.isComplete || hasDeliveryOrPaymentKeyword || hasFreeRouteWithNumber) {
    return {
      classification: 'valid',
      confidenceLevel: 'clear',
      reason: hasAdditionalOrderAssignment
        ? 'additional-order-assignment'
        : hasOrderAssignment
        ? 'explicit-order-assignment'
        : deliveryDetails.isComplete
          ? 'complete-route-and-delivery'
          : hasDeliveryOrPaymentKeyword
            ? 'delivery-or-payment-keyword'
            : 'numeric-value-with-two-free-route-areas',
      deliveryDetails,
    };
  }

  // المستوى الطبيعي المختصر: دليلان تشغيليان أو مكانيان مثل «توصيلك 7.5»
  // أو مسار من/إلى مع قيمة. هذه الصيغ تُعتمد عند اكتمال السلسلة أيضاً.
  if ((hasDeliveryOrPaymentKeyword && hasNumericValue) || (hasRouteContext && hasNumericValue) || hasNumericOrderContext) {
    return {
      classification: 'valid',
      confidenceLevel: 'natural',
      reason: hasDeliveryOrPaymentKeyword
        ? 'natural-operational-evidence'
        : 'natural-location-and-number-evidence',
      deliveryDetails,
    };
  }

  // لا نسقط الإشارات الضعيفة؛ يُحفظ الرد أولاً، ثم عند اكتمال الرد والإيموجي
  // يوجّه server.js السلسلة إلى مراجعة تفصيلية بلا تغيير للأرصدة.
  return { classification: 'review', confidenceLevel: 'ambiguous', reason: 'insufficient-order-evidence', deliveryDetails };
}

module.exports = {
  classifyOriginalOrder,
  extractDeliveryOrderDetails,
  extractFreeRouteAreas,
  extractNumberedRouteAreaCandidates,
  normalizeOrderText,
};
