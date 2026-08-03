/**
 * setup-auth.js - إعداد المصادقة مع Google
 * ================================
 * شغّل هذا الملف مرة واحدة فقط لتسجيل الدخول.
 * يدعم طريقتين:
 *   1. localhost callback (تلقائي على جهازك)
 *   2. نسخ/لصق الكود يدوياً (إذا كنت على سيرفر)
 *
 * الاستخدام:
 *   node setup-auth.js
 *   node setup-auth.js --manual   (للطريقة اليدوية)
 */

const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { exec } = require('child_process');

const TOKEN_PATH = path.resolve('./token.json');
const CREDENTIALS_PATH = path.resolve('./oauth-credentials.json');
const PORT = 3000;

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

const isManual = process.argv.includes('--manual');

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('   إعداد المصادقة مع Google Sheets');
  console.log('═══════════════════════════════════════\n');

  // التحقق من وجود ملف بيانات الاعتماد
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.log('❌ ملف oauth-credentials.json غير موجود!\n');
    console.log('شغّل: node setup-quick.js أولاً\n');
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_id, client_secret } = credentials.installed || credentials.web || {};

  if (!client_id || !client_secret) {
    console.log('❌ ملف oauth-credentials.json غير صالح');
    process.exit(1);
  }

  if (isManual) {
    await manualAuth(client_id, client_secret);
  } else {
    await localServerAuth(client_id, client_secret);
  }
}

/**
 * الطريقة اليدوية - نسخ/لصق الكود
 */
async function manualAuth(client_id, client_secret) {
  const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('📋 افتح هذا الرابط في المتصفح:\n');
  console.log(authUrl);
  console.log('\n');
  console.log('بعد تسجيل الدخول والموافقة، سيظهر لك كود.');
  console.log('انسخ الكود والصقه هنا:\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('الكود: ', async (code) => {
    rl.close();

    try {
      const { tokens } = await oAuth2Client.getToken(code.trim());
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

      console.log('\n✅ تم تسجيل الدخول بنجاح!');
      console.log(`   تم حفظ الـ token في: ${TOKEN_PATH}`);
      console.log('\n🚀 يمكنك الآن تشغيل النظام:');
      console.log('   npm start\n');
    } catch (error) {
      console.error('❌ خطأ:', error.message);
    }

    process.exit(0);
  });
}

/**
 * الطريقة التلقائية - localhost callback
 */
async function localServerAuth(client_id, client_secret) {
  const REDIRECT_URI = `http://localhost:${PORT}/callback`;

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('📋 سيتم فتح المتصفح لتسجيل الدخول...\n');

  const server = http.createServer(async (req, res) => {
    const queryParams = url.parse(req.url, true).query;

    if (queryParams.code) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1 style="text-align:center; margin-top:50px; font-family:Arial;">✅ تم تسجيل الدخول بنجاح!<br><br>يمكنك إغلاق هذه الصفحة.</h1>');

      try {
        const { tokens } = await oAuth2Client.getToken(queryParams.code);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

        console.log('\n✅ تم تسجيل الدخول بنجاح!');
        console.log(`   تم حفظ الـ token في: ${TOKEN_PATH}`);
        console.log('\n🚀 يمكنك الآن تشغيل النظام:');
        console.log('   npm start\n');
      } catch (error) {
        console.error('❌ خطأ في الحصول على الـ token:', error.message);
      }

      server.close();
      process.exit(0);
    } else if (queryParams.error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1 style="text-align:center; margin-top:50px; font-family:Arial;">❌ تم رفض تسجيل الدخول</h1>');
      console.error('❌ تم رفض تسجيل الدخول:', queryParams.error);
      server.close();
      process.exit(1);
    }
  });

  server.listen(PORT, () => {
    console.log(`🌐 السيرفر يعمل على: http://localhost:${PORT}`);
    console.log('📋 جاري فتح المتصفح...\n');
    console.log('إذا لم يفتح المتصفح تلقائياً، افتح هذا الرابط يدوياً:');
    console.log(`\n${authUrl}\n`);

    // فتح المتصفح تلقائياً
    const openCommand = process.platform === 'win32' ? 'start' :
      process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${openCommand} "${authUrl}"`);
  });
}

main().catch(console.error);
