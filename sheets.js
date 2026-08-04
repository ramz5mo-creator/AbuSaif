/**
 * sheets.js - ربط Google Sheets
 * ================================
 *
 * هيكل الأوراق:
 *
 * ورقة "الاجمالي" (A:C):
 *   A: رقم الهاتف
 *   B: الانتاج (من وضع الإيموجي)
 *   C: الاستلام (من كتب "تم")
 *
 * ورقة "الطلبات" (A:G):
 *   A: رقم الهاتف (صاحب الطلب)
 *   B: نص الطلب
 *   C: التاريخ
 *   D: الحالة
 *   E: المستلم
 *   F: الكمية
 *   G: معرف الرسالة
 *
 * ورقة "سجل_تم" (A:C) - جديدة:
 *   A: معرف رسالة "تم"
 *   B: رقم هاتف الكابتن
 *   C: التاريخ
 *   (تُستخدم للاستعادة بعد إعادة الاتصال)
 *
 * ورقة "سجل الحركات" (A:J):
 *   A: معرف العملية، B: التاريخ، C: المستلم، D: المرسل
 *   E: الكمية، F: النوع، G: نص الاستلام، H: نص الطلب
 *   I: معرف الرسالة، J: المصدر
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

// ====================================================
// تهيئة الاتصال
// ====================================================

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

// ====================================================
// ورقة سجل_تم - حفظ واسترجاع رسائل "تم" بشكل دائم
// ====================================================

/**
 * حفظ رسالة "تم" في Google Sheets (للاستعادة بعد إعادة الاتصال)
 * @param {string} messageId - معرف رسالة "تم"
 * @param {string} captainPhone - رقم هاتف الكابتن
 */
async function saveTamToSheet(messageId, captainPhone) {
  if (!isInitialized || !messageId || !captainPhone) return;

  const sheetName = config.sheets.sheetNames.tamLog || 'سجل_تم';
  try {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${sheetName}!A:C`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[messageId, captainPhone, new Date().toISOString()]],
      },
    });
    logger.debug('💾 حفظ تم في الجدول', { msgId: messageId.substring(0, 10), captain: captainPhone });
  } catch (error) {
    // إذا كانت الورقة غير موجودة، نتجاهل الخطأ
    logger.debug('فشل حفظ تم في الجدول (قد تكون الورقة غير موجودة)', { error: error.message });
  }
}

/**
 * البحث عن رقم الكابتن في ورقة سجل_تم
 * يُستخدم كاحتياطي بعد إعادة الاتصال عندما يكون tamCache فارغاً
 * @param {string} messageId - معرف رسالة "تم"
 * @returns {string|null}
 */
async function getCaptainFromTamSheet(messageId) {
  if (!isInitialized || !messageId) return null;

  const sheetName = config.sheets.sheetNames.tamLog || 'سجل_تم';
  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${sheetName}!A:B`,
    });
    const rows = response.data.values || [];
    // البحث من الأحدث للأقدم
    for (let i = rows.length - 1; i >= 1; i--) {
      if (rows[i][0] === messageId) {
        const captain = rows[i][1] || '';
        if (captain) {
          logger.info('📋 وجدنا الكابتن من سجل_تم', { msgId: messageId.substring(0, 10), captain });
          return captain;
        }
      }
    }
    return null;
  } catch (error) {
    logger.debug('فشل البحث في سجل_تم', { error: error.message });
    return null;
  }
}

// ====================================================
// ورقة الإجمالي - تسجيل الانتاج والاستلام
// ====================================================

/**
 * تسجيل انتاج للمنتج (من وضع الإيموجي)
 * يزيد عمود B (الانتاج) في ورقة الإجمالي
 */
async function updateTotalsProduction(phone, quantity) {
  if (!isInitialized || !phone) return;

  const sheetName = config.sheets.sheetNames.totals;

  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${sheetName}!A:C`,
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
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${sheetName}!B${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[newProduction]] },
      });
    } else {
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${sheetName}!A:C`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[phone, newProduction, 0]] },
      });
    }

    logger.debug('✅ تم تسجيل انتاج', { phone, qty: quantity, total: newProduction });
  } catch (error) {
    logger.warn('فشل تسجيل الانتاج', { error: error.message, phone });
    throw error;
  }
}

/**
 * تسجيل استلام للكابتن (من كتب "تم")
 * يزيد عمود C (الاستلام) في ورقة الإجمالي
 */
async function updateTotalsReception(phone, quantity) {
  if (!isInitialized || !phone) return;

  const sheetName = config.sheets.sheetNames.totals;

  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${sheetName}!A:C`,
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
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${sheetName}!C${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[newReception]] },
      });
    } else {
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${sheetName}!A:C`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[phone, 0, newReception]] },
      });
    }

    logger.debug('✅ تم تسجيل استلام', { phone, qty: quantity, total: newReception });
  } catch (error) {
    logger.warn('فشل تسجيل الاستلام', { error: error.message, phone });
    throw error;
  }
}

// ====================================================
// ورقة الطلبات
// ====================================================

async function recordOrder(order) {
  if (!isInitialized) return;

  const sheetName = config.sheets.sheetNames.orders || 'الطلبات';
  const row = [
    order.phone,
    order.text,
    order.timestamp,
    'جديد',
    '',
    '',
    order.messageId,
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

/**
 * البحث عن صاحب الطلب في ورقة الطلبات بواسطة معرف الرسالة
 * ملاحظة: هذا يجد صاحب الطلب الأصلي، وليس الكابتن
 */
async function getOrderOwnerByMessageId(messageId) {
  if (!isInitialized || !messageId) return null;

  const sheetName = config.sheets.sheetNames.orders || 'الطلبات';
  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${sheetName}!A:G`,
    });
    const rows = response.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][6] === messageId) {
        return rows[i][0] || null;
      }
    }
    return null;
  } catch (error) {
    logger.warn('فشل البحث عن صاحب الطلب', { error: error.message });
    return null;
  }
}

// ====================================================
// دوال مساعدة قديمة (للتوافق)
// ====================================================

async function recordTransaction(transaction) {
  if (!isInitialized) return;

  const acceptor = transaction.acceptorPhone || transaction.phone || '';
  const owner = transaction.orderOwnerPhone || transaction.quotedPhone || '';

  const row = [
    transaction.transactionId,
    transaction.timestamp,
    acceptor,
    owner,
    transaction.quantity,
    transaction.type,
    transaction.text || '',
    transaction.quotedText || '',
    transaction.messageId,
    transaction.source || 'reply',
  ];

  try {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${config.sheets.sheetNames.transactions}!A:J`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
  } catch (error) {
    logger.error('فشل تسجيل العملية', { error: error.message });
  }
}

async function updateBalance(phone, delta) {
  if (!isInitialized || !phone) return;
  const sheetName = config.sheets.sheetNames.balances;
  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${sheetName}!A:D`,
    });
    const rows = response.data.values || [];
    let found = false;
    let rowIndex = -1;
    let currentPositive = 0;
    let currentNegative = 0;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][1] === phone) {
        found = true;
        rowIndex = i + 1;
        currentPositive = parseFloat(rows[i][2]) || 0;
        currentNegative = parseFloat(rows[i][3]) || 0;
        break;
      }
    }

    let newPositive = currentPositive;
    let newNegative = currentNegative;
    if (delta > 0) newPositive = currentPositive + delta;
    else if (delta < 0) newNegative = currentNegative + Math.abs(delta);

    if (found) {
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${sheetName}!C${rowIndex}:D${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[newPositive, newNegative]] },
      });
    } else {
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${sheetName}!A:D`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [['', phone, newPositive, newNegative]] },
      });
    }
  } catch (error) {
    logger.warn('فشل تحديث الرصيد', { error: error.message, phone });
  }
}

async function updateTotals(phone, delta) {
  if (delta > 0) {
    await updateTotalsProduction(phone, delta);
  } else if (delta < 0) {
    await updateTotalsReception(phone, Math.abs(delta));
  }
}

async function getBalance(phone) {
  if (!isInitialized) return null;
  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${config.sheets.sheetNames.balances}!A:D`,
    });
    const rows = response.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][1] === phone) {
        return {
          name: rows[i][0] || '',
          phone: rows[i][1],
          positive: parseFloat(rows[i][2]) || 0,
          negative: parseFloat(rows[i][3]) || 0,
        };
      }
    }
    return { name: '', phone, positive: 0, negative: 0 };
  } catch (error) {
    logger.error('فشل جلب الرصيد', { error: error.message });
    return null;
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
  // ورقة الإجمالي
  updateTotalsProduction,
  updateTotalsReception,
  // ورقة سجل_تم (جديد)
  saveTamToSheet,
  getCaptainFromTamSheet,
  // ورقة الطلبات
  recordOrder,
  getOrderOwnerByMessageId,
  updateOrderStatus,
  // دوال مساعدة
  recordTransaction,
  updateBalance,
  updateTotals,
  getBalance,
};
