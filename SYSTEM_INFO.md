# معلومات النظام

## GitHub
- Repo: https://github.com/ramz5mo-creator/AbuSaif.git
- PAT: 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

## Railway
- Project: proud-inspiration / AbuSaif
- URL: abusaif-production.up.railway.app
- Port: 3000

## Google Sheets
- Spreadsheet ID: 15gDbpqB0e8BwX5G8S9QqCeUPg8WLZPpYukSF1mHplp0
- أوراق: الاجمالي, الطلبات, سجل الحركات, الإعدادات, الأرصدة, سجل_تم مع هذه الرؤوس

## المشاكل المحلولة
1. Railway Trial انتهت → ترقية Hobby
2. QR لا يظهر → خادم ويب يعرض QR كصورة
3. "تم ثلث" لا تُتعرف → أي شيء يبدأ بتم = accept

## المشاكل المتبقية
1. أرقام الهاتف تأتي كـ LID (ليست أرقام حقيقية) → يجب استخدام groupMetadata
2. كل يوم بورقة منفصلة → إنشاء ورقة يومية تلقائياً
3. الانقطاعات (440 conflict) → تحسين إدارة الجلسة

## هيكل الورقة اليومية المطلوب
- اسم الورقة: التاريخ (مثل "2026-08-04")
- A: الهاتف
- B: #الانتاج
- C: الاستلام

## Config
- targetGroupId: 120363401940570759@g.us
- defaultAcceptWords: ['تم', 'هات', 'تن', 'اوك']
- authPath: ./auth
