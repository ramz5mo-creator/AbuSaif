# مرجع تشخيص رمز الاقتران

## إرشاد Baileys الرسمي

تشير وثائق Baileys إلى أن رمز الاقتران لا يُطلب فور إنشاء Socket؛ بل عند حدث `connection.update` الذي يحمل `connection === 'connecting'` أو قيمة `qr`. وتؤكد أيضاً أن وصول حدث QR في مسار رمز الاقتران طبيعي ولا يلزم عرضه للمستخدم. يجب أن يكون الرقم بصيغة E.164 بلا علامة `+`.

بعد اعتماد الاقتران، يلزم حفظ تحديثات `creds.update` وإعادة إنشاء Socket إذا فرض واتساب إعادة التشغيل بسبب `restartRequired`؛ فهذا الانقطاع بعد نجاح الاقتران متوقع وليس تسجيل خروج.

## المراجع

1. [Baileys — Connecting](https://baileys.wiki/docs/socket/connecting/)
2. [Baileys — Pairing code](https://baileys.wiki/authentication/pairing-code)
