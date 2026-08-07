/**
 * سكريبت تنظيف: يحذف LIDs المكتوبة في العمود الخاطئ (G) من ورقة المسجلين
 * ويتأكد أن عمود D فقط هو الذي يحتوي على LIDs
 */
const path = require('path');
const { google } = require('googleapis');
const fs = require('fs');

const SPREADSHEET_ID = '15gDbpqB0e8BwX5G8S9QqCeUPg8WLZPpYukSF1mHplp0';
const SHEET_NAME = 'المسجلين';

async function getAuth() {
  const credPath = path.join(__dirname, 'oauth-credentials.json');
  const tokenPath = path.join(__dirname, 'token.json');
  const creds = JSON.parse(fs.readFileSync(credPath));
  const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const token = JSON.parse(fs.readFileSync(tokenPath));
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

async function cleanup() {
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // قراءة العمود G كاملاً
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAME}'!G1:G1000`,
  });
  const rows = res.data.values || [];
  console.log(`📋 إجمالي صفوف في عمود G: ${rows.length}`);

  // البحث عن LIDs في عمود G
  const lidRows = [];
  rows.forEach((row, idx) => {
    const val = (row[0] || '').trim();
    if (val.includes('@lid')) {
      lidRows.push({ rowNum: idx + 1, lid: val });
    }
  });

  console.log(`🔍 وجدت ${lidRows.length} LID في عمود G (خاطئ)`);
  lidRows.forEach(r => console.log(`  الصف ${r.rowNum}: ${r.lid}`));

  if (lidRows.length === 0) {
    console.log('✅ لا يوجد شيء للتنظيف');
    return;
  }

  // حذف LIDs من عمود G (تعيينها لقيمة فارغة)
  const clearRequests = lidRows.map(r => ({
    range: `'${SHEET_NAME}'!G${r.rowNum}`,
    values: [['']],
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: clearRequests,
    },
  });

  console.log(`✅ تم حذف ${lidRows.length} LID من عمود G`);
}

cleanup().catch(console.error);
