/**
 * config.js - إعدادات النظام
 * ================================
 * يحتوي على جميع الإعدادات الأساسية للنظام.
 * كلمات الاستلام تُحمّل من Google Sheets لاحقاً،
 * لكن هنا القيم الافتراضية في حال عدم توفر الاتصال.
 */

// ====================================================
// مسار التخزين الدائم (Railway Volume)
// الـ Volume مربوط بـ /app/auth في Railway
// الكود يحفظ في VOLUME_PATH مباشرة، ومجلد auth/session داخله
// ====================================================
const VOLUME_PATH = process.env.VOLUME_PATH || '/app/auth';

module.exports = {
  // مسار التخزين الدائم (يُستخدم في جميع أنحاء النظام)
  volumePath: VOLUME_PATH,

  // === إعدادات واتساب ===
  whatsapp: {
    // الجروبات المستهدفة
    targetGroups: [
      { id: '120363401940570759@g.us', name: 'Dreamex', prefix: 'دريمكس' },
      { id: '120363408380060992@g.us', name: 'Nashama', prefix: 'نشامى' },
      { id: '120363407744839853@g.us', name: 'AlSaif', prefix: 'السيف' }
    ],
    // مسار حفظ جلسة واتساب — الـ Volume مربوط بـ /app/auth مباشرة، فنحفظ جلسة في مجلد فرعي session
    authPath: `${VOLUME_PATH}/session`,
  },

  // === إعدادات Google Sheets ===
  sheets: {
    // معرف الجدول (Spreadsheet ID)
    spreadsheetId: process.env.SPREADSHEET_ID || '15gDbpqB0e8BwX5G8S9QqCeUPg8WLZPpYukSF1mHplp0',
    // أسماء الأوراق
    sheetNames: {
      orders: 'الطلبات',           // ورقة الطلبات
      transactions: 'سجل الحركات', // سجل كل العمليات
      orderDetails: 'تفاصيل الطلبات', // تفاصيل كل طلب: المنتج والكابتن والنص والحالة
      operationReviews: 'مراجعة العمليات', // قرارات المراجعة اليدوية بنعم/لا
      settings: 'الإعدادات',       // ورقة الإعدادات (كلمات الاستلام وغيرها)
      balances: 'الأرصدة',         // أرصدة الكباتن
      totals: 'الاجمالي',          // الإجمالي: الهاتف + موجب + سالب
      tamLog: 'سجل_تم مع هذه الرؤوس',  // سجل رسائل تم (للاستعادة بعد إعادة الاتصال)
      weeklyReport: 'نهاية الاسبوع',    // كشف نهاية الأسبوع
      registeredUsers: 'المسجلين',      // الأرقام المعتمدة
      unregisteredNumbers: 'أرقام غير مسجلة', // الأرقام للمراجعة
      editLog: 'سجل التعديلات',          // سجل كل عمليات التعديل
    },
    // إعدادات التعديل
    editRules: {
      userEditHours: 24,     // الجميع يمكنهم التعديل خلال 24 ساعة
      supervisorEditHours: 168, // المشرف يمكنه التعديل خلال الأسبوع (168 ساعة)
    },
    weeklyReport: {
      cutoffDay: 5,    // الجمعة (0: الأحد, 5: الجمعة)
      cutoffHour: 23,   // 11:00 مساءً
      cutoffMinute: 0
    },
  },

  // === كلمات الاستلام الافتراضية ===
  // تُحمّل من Google Sheets عند بدء التشغيل
  // وتُحدّث دورياً
  defaultAcceptWords: ['تم', 'هات', 'تن', 'اوك'],

  // === إعدادات السجل ===
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    logsPath: `${VOLUME_PATH}/logs`,
  },

  // === إعدادات عامة ===
  general: {
    // الفاصل الزمني لتحديث الإعدادات من Sheets (بالمللي ثانية)
    settingsRefreshInterval: 5 * 60 * 1000, // 5 دقائق
    // الفاصل الزمني لإعادة المحاولة عند فشل الاتصال
    reconnectInterval: 10 * 1000, // 10 ثوانٍ
  },
};
