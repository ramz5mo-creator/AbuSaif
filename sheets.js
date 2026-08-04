/**
 * sheets.js - ربط Google Sheets
 * ================================
 *
 * هيكل الأوراق:
 *
 * ورقة "سجل الحركات" (A:J):
 *   A: معرف العملية
 *   B: التاريخ
 *   C: المستلم (الكابتن الذي استلم) ← رصيده يقل
 *   D: المرسل (صاحب الطلب الذي سلّم) ← رصيده يزيد
 *   E: الكمية
 *   F: النوع
 *   G: نص الاستلام
 *   H: نص الطلب الأصلي
 *   I: معرف الرسالة
 *   J: المصدر (reaction/reply)
 *
 * ورقة "الأرصدة" (A:E):
 *   A: رقم الهاتف
 *   B: الرصيد (+ يعني سلّم أكثر مما استلم)
 *   C: عدد العمليات
 *   D: آخر تحديث
 *   E: الدور (مستلم/مرسل)
 *
 * ورقة "الطلبات" (A:G):
 *   A: رقم الهاتف (صاحب الطلب)
 *   B: نص الطلب
 *   C: التاريخ
 *   D: الحالة (جديد/مكتمل)
 *   E: المستلم (من استلم)
 *   F: الكمية
 *   G: معرف الرسالة
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

async function initialize() {
  const spreadsheetId = config.sheets.spreadsheetId;
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
    logger.info('تم الاتصال بالجدول', { title: response.data.properties?.title });
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
      spreadsheetId: config.sheets.spreadsheetId,
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

/**
 * تسجيل عملية استلام في سجل الحركات
 *
 * الأعمدة:
 *   C = المستلم (phone/acceptorPhone) → رصيده يقل
 *   D = المرسل/صاحب الطلب (quotedPhone/orderOwnerPhone) → رصيده يزيد
 */
async function recordTransaction(transaction) {
  if (!isInitialized) {
    logger.warn('لم يتم تسجيل العملية - Sheets غير متصل');
    return;
  }

  const acceptor = transaction.acceptorPhone || transaction.phone || '';
  const owner = transaction.orderOwnerPhone || transaction.quotedPhone || '';

  const row = [
    transaction.transactionId,           // A: معرف العملية
    transaction.timestamp,               // B: التاريخ
    acceptor,                            // C: المستلم (رصيده يقل)
    owner,                               // D: المرسل/صاحب الطلب (رصيده يزيد)
    transaction.quantity,                // E: الكمية
    transaction.type,                    // F: النوع
    transaction.text || '',              // G: نص الاستلام
    transaction.quotedText || '',        // H: نص الطلب الأصلي
    transaction.messageId,               // I: معرف الرسالة
    transaction.source || 'reply',       // J: المصدر
  ];

  try {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${config.sheets.sheetNames.transactions}!A:J`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    // المستلم (الكابتن) → رصيده يقل
    if (acceptor) {
      await updateBalance(acceptor, -transaction.quantity, 'مستلم');
    }

    // صاحب الطلب → رصيده يزيد
    if (owner) {
      await updateBalance(owner, +transaction.quantity, 'مرسل');
    }

    logger.debug('تم تسجيل العملية', {
      id: transaction.transactionId.substring(0, 8),
      acceptor,
      owner,
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
 * @param {string} role - الدور (مستلم / مرسل)
 */
async function updateBalance(phone, delta, role = '') {
  if (!isInitialized || !phone) return;

  const sheetName = config.sheets.sheetNames.balances;

  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${sheetName}!A:E`,
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
        range: `${sheetName}!A${rowIndex}:E${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[phone, newBalance, newOps, now, role]],
        },
      });
    } else {
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${sheetName}!A:E`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[phone, delta, 1, now, role]],
        },
      });
    }
  } catch (error) {
    logger.warn('فشل تحديث الرصيد', { error: error.message, phone });
  }
}

async function getBalance(phone) {
  if (!isInitialized) return null;
  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${config.sheets.sheetNames.balances}!A:E`,
    });
    const rows = response.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === phone) {
        return {
          phone: rows[i][0],
          balance: parseFloat(rows[i][1]) || 0,
          totalOps: parseInt(rows[i][2]) || 0,
          lastOperation: rows[i][3] || '',
          role: rows[i][4] || '',
        };
      }
    }
    return { phone, balance: 0, totalOps: 0, lastOperation: '', role: '' };
  } catch (error) {
    logger.error('فشل جلب الرصيد', { error: error.message });
    return null;
  }
}

/**
 * تسجيل طلب أصلي في ورقة الطلبات
 *
 * الأعمدة:
 *   A: رقم الهاتف (صاحب الطلب)
 *   B: نص الطلب
 *   C: التاريخ
 *   D: الحالة
 *   E: المستلم
 *   F: الكمية
 *   G: معرف الرسالة
 */
async function recordOrder(order) {
  if (!isInitialized) return;

  const sheetName = config.sheets.sheetNames.orders || 'الطلبات';
  const row = [
    order.phone,       // A: رقم الهاتف (صاحب الطلب)
    order.text,        // B: نص الطلب
    order.timestamp,   // C: التاريخ
    'جديد',           // D: الحالة
    '',               // E: المستلم (فارغ)
    '',               // F: الكمية (فارغة)
    order.messageId,  // G: معرف الرسالة
  ];

  try {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${sheetName}!A:G`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    logger.debug('تم تسجيل الطلب', { phone: order.phone });
  } catch (error) {
    logger.warn('فشل تسجيل الطلب', { error: error.message });
  }
}

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
          requestBody: { values: [['مكتمل', acceptorPhone, quantity]] },
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
