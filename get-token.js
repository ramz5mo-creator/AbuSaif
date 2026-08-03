/**
 * get-token.js - الحصول على token عبر authorization code
 * ================================
 * يستخدم هذا الملف لتحويل authorization code إلى token.
 *
 * الاستخدام:
 *   node get-token.js <authorization_code>
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.resolve('./token.json');
const CREDENTIALS_PATH = path.resolve('./oauth-credentials.json');

async function main() {
  const code = process.argv[2];

  if (!code) {
    console.log('الاستخدام: node get-token.js <authorization_code>');
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web || {};

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0] || 'http://localhost:3000/callback'
  );

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

    console.log('✅ تم الحصول على الـ token بنجاح!');
    console.log(`   تم حفظه في: ${TOKEN_PATH}`);
    console.log('\n🚀 يمكنك الآن تشغيل النظام:');
    console.log('   npm start');
  } catch (error) {
    console.error('❌ خطأ:', error.message);
  }
}

main();
