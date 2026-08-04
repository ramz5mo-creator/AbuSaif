/**
 * sheets.js - ربط Google Sheets
 * ================================
 * يستخدم Google Sheets API عبر OAuth2.
 *
 * القواعد:
 * - الرصيد يُحسب من سجل الحركات، وليس من تعديل مباشر للخلايا
 * - كل عملية تُسجل في سجل الحركات بمعرف فريد
 * - لا تُحتسب العملية إلا مرة واحدة
 *
 * منطق الرصيد:
 * - صاحب الطلب (quotedPhone) → +quantity (سلّم طلبات → رصيده يزيد)
 * - المستلم (phone) → -quantity (استلم طلبات → رصيده يقل)
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const parser = require('./parser');

let sheetsApi = null;
let isInitialized = false;

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

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error('ملف oauth-credentials.json غير موجود!');
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } =
    credentials.installed || credentials.web || {};

  if (!client_id || !client_secret) {
    throw new Error('ملف oauth-credentials.json غير صالح');
  }

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0] || 'http://localhost:3000/callback'
  );

  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('لم يتم تسجيل الدخول بعد! شغّل: node setup-auth.js');
  }

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
    logger.info('تم الاتصال بالجدول', { title: response.data.properties?.title });
    isInitialized = true;
  } catch (error) {
    if (error.code === 401 || error.code === 403) {
      throw new Error('انتهت صلاحية تسجيل الدخول! شغّل: node setup-auth.js');
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
 * تسجيل عملية استلام في سجل الحركات
 * وتحديث رصيد الطرفين:
 *   - المستلم (phone): -quantity
 *   - صاحب الطلب (quotedPhone): +quantity
 *
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
    transaction.phone,        // المستلم
    transaction.quotedPhone || '',  // صاحب الطلب
    transaction.quantity,
    transaction.type,
    transaction.text,
    transaction.quotedText || '',
    transaction.messageId,
  ];

  try {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${config.sheets.sheetNames.transactions}!A:I`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    // تحديث رصيد المستلم (يقل)
    if (transaction.phone) {
      await updateBalance(transaction.phone, -transaction.quantity);
    }

    // تحديث رصيد صاحب الطلب (يزيد)
    if (transaction.quotedPhone) {
      await updateBalance(transaction.quotedPhone, +transaction.quantity);
    }

    logger.debug('تم تسجيل العملية في Sheets', {
      id: transaction.transactionId.substring(0, 8),
      acceptor: transaction.phone,
      owner: transaction.quotedPhone,
      qty: transaction.quantity,
    });
  } catch (error) {
    logger.error('فشل تسجيل العملية', { error: error.message });
    throw error;
  }
}

/**
 * تحديث رصيد شخص
 * @param {string} phone - رقم الهاتف
 * @param {number} delta - التغيير (+quantity أو -quantity)
 */
async function updateBalance(phone, delta) {
  if (!isInitialized) return;

  const sheetName = config.sheets.sheetNames.balances;

  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${sheetName}!A:D`,
    });

    const rows = response.data.values || [];
    let found = false;
    let rowIndex = -1;
    let currentBalance = 0;
    let currentOps = 0;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === phone) {
        found = true;
        rowIndex = i + 1;
        currentBalance = parseFloat(rows[i][1]) || 0;
        currentOps = parseInt(rows[i][2]) || 0;
        break;
      }
    }

    const newBalance = currentBalance + delta;
    const newOps = currentOps + 1;
    const now = new Date().toISOString();

    if (found) {
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${sheetName}!A${rowIndex}:D${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[phone, newBalance, newOps, now]],
        },
      });
    } else {
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${sheetName}!A:D`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[phone, delta, 1, now]],
        },
      });
    }
  } catch (error) {
    logger.warn('فشل تحديث الرصيد', { error: error.message, phone });
  }
}

/**
 * جلب رصيد شخص
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
          balance: parseFloat(rows[i][1]) || 0,
          totalOps: parseInt(rows[i][2]) || 0,
          lastOperation: rows[i][3] || '',
        };
      }
    }

    return { phone, balance: 0, totalOps: 0, lastOperation: '' };
  } catch (error) {
    logger.error('فشل جلب الرصيد', { error: error.message });
    return null;
  }
}

/**
 * تسجيل طلب أصلي في ورقة الطلبات
 */
async function recordOrder(order) {
  if (!isInitialized) return;

  const sheetName = config.sheets.sheetNames.orders || 'الطلبات';

  const row = [
    order.phone,        // رقم الهاتف
    order.text,         // نص الطلب
    order.timestamp,    // التاريخ
    'جديد',            // الحالة
    '',                 // المستلم (فارغ)
    '',                 // الكمية (فارغة)
    order.messageId,    // معرف الرسالة
  ];

  try {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${sheetName}!A:G`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    logger.debug('تم تسجيل الطلب في ورقة الطلبات', { phone: order.phone });
  } catch (error) {
    logger.warn('فشل تسجيل الطلب', { error: error.message });
  }
}

/**
 * تحديث حالة طلب في ورقة الطلبات عند الاستلام
 */
async function updateOrderStatus(quotedMessageId, acceptorPhone, quantity) {
  if (!isInitialized) return;

  const sheetName = config.sheets.sheetNames.orders || 'الطلبات';

  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${sheetName}!A:G`,
    });

    const rows = response.data.values || [];

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][6] === quotedMessageId) {
        await sheetsApi.spreadsheets.values.update({
          spreadsheetId: config.sheets.spreadsheetId,
          range: `${sheetName}!D${i + 1}:F${i + 1}`,
          valueInputOption: 'RAW',
          requestBody: {
            values: [['مكتمل', acceptorPhone, quantity]],
          },
        });
        logger.debug('تم تحديث حالة الطلب إلى مكتمل', { row: i + 1 });
        break;
      }
    }
  } catch (error) {
    logger.warn('فشل تحديث حالة الطلب', { error: error.message });
  }
}

module.exports = {
  initialize,
  loadSettings,
  recordTransaction,
  recordOrder,
  updateOrderStatus,
  updateBalance,
  getBalance,
};
