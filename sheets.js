/**
 * sheets.js - ربط Google Sheets
 * ================================
 * يستخدم Google Sheets API عبر OAuth2.
 * عند أول تشغيل: يفتح المتصفح لتسجيل الدخول.
 * بعدها: يستخدم refresh token تلقائياً.
 *
 * القواعد:
 * - الرصيد يُحسب من سجل الحركات، وليس من تعديل مباشر للخلايا
 * - كل عملية تُسجل في سجل الحركات بمعرف فريد
 * - لا تُحتسب العملية إلا مرة واحدة
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const parser = require('./parser');

let sheetsApi = null;
let isInitialized = false;

// مسارات الملفات
const TOKEN_PATH = path.resolve('./token.json');
const CREDENTIALS_PATH = path.resolve('./oauth-credentials.json');

/**
 * تهيئة الاتصال بـ Google Sheets
 */
async function initialize() {
  const spreadsheetId = config.sheets.spreadsheetId;

  if (!spreadsheetId) {
    throw new Error('لم يتم تحديد معرف الجدول (SPREADSHEET_ID)');
  }

  // التحقق من وجود ملف بيانات الاعتماد
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      'ملف oauth-credentials.json غير موجود!\n' +
      'شغّل: node setup-auth.js أولاً لإعداد المصادقة.'
    );
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web || {};

  if (!client_id || !client_secret) {
    throw new Error('ملف oauth-credentials.json غير صالح');
  }

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0] || 'http://localhost:3000/callback');

  // التحقق من وجود token محفوظ
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(
      'لم يتم تسجيل الدخول بعد!\n' +
      'شغّل: node setup-auth.js أولاً لتسجيل الدخول.'
    );
  }

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);

  // تحديث الـ token تلقائياً عند انتهائه
  oAuth2Client.on('tokens', (newTokens) => {
    const updatedToken = { ...token, ...newTokens };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedToken, null, 2));
    logger.debug('تم تحديث الـ token');
  });

  sheetsApi = google.sheets({ version: 'v4', auth: oAuth2Client });

  // اختبار الاتصال
  try {
    const response = await sheetsApi.spreadsheets.get({ spreadsheetId });
    logger.info('تم الاتصال بالجدول', { title: response.data.properties?.title });
    isInitialized = true;
  } catch (error) {
    if (error.code === 401 || error.code === 403) {
      throw new Error(
        'انتهت صلاحية تسجيل الدخول!\n' +
        'شغّل: node setup-auth.js لإعادة تسجيل الدخول.'
      );
    }
    throw error;
  }
}

/**
 * تحميل الإعدادات من ورقة الإعدادات
 */
async function loadSettings() {
  if (!isInitialized) return;

  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${config.sheets.sheetNames.settings}!A:B`,
    });

    const rows = response.data.values || [];

    for (const row of rows) {
      if (row[0] === 'كلمات الاستلام' && row[1]) {
        // دعم الفاصلة العربية والإنجليزية
        const words = row[1]
          .split(/[،,]/)
          .map((w) => w.trim())
          .filter(Boolean);

        if (words.length > 0) {
          parser.updateAcceptWords(words);
        }
      }
    }
  } catch (error) {
    logger.debug('فشل تحميل الإعدادات من Sheets', { error: error.message });
  }
}

/**
 * تسجيل عملية في سجل الحركات
 * @param {object} transaction - بيانات العملية
 */
async function recordTransaction(transaction) {
  if (!isInitialized) {
    logger.warn('لم يتم تسجيل العملية - Sheets غير متصل');
    return;
  }

  const row = [
    transaction.transactionId,
    transaction.timestamp,
    transaction.phone,
    transaction.quotedPhone || '',
    transaction.quantity,
    transaction.type,
    transaction.text,
    transaction.quotedText || '',
    transaction.messageId,
  ];

  try {
    // إضافة صف جديد في سجل الحركات
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${config.sheets.sheetNames.transactions}!A:I`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    // تحديث رصيد المستلم
    await updateBalance(transaction.phone, transaction.quantity);

    logger.debug('تم تسجيل العملية في Sheets', {
      id: transaction.transactionId.substring(0, 8),
    });
  } catch (error) {
    logger.error('فشل تسجيل العملية', { error: error.message });
    throw error;
  }
}

/**
 * تحديث رصيد شخص بناءً على سجل الحركات
 * @param {string} phone - رقم الهاتف
 * @param {number} amount - الكمية الجديدة المضافة
 */
async function updateBalance(phone, amount) {
  if (!isInitialized) return;

  const sheetName = config.sheets.sheetNames.balances;

  try {
    // جلب الأرصدة الحالية
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${sheetName}!A:D`,
    });

    const rows = response.data.values || [];
    let found = false;
    let rowIndex = -1;

    // البحث عن رقم الهاتف
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === phone) {
        found = true;
        rowIndex = i + 1;
        break;
      }
    }

    if (found) {
      // حساب الرصيد من سجل الحركات
      const transResponse = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${config.sheets.sheetNames.transactions}!C:E`,
      });

      const transRows = transResponse.data.values || [];
      let totalAmount = 0;
      let totalOps = 0;

      for (let i = 1; i < transRows.length; i++) {
        if (transRows[i][0] === phone) {
          totalAmount += parseInt(transRows[i][2]) || 0;
          totalOps++;
        }
      }

      // تحديث الصف
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${sheetName}!A${rowIndex}:D${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[phone, totalAmount, totalOps, new Date().toISOString()]],
        },
      });
    } else {
      // إضافة صف جديد
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${sheetName}!A:D`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[phone, amount, 1, new Date().toISOString()]],
        },
      });
    }
  } catch (error) {
    logger.warn('فشل تحديث الرصيد', { error: error.message, phone });
  }
}

/**
 * جلب رصيد شخص
 * @param {string} phone - رقم الهاتف
 * @returns {object} - الرصيد والعمليات
 */
async function getBalance(phone) {
  if (!isInitialized) return null;

  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${config.sheets.sheetNames.balances}!A:D`,
    });

    const rows = response.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === phone) {
        return {
          phone: rows[i][0],
          totalAmount: parseInt(rows[i][1]) || 0,
          totalOps: parseInt(rows[i][2]) || 0,
          lastOperation: rows[i][3] || '',
        };
      }
    }

    return { phone, totalAmount: 0, totalOps: 0, lastOperation: '' };
  } catch (error) {
    logger.error('فشل جلب الرصيد', { error: error.message });
    return null;
  }
}

module.exports = {
  initialize,
  loadSettings,
  recordTransaction,
  updateBalance,
  getBalance,
};
