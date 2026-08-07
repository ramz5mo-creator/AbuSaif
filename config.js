/**
 * config.js - إعدادات النظام
 * ================================
 * يحتوي على جميع الإعدادات الأساسية للنظام.
 * كلمات الاستلام تُحمّل من Google Sheets لاحقاً،
 * لكن هنا القيم الافتراضية في حال عدم توفر الاتصال.
 */

// ====================================================
// مسار التخزين الدائم (Railway Volume أو المجلد المحلي)
// عند إضافة Volume في Railway، اضبط:
//   VOLUME_PATH=/data   (أو أي مسار تختاره للـ Volume)
// إذا لم يكن VOLUME_PATH موجوداً، يُستخدم المجلد المحلي ./data
// ====================================================
const VOLUME_PATH = process.env.VOLUME_PATH || './data';

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
    // مسار حفظ جلسة واتساب — يستخدم VOLUME_PATH إذا كان متاحاً
    authPath: `${VOLUME_PATH}/auth/session`,
  },

  // === إعدادات Google Sheets ===
  sheets: {
    // معرف الجدول (Spreadsheet ID)
    spreadsheetId: process.env.SPREADSHEET_ID || '15gDbpqB0e8BwX5G8S9QqCeUPg8WLZPpYukSF1mHplp0',
    // أسماء الأوراق
    sheetNames: {
      orders: 'الطلبات',           // ورقة الطلبات
      transactions: 'سجل الحركات', // سجل كل العمليات
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
