// تحقق قراءة فقط بعد تنظيف ورقة «المسجلين».
const sheets = require('./sheets');

async function main() {
  await sheets.initialize();
  const registered = await sheets.loadRegisteredUsers(true);
  const phones = [...registered.keys()];
  const uniquePhones = new Set(phones);
  const obaida = sheets.getRegisteredName('785891255');

  if (phones.length !== uniquePhones.size) {
    throw new Error(`فشل التحقق: الكاش يحوي ${phones.length - uniquePhones.size} رقماً مكرراً`);
  }
  if (!obaida) {
    throw new Error('فشل التحقق: لم يُحمَّل اسم الرقم 785891255');
  }

  console.log(JSON.stringify({
    success: true,
    registeredUniquePhones: phones.length,
    obaidaPhone: '785891255',
    obaidaRegisteredName: obaida,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
