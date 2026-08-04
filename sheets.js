/**
 * sheets.js - ربط Google Sheets v4
 * ================================
 * 
 * هيكل الأوراق:
 *
 * ورقة يومية (اسمها = التاريخ مثل "2026-08-04"):
 *   A: الهاتف
 *   B: #الانتاج
 *   C: الاستلام
 *   (تُنشأ تلقائياً كل يوم)
 *
 * ورقة "سجل_تم" (A:C):
 *   A: معرف رسالة "تم"
 *   B: رقم هاتف الكابتن
 *   C: التاريخ
 *
 * ورقة "سجل الحركات" (A:J):
 *   A: معرف العملية، B: التاريخ، C: المنتج، D: الكابتن
 *   E: الكمية، F: النوع، G: الإيموجي
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const parser = require('./parser');

let sheetsApi = null;
let isInitialized = false;
let spreadsheetId = '';

const TOKEN_PATH = path.resolve('./token.json');
const CREDENTIALS_PATH = path.resolve('./oauth-credentials.json');

// كاش لأسماء الأوراق الموجودة (لتجنب إنشاء مكرر)
const existingSheets = new Set();

// ====================================================
// تهيئة الاتصال
// ====================================================

async function initialize() {
  spreadsheetId = config.sheets.spreadsheetId;
  if (!spreadsheetId) throw new Error('لم يتم تحديد معرف الجدول');

  if (!fs.existsSync(CREDENTIALS_PATH))
    throw new Error('ملف oauth-credentials.json غير موجود!');

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } =
    credentials.installed || credentials.web || {};

  if (!client_id || !client_secret)
    throw new Error('ملف oauth-credentials.json غير صالح');

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0] || 'http://localhost:3000/callback'
  );

  if (!fs.existsSync(TOKEN_PATH))
    throw new Error('لم يتم تسجيل الدخول! شغّل: node setup-auth.js');

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);

  oAuth2Client.on('tokens', (newTokens) => {
    const updatedToken = { ...token, ...newTokens };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedToken, null, 2));
    logger.debug('تم تحديث الـ token');
  });

  sheetsApi = google.sheets({ version: 'v4', auth: oAuth2Client });

  try {
    const response = await sheetsApi.spreadsheets.get({ spreadsheetId });
    const title = response.data.properties?.title;
    // تحميل أسماء الأوراق الموجودة
    if (response.data.sheets) {
      for (const sheet of response.data.sheets) {
        existingSheets.add(sheet.properties.title);
      }
    }
    logger.info('تم الاتصال بالجدول', { title, sheets: existingSheets.size });
    isInitialized = true;
  } catch (error) {
    if (error.code === 401 || error.code === 403)
      throw new Error('انتهت صلاحية تسجيل الدخول! شغّل: node setup-auth.js');
    throw error;
  }
}

async function loadSettings() {
  if (!isInitialized) return;
  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `${config.sheets.sheetNames.settings}!A:B`,
    });
    const rows = response.data.values || [];
    for (const row of rows) {
      if (row[0] === 'كلمات الاستلام' && row[1]) {
        const words = row[1].split(/[،,]/).map((w) => w.trim()).filter(Boolean);
        if (words.length > 0) parser.updateAcceptWords(words);
      }
    }
  } catch (error) {
    logger.debug('فشل تحميل الإعدادات', { error: error.message });
  }
}

// ====================================================
// الورقة اليومية — كل يوم ورقة منفصلة
// ====================================================

/**
 * الحصول على اسم الورقة اليومية (التاريخ بتوقيت الأردن)
 */
function getTodaySheetName() {
  const now = new Date();
  // توقيت الأردن GMT+3
  const jordanTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
  const year = jordanTime.getUTCFullYear();
  const month = String(jordanTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jordanTime.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * إنشاء ورقة يومية جديدة إذا لم تكن موجودة
 */
async function ensureDailySheet(sheetName) {
  if (existingSheets.has(sheetName)) return;

  try {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: sheetName,
              rightToLeft: true,
            },
          },
        }],
      },
    });

    // إضافة الرؤوس
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!A1:C1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['الهاتف', '#الانتاج', 'الاستلام']],
      },
    });

    existingSheets.add(sheetName);
    logger.info(`📄 تم إنشاء ورقة يومية: ${sheetName}`);
  } catch (error) {
    // إذا كانت موجودة بالفعل (خطأ مكرر)
    if (error.message?.includes('already exists')) {
      existingSheets.add(sheetName);
    } else {
      logger.error('فشل إنشاء ورقة يومية', { error: error.message, sheetName });
      throw error;
    }
  }
}

// ====================================================
// تسجيل الانتاج والاستلام (في الورقة اليومية)
// ====================================================

/**
 * تسجيل انتاج للمنتج (من وضع الإيموجي)
 */
async function updateTotalsProduction(phone, quantity) {
  if (!isInitialized || !phone) {
    logger.warn('updateTotalsProduction: لا يمكن التسجيل', { initialized: isInitialized, phone });
    return;
  }

  const sheetName = getTodaySheetName();
  await ensureDailySheet(sheetName);

  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:C`,
    });

    const rows = response.data.values || [];
    let found = false;
    let rowIndex = -1;
    let currentProduction = 0;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === phone) {
        found = true;
        rowIndex = i + 1;
        currentProduction = parseFloat(rows[i][1]) || 0;
        break;
      }
    }

    const newProduction = currentProduction + quantity;

    if (found) {
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: `'${sheetName}'!B${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[newProduction]] },
      });
    } else {
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId,
        range: `'${sheetName}'!A:C`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[phone, quantity, 0]] },
      });
    }

    logger.info(`✅ انتاج: ${phone} +${quantity} = ${newProduction} [${sheetName}]`);
  } catch (error) {
    logger.error('فشل تسجيل الانتاج', { error: error.message, phone, sheet: sheetName });
    throw error;
  }
}

/**
 * تسجيل استلام للكابتن (من كتب "تم")
 */
async function updateTotalsReception(phone, quantity) {
  if (!isInitialized || !phone) {
    logger.warn('updateTotalsReception: لا يمكن التسجيل', { initialized: isInitialized, phone });
    return;
  }

  const sheetName = getTodaySheetName();
  await ensureDailySheet(sheetName);

  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:C`,
    });

    const rows = response.data.values || [];
    let found = false;
    let rowIndex = -1;
    let currentReception = 0;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === phone) {
        found = true;
        rowIndex = i + 1;
        currentReception = parseFloat(rows[i][2]) || 0;
        break;
      }
    }

    const newReception = currentReception + quantity;

    if (found) {
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: `'${sheetName}'!C${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[newReception]] },
      });
    } else {
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId,
        range: `'${sheetName}'!A:C`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[phone, 0, quantity]] },
      });
    }

    logger.info(`✅ استلام: ${phone} +${quantity} = ${newReception} [${sheetName}]`);
  } catch (error) {
    logger.error('فشل تسجيل الاستلام', { error: error.message, phone, sheet: sheetName });
    throw error;
  }
}

// ====================================================
// ورقة سجل_تم
// ====================================================

async function saveTamToSheet(messageId, captainPhone) {
  if (!isInitialized || !messageId || !captainPhone) return;

  const sheetName = config.sheets.sheetNames.tamLog || 'سجل_تم';
  try {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId,
      range: `'${sheetName}'!A:C`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[messageId, captainPhone, new Date().toISOString()]],
      },
    });
  } catch (error) {
    logger.debug('فشل حفظ تم', { error: error.message });
  }
}

async function getCaptainFromTamSheet(messageId) {
  if (!isInitialized || !messageId) return null;

  const sheetName = config.sheets.sheetNames.tamLog || 'سجل_تم';
  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:B`,
    });
    const rows = response.data.values || [];
    for (let i = rows.length - 1; i >= 1; i--) {
      if (rows[i][0] === messageId) {
        return rows[i][1] || null;
      }
    }
    return null;
  } catch (error) {
    logger.debug('فشل البحث في سجل_تم', { error: error.message });
    return null;
  }
}

// ====================================================
// سجل الحركات (للتتبع والمراجعة)
// ====================================================

async function recordTransaction(transaction) {
  if (!isInitialized) return;

  const sheetName = config.sheets.sheetNames.transactions || 'سجل الحركات';
  const row = [
    transaction.transactionId || '',
    transaction.timestamp || new Date().toISOString(),
    transaction.producerPhone || transaction.phone || '',
    transaction.captainPhone || '',
    transaction.quantity || 1,
    transaction.type || '',
    transaction.emoji || '',
  ];

  try {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId,
      range: `'${sheetName}'!A:G`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
  } catch (error) {
    logger.debug('فشل تسجيل الحركة', { error: error.message });
  }
}

// ====================================================
// دوال مساعدة
// ====================================================

async function loadSettings2() { return loadSettings(); }
async function updateBalance() { /* deprecated */ }
async function updateTotals() { /* deprecated */ }
async function getBalance() { return null; }
async function recordOrder() { /* لم نعد نسجل الطلبات */ }
async function getOrderOwnerByMessageId() { return null; }
async function updateOrderStatus() { /* deprecated */ }

module.exports = {
  initialize,
  loadSettings,
  // الورقة اليومية
  updateTotalsProduction,
  updateTotalsReception,
  // سجل_تم
  saveTamToSheet,
  getCaptainFromTamSheet,
  // سجل الحركات
  recordTransaction,
  // deprecated (للتوافق)
  updateBalance,
  updateTotals,
  getBalance,
  recordOrder,
  getOrderOwnerByMessageId,
  updateOrderStatus,
};
