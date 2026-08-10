# دليل التكامل — AbuSaif v5 (Self-Healing + Recovery)

## الملفات الجديدة

| الملف | الوصف |
|---|---|
| `connection-manager.js` | مدير الاتصال المستقل — Self-Healing + Exponential Backoff |
| `recovery-service.js` | نظام Recovery المستقل لكل جروب + منع التكرار |
| `health-monitor.js` | مراقب الصحة المستقل |
| `whatsapp.js` | **استبدل الملف القديم بالكامل** |
| `server.js` | **استبدل الملف القديم بالكامل** (بعد دمج الأجزاء المفقودة) |

---

## خطوات التكامل

### الخطوة 1: نسخ الملفات الجديدة

```bash
cp connection-manager.js /path/to/project/
cp recovery-service.js   /path/to/project/
cp health-monitor.js     /path/to/project/
cp whatsapp.js           /path/to/project/   # استبدال كامل
```

### الخطوة 2: دمج server.js

ملف `server.js` الجديد يحتوي على تعليقات تشير إلى أجزاء يجب نسخها من v4:

**أ. كود `cancel` (الإلغاء ❌):**
- في v4: السطور 1164–1394
- انسخها في v5 في مكان التعليق: `// ← نفس كود الإلغاء من v4`

**ب. كود `remove` (الحذف):**
- في v4: بعد كود cancel
- انسخها في v5 في مكان التعليق: `// ← نفس كود الحذف من v4`

**ج. كود `supervisor` (أوامر المشرف):**
- في v4: السطور 1397–1465
- انسخها في v5 في مكان التعليق: `// ← نفس كود supervisor من v4`

**د. API endpoints في HTTP server:**
- في v4: السطور 220–733 (dashboard, api/registered-lid-status, api/group-members, map-lid, force-sync-lids, unresolved-lids, members-db...)
- انسخها في v5 في مكان التعليقات المقابلة

### الخطوة 3: إضافة دوال جديدة في whatsapp.js

أضف هذه الدوال المُصدَّرة في نهاية `whatsapp.js` (قبل `module.exports`):

```javascript
// للوصول من server.js
function getConnectionManager() {
  return connectionManager;
}

function getRecoveryStats() {
  return recoveryService.getStats();
}

function isConnected() {
  return connectionManager.isConnected();
}
```

وأضفها في `module.exports`:
```javascript
module.exports = {
  // ... الدوال الحالية ...
  getConnectionManager,
  getRecoveryStats,
  isConnected,
};
```

---

## كيف يعمل النظام الجديد

### تدفق الاتصال (Self-Healing)

```
server.js
  └─ whatsapp.connect()
       └─ connectionManager.start()
            ├─ إنشاء Socket (Baileys)
            ├─ connection.update → open  → emit CONNECTED
            │                   → close → تحديد السبب
            │                           → emit DISCONNECTED
            │                           → scheduleReconnect (Exponential Backoff)
            └─ healthMonitor.start() → فحص كل 30 ثانية
```

### تدفق Recovery بعد إعادة الاتصال

```
RECONNECTED
  └─ _onConnected(sock, isReconnect=true)
       └─ setTimeout(3000)
            └─ recoveryService.runRecovery(sock)
                 ├─ loadCursors() ← من recovery-cursors.json على Railway Volume
                 ├─ للجروب 1: _recoverGroup(sock, group1)
                 │    ├─ fetchMissedMessages(منذ آخر مؤشر)
                 │    ├─ فرز بالترتيب الزمني
                 │    └─ لكل رسالة:
                 │         ├─ isProcessed(msgId)? → تخطي
                 │         ├─ markProcessed(msgId)
                 │         └─ messageHandler(msg, sock) ← نفس pipeline server.js
                 ├─ للجروب 2: مستقل تماماً
                 ├─ للجروب 3: مستقل تماماً
                 └─ saveCursors() ← حفظ دائم
```

### منع Duplicate Processing

طبقتان مستقلتان:
1. **في whatsapp.js** (السطر 226): `recoveryService.isProcessed(msgId)` قبل أي معالجة
2. **في server.js** (أول سطرين في messageHandler): فحص ثانٍ + `markProcessed` فوري

---

## سجلات الحالة المتوقعة

```
[CM] ✅ CONNECTED | 2026-08-10T10:00:00.000Z
[CM] ⚡ DISCONNECTED | 2026-08-10T10:10:00.000Z | CONNECTION_LOST
[CM] 🔄 RECONNECTING | 2026-08-10T10:10:03.000Z | محاولة 1 | بعد 5ث
[CM] ✅ RECONNECTED | 2026-08-10T10:10:08.000Z | بعد 1 محاولة
[Recovery] 🔄 RECOVERY_STARTED | 2026-08-10T10:10:11.000Z
[Recovery] 📥 جروب1 | منذ: 2026-08-10T10:00:00.000Z
[Recovery] 📦 جروب1 | وجد 15 رسالة فائتة
[Recovery] ✅ جروب1 | مسترجع: 12 | مكرر: 3 | أخطاء: 0
[Recovery] ✅ RECOVERY_COMPLETED | 2026-08-10T10:10:15.000Z | مسترجع: 12 | مكرر: 3
```

---

## اختبار السيناريو المطلوب

**البوت يعمل → ينقطع 10 دقائق → يعود:**

1. شغّل البوت وتأكد من ظهور `CONNECTED`
2. أوقف الشبكة أو أعد تشغيل Railway
3. راقب: `DISCONNECTED` → `RECONNECTING` (محاولات متتالية)
4. أعد الشبكة وراقب: `RECONNECTED` → `RECOVERY_STARTED` → `RECOVERY_COMPLETED`
5. تحقق من `/status` في المتصفح لرؤية إحصائيات Recovery

**محاكاة انقطاع الشبكة في Railway:**
```bash
# في Railway: أوقف الخدمة مؤقتاً ثم أعدها
# أو: أضف متغير بيئة SIMULATE_DISCONNECT=1 وأزله بعد دقيقة
```

---

## ملفات Railway Volume المطلوبة

يجب أن يكون `VOLUME_PATH` مضبوطاً في Railway ليشير إلى Volume دائم:

```
/data/
  ├── auth/                    ← جلسة Baileys (موجودة)
  ├── lid-map.json             ← خريطة LID→Phone (موجودة)
  └── recovery-cursors.json   ← مؤشرات Recovery (جديد — يُنشأ تلقائياً)
```

---

## ملاحظات مهمة

- **tamCache** يبقى Cache مؤقت في الذاكرة — لا يُحفظ على القرص
- **recovery-cursors.json** هو المصدر الدائم لمؤشرات Recovery
- **Google Sheets** هو المصدر الدائم للبيانات المالية
- عند `LOGGED_OUT` أو `BAD_SESSION`: احذف مجلد `auth/` وأعد مسح QR
- عند توقف Node.js بالكامل: Railway Restart Policy تعيد التشغيل تلقائياً
