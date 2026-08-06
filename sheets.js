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
    
    // ضمان وجود أوراق التسجيل
    await ensureRegistrationSheets();
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
function getTodaySheetName(groupPrefix = '') {
  const now = new Date();
  // توقيت الأردن GMT+3
  const jordanTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
  const year = jordanTime.getUTCFullYear();
  const month = String(jordanTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jordanTime.getUTCDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;
  return groupPrefix ? `${groupPrefix}-${dateStr}` : dateStr;
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
 * التحقق مما إذا كان الرقم مسجلاً ومعتمداً
 */
async function isUserRegistered(phone) {
  if (!isInitialized || !phone) return false;
  const sheetName = config.sheets.sheetNames.registeredUsers || 'المسجلين';
  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:A`,
    });
    const rows = response.data.values || [];
    // تخطي الرأس والبحث عن الرقم
    return rows.some(row => row[0] === phone);
  } catch (error) {
    logger.debug('فشل التحقق من التسجيل', { error: error.message });
    return false;
  }
}

/**
 * تسجيل رقم غير معروف للمراجعة
 */
async function logUnregisteredNumber(phone, name = 'غير معروف') {
  if (!isInitialized || !phone) return;
  const sheetName = config.sheets.sheetNames.unregisteredNumbers || 'أرقام غير مسجلة';
  try {
    // التحقق أولاً إذا كان الرقم موجوداً بالفعل في قائمة الانتظار
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:A`,
    });
    const rows = response.data.values || [];
    if (rows.some(row => row[0] === phone)) return;

    await sheetsApi.spreadsheets.values.append({
      spreadsheetId,
      range: `'${sheetName}'!A:C`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[phone, name, new Date().toISOString()]],
      },
    });
    logger.info(`📝 تم تسجيل رقم غير معروف للمراجعة: ${phone}`);
  } catch (error) {
    logger.debug('فشل تسجيل رقم غير معروف', { error: error.message });
  }
}

/**
 * تسجيل انتاج للمنتج (من وضع الإيموجي)
 */
async function updateTotalsProduction(phone, quantity, groupPrefix = '', name = 'غير معروف') {
  if (!isInitialized || !phone) {
    logger.warn('updateTotalsProduction: لا يمكن التسجيل', { initialized: isInitialized, phone });
    return;
  }

  // التحقق من التسجيل
  const registered = await isUserRegistered(phone);
  if (!registered) {
    logger.warn(`🚫 رقم غير مسجل حاول التسجيل (انتاج): ${phone}`);
    await logUnregisteredNumber(phone, name);
    return;
  }

  const sheetName = getTodaySheetName(groupPrefix);
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

        let newProduction = currentProduction + quantity;
    if (newProduction < 0) newProduction = 0;

    if (found) {
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: `'${sheetName}'!B${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[newProduction]] },
      });
    } else {
      // إذا كانت الحركة سالبة ولم يكن الرقم موجوداً أصلاً، نضعه 0
      const initialProduction = quantity < 0 ? 0 : quantity;
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId,
        range: `'${sheetName}'!A:C`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[phone, initialProduction, 0]] },
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
async function updateTotalsReception(phone, quantity, groupPrefix = '', name = 'غير معروف') {
  if (!isInitialized || !phone) {
    logger.warn('updateTotalsReception: لا يمكن التسجيل', { initialized: isInitialized, phone });
    return;
  }

  // التحقق من التسجيل
  const registered = await isUserRegistered(phone);
  if (!registered) {
    logger.warn(`🚫 رقم غير مسجل حاول التسجيل (استلام): ${phone}`);
    await logUnregisteredNumber(phone, name);
    return;
  }

  const sheetName = getTodaySheetName(groupPrefix);
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

    let newReception = currentReception + quantity;
    if (newReception < 0) newReception = 0;

    if (found) {
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: `'${sheetName}'!C${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[newReception]] },
      });
    } else {
      // إذا كانت الحركة سالبة ولم يكن الرقم موجوداً أصلاً، نضعه 0
      const initialReception = quantity < 0 ? 0 : quantity;
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId,
        range: `'${sheetName}'!A:C`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[phone, 0, initialReception]] },
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

  const sheetName = config.sheets.sheetNames.tamLog || 'سجل_تم مع هذه الرؤوس';
  try {
    // جلب آخر 500 صف فقط للسرعة (بدلاً من جلب الورقة كاملة)
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:B`,
    });
    const rows = response.data.values || [];
    
    // البحث من الأحدث إلى الأقدم
    for (let i = rows.length - 1; i >= 0; i--) {
      // مطابقة تامة لمعرف الرسالة
      if (rows[i][0] === messageId) {
        return rows[i][1] || null;
      }
      // مطابقة جزئية (في حال تغير المعرف قليلاً)
      if (messageId && rows[i][0] && (rows[i][0].includes(messageId) || messageId.includes(rows[i][0]))) {
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

/**
 * إنشاء ورقة نهاية الأسبوع إذا لم تكن موجودة
 */
async function ensureWeeklySheet(sheetName) {
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
      range: `'${sheetName}'!A1:D1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['الهاتف', 'إجمالي الإنتاج', 'إجمالي الاستلام', 'صافي الرصيد']],
      },
    });

    existingSheets.add(sheetName);
    logger.info(`📊 تم إنشاء ورقة نهاية الأسبوع: ${sheetName}`);
  } catch (error) {
    if (error.message?.includes('already exists')) {
      existingSheets.add(sheetName);
    } else {
      logger.error('فشل إنشاء ورقة نهاية الأسبوع', { error: error.message, sheetName });
      throw error;
    }
  }
}

/**
 * ضمان وجود أوراق التسجيل
 */
async function ensureRegistrationSheets() {
  const regSheet = config.sheets.sheetNames.registeredUsers || 'المسجلين';
  const unregSheet = config.sheets.sheetNames.unregisteredNumbers || 'أرقام غير مسجلة';

  // 1. ورقة المسجلين
  if (!existingSheets.has(regSheet)) {
    try {
      await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: regSheet, rightToLeft: true } } }],
        },
      });
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: `'${regSheet}'!A1:B1`,
        valueInputOption: 'RAW',
        requestBody: { values: [['الهاتف', 'الاسم']] },
      });
      existingSheets.add(regSheet);
    } catch (e) { logger.debug('فشل إنشاء ورقة المسجلين', { error: e.message }); }
  }

  // 2. ورقة غير المسجلين
  if (!existingSheets.has(unregSheet)) {
    try {
      await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: unregSheet, rightToLeft: true } } }],
        },
      });
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: `'${unregSheet}'!A1:C1`,
        valueInputOption: 'RAW',
        requestBody: { values: [['الهاتف', 'الاسم المقترح', 'تاريخ المحاولة']] },
      });
      existingSheets.add(unregSheet);
    } catch (e) { logger.debug('فشل إنشاء ورقة غير المسجلين', { error: e.message }); }
  }
}

/**
 * توليد تقرير نهاية الأسبوع
 * يجمع البيانات من سجل الحركات للأسبوع الحالي
 */
async function generateWeeklyReport() {
  if (!isInitialized) return;

  const weeklySheetName = config.sheets.sheetNames.weeklyReport || 'نهاية الاسبوع';
  
  try {
    // 1. حساب تاريخ بداية الأسبوع (الجمعة الماضية 11:00 مساءً)
    const now = new Date();
    const jordanTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
    
    let lastFriday = new Date(jordanTime);
    const day = lastFriday.getUTCDay(); // 0: Sun, 5: Fri
    const diff = (day >= 5) ? (day - 5) : (day + 2);
    lastFriday.setUTCDate(lastFriday.getUTCDate() - diff);
    lastFriday.setUTCHours(23, 0, 0, 0);
    
    // إذا كان اليوم هو الجمعة ولكن قبل 11م، نرجع للأسبوع الماضي
    if (day === 5 && jordanTime.getUTCHours() < 23) {
      lastFriday.setUTCDate(lastFriday.getUTCDate() - 7);
    }

    // 2. جلب البيانات من سجل الحركات
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${config.sheets.sheetNames.transactions}'!A:G`,
    });
    
    const rows = response.data.values || [];
    const summary = {}; // { phone: { prod: 0, recp: 0 } }

    for (let i = 1; i < rows.length; i++) {
      const [id, timestamp, prodPhone, captPhone, qty, type] = rows[i];
      if (!timestamp) continue;
      
      const time = new Date(timestamp);
      const status = rows[i][8] || 'نشط';
      
      if (time >= lastFriday && status === 'نشط') {
        const q = parseFloat(qty) || 0;
        
        if (prodPhone) {
          if (!summary[prodPhone]) summary[prodPhone] = { prod: 0, recp: 0 };
          summary[prodPhone].prod += q;
        }
        
        if (captPhone) {
          if (!summary[captPhone]) summary[captPhone] = { prod: 0, recp: 0 };
          summary[captPhone].recp += q;
        }
      }
    }

    // 3. تحديث ورقة نهاية الأسبوع
    await ensureWeeklySheet(weeklySheetName);
    
    const values = [['الهاتف', 'إجمالي الإنتاج', 'إجمالي الاستلام', 'صافي الرصيد']];
    for (const [phone, data] of Object.entries(summary)) {
      values.push([
        phone,
        data.prod,
        data.recp,
        data.prod - data.recp
      ]);
    }

    // مسح البيانات القديمة أولاً (باستثناء الرؤوس)
    await sheetsApi.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${weeklySheetName}'!A2:D1000`,
    });

    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${weeklySheetName}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });

    logger.info(`📊 تم تحديث تقرير نهاية الأسبوع: ${weeklySheetName} (تم معالجة ${Object.keys(summary).length} رقم)`);
    return true;
  } catch (error) {
    logger.error('فشل توليد تقرير نهاية الأسبوع', { error: error.message });
    return false;
  }
}

/**
 * التحقق مما إذا كان المستخدم مشرفاً
 */
async function isSupervisor(phone) {
  if (!isInitialized || !phone) return false;
  const sheetName = config.sheets.sheetNames.settings || 'الإعدادات';
  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:B`,
    });
    const rows = response.data.values || [];
    for (const row of rows) {
      if (row[0] === 'المشرفين' && row[1]) {
        const supervisors = row[1].split(/[،,]/).map(s => s.trim().replace(/\D/g, '')).filter(Boolean);
        const cleanPhone = phone.replace(/\D/g, '');
        // مطابقة نهاية الرقم (لتجاوز مفاتيح الدول أحياناً)
        return supervisors.some(s => cleanPhone.endsWith(s));
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}

/**
 * إلغاء عملية (❌) خلال 48 ساعة
 */
async function cancelTransaction(targetId, supervisorPhone) {
  if (!isInitialized || !targetId) return { success: false, message: 'بيانات غير مكتملة' };

  // 1. التحقق من صلاحية المشرف
  const isSuper = await isSupervisor(supervisorPhone);
  if (!isSuper) return { success: false, message: 'ليس لديك صلاحية الإلغاء' };

  const transSheet = config.sheets.sheetNames.transactions || 'سجل الحركات';
  try {
    // 2. البحث عن العملية (نبحث في العمود A للمعرف أو أي عمود قد يحتوي على معرف الرسالة)
    // بما أننا نسجل messageId في سجل الحركات أحياناً، سنبحث في كامل البيانات
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${transSheet}'!A:J`,
    });
    const rows = response.data.values || [];
    let rowIndex = -1;
    let transactionData = null;

    for (let i = rows.length - 1; i >= 1; i--) {
      // مطابقة معرف العملية (A) أو معرف الرسالة (نخزنه في الملاحظات J أحياناً أو نبحث عنه)
      // الأفضل: سنعدل سجل الحركات ليحتوي على معرف الرسالة في عمود منفصل مستقبلاً،
      // حالياً نبحث في العمود A (معرف العملية) أو J (الملاحظات)
      if (rows[i][0] === targetId || (rows[i][9] && rows[i][9].includes(targetId))) {
        rowIndex = i + 1;
        transactionData = {
          id: rows[i][0],
          time: new Date(rows[i][1]),
          producer: rows[i][2],
          captain: rows[i][3],
          qty: parseFloat(rows[i][4]),
          type: rows[i][5],
          prefix: rows[i][7],
          status: rows[i][8]
        };
        break;
      }
    }

    if (!transactionData) return { success: false, message: 'العملية غير موجودة' };
    if (transactionData.status === 'ملغى') return { success: false, message: 'العملية ملغاة بالفعل' };

    // 3. التحقق من الوقت (48 ساعة)
    const now = new Date();
    const diffHours = (now - transactionData.time) / (1000 * 60 * 60);
    if (diffHours > 48) return { success: false, message: 'انتهت مهلة الإلغاء (48 ساعة)' };

    // 4. تصفير القيم في الجدول اليومي (خصم ما تم تسجيله)
    if (transactionData.producer) {
      await updateTotalsProduction(transactionData.producer, -transactionData.qty, transactionData.prefix, 'كابتن');
    }
    if (transactionData.captain) {
      await updateTotalsReception(transactionData.captain, -transactionData.qty, transactionData.prefix, 'كابتن');
    }

    // 5. تحديث حالة العملية في سجل الحركات
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${transSheet}'!I${rowIndex}:J${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['ملغى', `تم الإلغاء بواسطة ${supervisorPhone} في ${new Date().toLocaleString('ar-JO')}`]]
      }
    });

    return { success: true, message: 'تم إلغاء العملية وتصفير القيم بنجاح' };
  } catch (error) {
    logger.error('خطأ في إلغاء العملية', { error: error.message });
    return { success: false, message: 'خطأ تقني في الإلغاء' };
  }
}

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
    transaction.groupPrefix || '',
    transaction.status || 'نشط',
    transaction.notes || ''
  ];

  try {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId,
      range: `'${sheetName}'!A:J`,
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
  isSupervisor,
  cancelTransaction,
  generateWeeklyReport,
  getTodaySheetName,
  // deprecated (للتوافق)
  updateBalance,
  updateTotals,
  getBalance,
  recordOrder,
  getOrderOwnerByMessageId,
  updateOrderStatus,
};
