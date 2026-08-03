/**
 * setup-quick.js - إعداد سريع بدون Google Cloud Console
 * ================================
 * يُنشئ ملف oauth-credentials.json تلقائياً
 * باستخدام بيانات اعتماد OAuth عامة (Apps Script style).
 *
 * الاستخدام:
 *   node setup-quick.js
 *
 * ثم شغّل:
 *   node setup-auth.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CREDENTIALS_PATH = path.resolve('./oauth-credentials.json');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('   الإعداد السريع - OAuth Credentials');
  console.log('═══════════════════════════════════════\n');

  if (fs.existsSync(CREDENTIALS_PATH)) {
    console.log('⚠️  ملف oauth-credentials.json موجود بالفعل.');
    const overwrite = await ask('هل تريد استبداله؟ (y/n): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('تم الإلغاء.');
      rl.close();
      process.exit(0);
    }
  }

  console.log('لإنشاء OAuth Client ID:');
  console.log('');
  console.log('1. ادخل على: https://console.cloud.google.com/');
  console.log('2. أنشئ مشروع جديد (أو اختر موجود)');
  console.log('3. من القائمة: APIs & Services → Library');
  console.log('4. ابحث عن "Google Sheets API" وفعّلها');
  console.log('5. من القائمة: APIs & Services → Credentials');
  console.log('6. اضغط "+ CREATE CREDENTIALS" → "OAuth client ID"');
  console.log('7. إذا طلب منك "Configure consent screen":');
  console.log('   - اختر External → Create');
  console.log('   - App name: AbuSaif Bot');
  console.log('   - User support email: إيميلك');
  console.log('   - Developer email: إيميلك');
  console.log('   - اضغط Save and Continue حتى النهاية');
  console.log('8. ارجع لـ Credentials → Create OAuth client ID');
  console.log('9. Application type: Desktop app');
  console.log('10. Name: AbuSaif Bot');
  console.log('11. اضغط Create');
  console.log('12. ستظهر لك Client ID و Client Secret');
  console.log('');

  const clientId = await ask('أدخل Client ID: ');
  const clientSecret = await ask('أدخل Client Secret: ');

  if (!clientId || !clientSecret) {
    console.log('❌ يجب إدخال كلا القيمتين');
    rl.close();
    process.exit(1);
  }

  const credentials = {
    installed: {
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
      redirect_uris: ['http://localhost:3000/callback'],
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
    },
  };

  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));

  console.log('\n✅ تم إنشاء ملف oauth-credentials.json');
  console.log('\nالخطوة التالية:');
  console.log('   node setup-auth.js');
  console.log('');

  rl.close();
}

main().catch(console.error);
