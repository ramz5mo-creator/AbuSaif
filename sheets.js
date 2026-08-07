/**
 * sheets.js - ربط Google Sheets v4
 * ================================
 * 
 * هيكل الأوراق:
 *
 * ورقة يومية (اسمها = التاريخ مثل "دريمكس-2026-08-04"):
 *   A: الهاتف
 *   B: الاسم
 *   C: #الانتاج
 *   D: الاستلام
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

// كاش أسماء المسجلين { normalizedPhone → { name, whatsappName } }
// name: الاسم الرسمي (عمود B)
// whatsappName: اسم واتساب (عمود C) - اختياري
let registeredUsersCache = new Map();
let lastRegisteredUsersLoad = 0;
const REGISTERED_USERS_CACHE_TTL = 5 * 60 * 1000; // 5 دقائق

/**
 * توحيد صيغة رقم الهاتف: دائماً 9 أرقام (بدون مفتاح الدولة 962)
 * 962791234567 → 791234567
 * 791234567 → 791234567
 * 0791234567 → 791234567
 */
function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/\D/g, '');
  if (!p || p.length < 9) return null;
  // إزالة أي زيادة من البداية
  while (p.length > 12) p = p.substring(1);
  if (p.length === 12 && p.startsWith('962')) p = p.substring(3);
  else if (p.length === 11 && p.startsWith('96')) p = p.substring(2);
  else if (p.length === 10 && p.startsWith('0')) p = p.substring(1);
  return p.length >= 9 ? p : null;
}

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
    
    // تحميل أسماء المسجلين في الكاش
    await loadRegisteredUsers();
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
// تحميل أسماء المسجلين من ورقة "المسجلين"
// ====================================================

/**
 * تحميل أسماء المسجلين من Google Sheets
 * يُرجع Map من normalizedPhone → name
 * يستخدم كاش بمدة 5 دقائق لتقليل الاستعلامات
 */
async function loadRegisteredUsers(forceRefresh = false) {
  if (!isInitialized) return registeredUsersCache;
  
  const now = Date.now();
  if (!forceRefresh && registeredUsersCache.size > 0 && (now - lastRegisteredUsersLoad) < REGISTERED_USERS_CACHE_TTL) {
    return registeredUsersCache;
  }

  const sheetName = config.sheets.sheetNames.registeredUsers || 'المسجلين';
  try {
    // نقرأ A:C للحصول على: A=الهاتف، B=الاسم الرسمي، C=اسم واتساب (اختياري)
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:C`,
    });
    const rows = response.data.values || [];
    const newCache = new Map();
    
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row[0]) {
        const np = normalizePhone(row[0]);
        if (np) {
          newCache.set(np, {
            name: (row[1] || '').trim(),
            whatsappName: (row[2] || '').trim(),  // عمود C: اسم واتساب
          });
        }
      }
    }
    
    registeredUsersCache = newCache;
    lastRegisteredUsersLoad = now;
    logger.info(`📚 تم تحميل ${newCache.size} مسجل من ورقة المسجلين`);
    return registeredUsersCache;
  } catch (error) {
    logger.warn('فشل تحميل المسجلين', { error: error.message });
    return registeredUsersCache;
  }
}

/**
 * البحث عن اسم مسجل برقم الهاتف
 * يُرجع الاسم الرسمي (عمود B) أو اسم واتساب (عمود C) إذا وجد
 */
function getRegisteredName(phone) {
  if (!phone) return '';
  const np = normalizePhone(phone);
  if (!np) return '';
  const entry = registeredUsersCache.get(np);
  if (!entry) return '';
  // إذا كان الكاش قديماً (string) أو جديداً (object)
  if (typeof entry === 'string') return entry;
  return entry.name || entry.whatsappName || '';
}

/**
 * البحث عن رقم هاتف بالاسم (pushName)
 * يبحث في الاسم الرسمي (B) واسم واتساب (C) معاً
 */
function findPhoneByName(pushName) {
  if (!pushName || pushName === 'غير معروف') return null;
  const cleanName = pushName.trim().toLowerCase();
  
  // مساعد: استخراج الأسماء من الكاش (سواء string أو object)
  function getNames(entry) {
    if (!entry) return [];
    if (typeof entry === 'string') return [entry.trim().toLowerCase()].filter(Boolean);
    return [
      (entry.name || '').trim().toLowerCase(),
      (entry.whatsappName || '').trim().toLowerCase()
    ].filter(Boolean);
  }
  
  // 1. بحث مطابق تماماً في أي من العمودين
  for (const [phone, entry] of registeredUsersCache.entries()) {
    const names = getNames(entry);
    if (names.some(n => n === cleanName)) return phone;
  }
  
  // 2. بحث جزئي (الاسم يحتوي على pushName أو العكس)
  for (const [phone, entry] of registeredUsersCache.entries()) {
    const names = getNames(entry);
    if (names.some(n => n.includes(cleanName) || cleanName.includes(n))) return phone;
  }
  
  return null;
}

/**
 * تحديث اسم واتساب (عمود C) في ورقة المسجلين تلقائياً
 * يُستدعى عند كل رسالة واردة من شخص مسجل
 * يحدّث فقط إذا كان الاسم جديداً أو تغيّر لتجنّب الكتابة المتكررة
 */
// كاش لتتبع آخر اسم واتساب محفوظ لكل رقم { normalizedPhone: lastWhatsappName }
const whatsappNameCache = new Map();

async function updateWhatsappName(phone, pushName) {
  if (!isInitialized || !phone || !pushName) return;
  const np = normalizePhone(phone);
  if (!np) return;
  
  // لا نحدّث إذا لم يكن مسجلاً
  const entry = registeredUsersCache.get(np);
  if (!entry) return;
  
  const currentWA = typeof entry === 'string' ? '' : (entry.whatsappName || '');
  
  // لا نحدّث إذا كان الاسم نفسه
  if (currentWA === pushName) return;
  
  // لا نحدّث أكثر من مرة كل دقيقتين لنفس الرقم
  const lastUpdate = whatsappNameCache.get(np);
  const now = Date.now();
  if (lastUpdate && (now - lastUpdate.time) < 2 * 60 * 1000 && lastUpdate.name === pushName) return;
  
  whatsappNameCache.set(np, { name: pushName, time: now });
  
  // تحديث الكاش محلياً
  if (typeof entry === 'string') {
    registeredUsersCache.set(np, { name: entry, whatsappName: pushName });
  } else {
    registeredUsersCache.set(np, { ...entry, whatsappName: pushName });
  }
  
  // تحديث ورقة المسجلين في Google Sheets (عمود C)
  const sheetName = config.sheets.sheetNames.registeredUsers || 'المسجلين';
  try {
    // البحث عن صف الرقم في الورقة
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:A`,
    });
    const rows = response.data.values || [];
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] && normalizePhone(rows[i][0]) === np) {
        rowIndex = i + 1; // 1-indexed
        break;
      }
    }
    if (rowIndex === -1) return; // ليس مسجلاً
    
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!C${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[pushName]] },
    });
    logger.debug(`📱 تحديث اسم واتساب: ${np} → ${pushName}`);
  } catch (error) {
    logger.debug('فشل تحديث اسم واتساب', { error: error.message });
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

    // إضافة الرؤوس (4 أعمدة: الهاتف، الاسم، #الانتاج، الاستلام)
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!A1:D1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['الهاتف', 'الاسم', '#الانتاج', 'الاستلام']],
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
 * يدعم المطابقة المرنة (تجاهل مفتاح الدولة)
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
    const cleanInput = phone.replace(/\D/g, '');
    
    for (const row of rows) {
      if (!row[0]) continue;
      const storedPhone = row[0].toString().replace(/\D/g, '');
      if (!storedPhone) continue;

      // مطابقة مرنة: إذا كان أحد الرقمين ينتهي بالآخر (بحد أدنى 8 أرقام للموثوقية)
      if (cleanInput.endsWith(storedPhone) || storedPhone.endsWith(cleanInput)) {
        if (storedPhone.length >= 8 && cleanInput.length >= 8) {
          return row[0]; // إرجاع الرقم كما هو مكتوب في الورقة
        }
      }
    }
    return false;
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
 * الورقة اليومية: A=الهاتف, B=الاسم, C=#الانتاج, D=الاستلام
 * متوافق مع الورقات القديمة (3 أعمدة) والجديدة (4 أعمدة)
 */
async function updateTotalsProduction(phone, quantity, groupPrefix = '', name = 'غير معروف') {
  if (!isInitialized || !phone) {
    logger.warn('updateTotalsProduction: لا يمكن التسجيل', { initialized: isInitialized, phone });
    return;
  }

  const targetPhone = normalizePhone(phone);
  if (!targetPhone) return;
  const sheetName = getTodaySheetName(groupPrefix);
  await ensureDailySheet(sheetName);

  // الحصول على الاسم من ورقة المسجلين (أولوية) أو من pushName
  const registeredName = getRegisteredName(targetPhone);
  const displayName = registeredName || name || 'غير معروف';

  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:D`,
    });

    const rows = response.data.values || [];
    let found = false;
    let rowIndex = -1;
    let currentProduction = 0;
    
    // اكتشاف هيكل الورقة (قديمة 3 أعمدة أو جديدة 4 أعمدة)
    const headers = rows[0] || [];
    const hasNameCol = headers.length >= 4 && headers[1] === 'الاسم';
    const prodColIdx = hasNameCol ? 2 : 1; // C أو B

    for (let i = 1; i < rows.length; i++) {
      if (normalizePhone(rows[i][0]) === targetPhone) {
        found = true;
        rowIndex = i + 1;
        currentProduction = parseFloat(rows[i][prodColIdx]) || 0;
        break;
      }
    }

    let newProduction = currentProduction + quantity;
    if (newProduction < 0) newProduction = 0;

    if (found) {
      // تحديث الإنتاج + الاسم (إذا كانت الورقة جديدة)
      if (hasNameCol) {
        await sheetsApi.spreadsheets.values.update({
          spreadsheetId,
          range: `'${sheetName}'!B${rowIndex}:C${rowIndex}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[displayName, newProduction]] },
        });
      } else {
        await sheetsApi.spreadsheets.values.update({
          spreadsheetId,
          range: `'${sheetName}'!B${rowIndex}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[newProduction]] },
        });
      }
    } else {
      const initialProduction = quantity < 0 ? 0 : quantity;
      if (hasNameCol) {
        await sheetsApi.spreadsheets.values.append({
          spreadsheetId,
          range: `'${sheetName}'!A:D`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [[targetPhone, displayName, initialProduction, 0]] },
        });
      } else {
        await sheetsApi.spreadsheets.values.append({
          spreadsheetId,
          range: `'${sheetName}'!A:C`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [[targetPhone, initialProduction, 0]] },
        });
      }
    }

    logger.info(`✅ انتاج: ${targetPhone} (${displayName}) +${quantity} = ${newProduction} [${sheetName}]`);
  } catch (error) {
    logger.error('فشل تسجيل الانتاج', { error: error.message, phone, sheet: sheetName });
    throw error;
  }
}

/**
 * تسجيل استلام للكابتن (من كتب "تم")
 * الورقة اليومية: A=الهاتف, B=الاسم, C=#الانتاج, D=الاستلام
 * متوافق مع الورقات القديمة (3 أعمدة) والجديدة (4 أعمدة)
 */
async function updateTotalsReception(phone, quantity, groupPrefix = '', name = 'غير معروف') {
  if (!isInitialized || !phone) {
    logger.warn('updateTotalsReception: لا يمكن التسجيل', { initialized: isInitialized, phone });
    return;
  }

  const targetPhone = normalizePhone(phone);
  if (!targetPhone) return;
  const sheetName = getTodaySheetName(groupPrefix);
  await ensureDailySheet(sheetName);

  // الحصول على الاسم من ورقة المسجلين (أولوية) أو من pushName
  const registeredName = getRegisteredName(targetPhone);
  const displayName = registeredName || name || 'غير معروف';

  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:D`,
    });

    const rows = response.data.values || [];
    let found = false;
    let rowIndex = -1;
    let currentReception = 0;

    // اكتشاف هيكل الورقة
    const headers = rows[0] || [];
    const hasNameCol = headers.length >= 4 && headers[1] === 'الاسم';
    const recColIdx = hasNameCol ? 3 : 2; // D أو C

    for (let i = 1; i < rows.length; i++) {
      if (normalizePhone(rows[i][0]) === targetPhone) {
        found = true;
        rowIndex = i + 1;
        currentReception = parseFloat(rows[i][recColIdx]) || 0;
        break;
      }
    }

    let newReception = currentReception + quantity;
    if (newReception < 0) newReception = 0;

    if (found) {
      if (hasNameCol) {
        // تحديث الاسم + الاستلام (عمود B و D)
        await sheetsApi.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: {
            valueInputOption: 'RAW',
            data: [
              { range: `'${sheetName}'!B${rowIndex}`, values: [[displayName]] },
              { range: `'${sheetName}'!D${rowIndex}`, values: [[newReception]] },
            ],
          },
        });
      } else {
        await sheetsApi.spreadsheets.values.update({
          spreadsheetId,
          range: `'${sheetName}'!C${rowIndex}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[newReception]] },
        });
      }
    } else {
      const initialReception = quantity < 0 ? 0 : quantity;
      if (hasNameCol) {
        await sheetsApi.spreadsheets.values.append({
          spreadsheetId,
          range: `'${sheetName}'!A:D`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [[targetPhone, displayName, 0, initialReception]] },
        });
      } else {
        await sheetsApi.spreadsheets.values.append({
          spreadsheetId,
          range: `'${sheetName}'!A:C`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [[targetPhone, 0, initialReception]] },
        });
      }
    }

    logger.info(`✅ استلام: ${targetPhone} (${displayName}) +${quantity} = ${newReception} [${sheetName}]`);
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
        range: `'${regSheet}'!A1:C1`,
        valueInputOption: 'RAW',
        requestBody: { values: [['الهاتف', 'الاسم', 'اسم واتساب']] },
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
// سجل التعديلات
// ====================================================

/**
 * إنشاء ورقة سجل التعديلات إذا لم تكن موجودة
 */
async function ensureEditLogSheet() {
  const sheetName = config.sheets.sheetNames.editLog || 'سجل التعديلات';
  if (existingSheets.has(sheetName)) return;
  try {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName, rightToLeft: true } } }],
      },
    });
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!A1:H1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['التاريخ', 'رقم المعدِل', 'اسم المعدِل', 'المنتج', 'الكابتن', 'القيمة القديمة', 'القيمة الجديدة', 'الفرق']],
      },
    });
    existingSheets.add(sheetName);
    logger.info(`📝 تم إنشاء ورقة سجل التعديلات`);
  } catch (e) {
    if (e.message?.includes('already exists')) existingSheets.add(sheetName);
  }
}

/**
 * تسجيل عملية تعديل في ورقة سجل التعديلات
 * @param {object} editData - بيانات التعديل
 */
async function logEdit(editData) {
  if (!isInitialized) return;
  await ensureEditLogSheet();
  const sheetName = config.sheets.sheetNames.editLog || 'سجل التعديلات';
  const now = new Date();
  const jordanTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
  const row = [
    jordanTime.toISOString().replace('T', ' ').substring(0, 19),
    editData.editorPhone || '',
    editData.editorName || '',
    editData.producerPhone || '',
    editData.captainPhone || '',
    editData.oldQuantity || 0,
    editData.newQuantity || 0,
    (editData.newQuantity || 0) - (editData.oldQuantity || 0),
  ];
  try {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId,
      range: `'${sheetName}'!A:H`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    logger.info(`📝 تعديل: ${editData.editorPhone} غيّر من ${editData.oldQuantity} إلى ${editData.newQuantity}`);
  } catch (error) {
    logger.error('فشل تسجيل التعديل', { error: error.message });
  }
}

/**
 * التحقق من صلاحية التعديل (الجميع 24 ساعة، المشرف الأسبوع كاملاً)
 * @param {string} phone - رقم المعدِل
 * @param {Date} transactionTime - وقت العملية الأصلية
 * @returns {boolean}
 */
async function canEdit(phone, transactionTime) {
  const now = new Date();
  const diffHours = (now - new Date(transactionTime)) / (1000 * 60 * 60);
  const rules = config.sheets.editRules || { userEditHours: 24, supervisorEditHours: 168 };

  // المشرف يمكنه التعديل خلال الأسبوع كاملاً
  const isSuper = await isSupervisor(phone);
  if (isSuper && diffHours <= rules.supervisorEditHours) return true;

  // الجميع يمكنهم التعديل خلال 24 ساعة
  if (diffHours <= rules.userEditHours) return true;

  return false;
}

/**
 * البحث عن عملية سابقة بمعرف الرسالة (في سجل الحركات)
 * @param {string} messageId - معرف الرسالة المستهدفة
 * @param {string} reactorPhone - رقم من وضع التفاعل (المنتج)
 * @returns {object|null} بيانات العملية إذا وُجدت
 */
async function findTransactionByMessageId(messageId, reactorPhone) {
  if (!isInitialized || !messageId) return null;
  const transSheet = config.sheets.sheetNames.transactions || 'سجل الحركات';
  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${transSheet}'!A:J`,
    });
    const rows = response.data.values || [];
    const cleanReactor = reactorPhone ? reactorPhone.replace(/\D/g, '') : '';

    // البحث من الأحدث إلى الأقدم
    for (let i = rows.length - 1; i >= 1; i--) {
      const row = rows[i];
      const rowId = row[0] || '';
      const rowProducer = (row[2] || '').replace(/\D/g, '');
      const rowNotes = row[9] || '';
      const rowStatus = row[8] || '';

      // تخطي الملغاة
      if (rowStatus === 'ملغى') continue;

      // مطابقة: معرف العملية يحتوي على messageId أو الملاحظات تحتوي عليه
      const idMatch = rowId.includes(messageId) || rowNotes.includes(messageId);
      // مطابقة المنتج (من وضع الإيموجي)
      const producerMatch = !reactorPhone || 
        cleanReactor.endsWith(rowProducer) || rowProducer.endsWith(cleanReactor) ||
        (cleanReactor.length >= 8 && rowProducer.length >= 8 && 
         (cleanReactor.slice(-9) === rowProducer.slice(-9)));

      if (idMatch && producerMatch) {
        return {
          rowIndex: i + 1, // 1-based for Sheets API
          transactionId: row[0],
          timestamp: row[1],
          producerPhone: row[2],
          captainPhone: row[3],
          quantity: parseFloat(row[4]) || 0,
          type: row[5],
          emoji: row[6],
          groupPrefix: row[7],
          status: row[8],
          notes: row[9],
        };
      }
    }
    return null;
  } catch (error) {
    logger.error('خطأ في البحث عن العملية', { error: error.message });
    return null;
  }
}

/**
 * معالجة تعديل (تغيير إيموجي على نفس الرسالة)
 * @param {object} params
 * @param {string} params.messageId - معرف الرسالة المستهدفة
 * @param {string} params.editorPhone - رقم من قام بالتعديل
 * @param {string} params.editorName - اسم المعدِل
 * @param {number} params.newQuantity - الكمية الجديدة
 * @param {string} params.groupPrefix - بادئة الجروب
 * @returns {object} نتيجة العملية {success, message, diff}
 */
async function processEdit({ messageId, editorPhone, editorName, newQuantity, groupPrefix }) {
  if (!isInitialized) return { success: false, message: 'النظام غير مهيأ' };

  // 1. البحث عن العملية الأصلية
  const transaction = await findTransactionByMessageId(messageId, editorPhone);
  if (!transaction) {
    return { success: false, message: 'لم يتم العثور على عملية سابقة لهذه الرسالة' };
  }

  // 2. التحقق من صلاحية التعديل (الوقت)
  const allowed = await canEdit(editorPhone, transaction.timestamp);
  if (!allowed) {
    return { success: false, message: 'انتهت مهلة التعديل' };
  }

  // 3. حساب الفرق
  const oldQuantity = transaction.quantity;
  const diff = newQuantity - oldQuantity;

  if (diff === 0) {
    return { success: false, message: 'لا يوجد فرق (نفس الكمية)' };
  }

  // 4. تطبيق الفرق على الجهتين في الورقة اليومية
  // تطبيق على المنتج (إنتاج)
  if (transaction.producerPhone) {
    await updateTotalsProduction(transaction.producerPhone, diff, groupPrefix || transaction.groupPrefix, editorName);
  }
  // تطبيق على الكابتن (استلام)
  if (transaction.captainPhone) {
    await updateTotalsReception(transaction.captainPhone, diff, groupPrefix || transaction.groupPrefix, editorName);
  }

  // 5. تحديث الكمية في سجل الحركات
  const transSheet = config.sheets.sheetNames.transactions || 'سجل الحركات';
  try {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${transSheet}'!E${transaction.rowIndex}:J${transaction.rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          newQuantity,
          transaction.type,
          transaction.emoji,
          transaction.groupPrefix,
          'معدّل',
          `تعديل من ${oldQuantity} إلى ${newQuantity} بواسطة ${editorPhone} في ${new Date().toISOString()}`
        ]]
      }
    });
  } catch (error) {
    logger.error('فشل تحديث سجل الحركات بعد التعديل', { error: error.message });
  }

  // 6. تسجيل التعديل في ورقة سجل التعديلات
  await logEdit({
    editorPhone,
    editorName,
    producerPhone: transaction.producerPhone,
    captainPhone: transaction.captainPhone,
    oldQuantity,
    newQuantity,
  });

  logger.info(`✏️ تعديل ناجح: ${editorPhone} غيّر من ${oldQuantity} إلى ${newQuantity} (فرق: ${diff})`);
  return { success: true, message: `تم التعديل: ${oldQuantity} → ${newQuantity} (فرق: ${diff > 0 ? '+' : ''}${diff})`, diff };
}

// ====================================================
// الكشف التفصيلي
// ====================================================

/**
 * جلب كشف تفصيلي لرقم معين من سجل الحركات
 * @param {string} phone - رقم الهاتف المطلوب كشفه
 * @param {string} groupPrefix - بادئة الجروب
 * @param {Date|null} fromDate - تاريخ البداية (null = الجمعة الماضية)
 * @param {Date|null} toDate - تاريخ النهاية (null = الآن)
 * @returns {object} { success, report, totalProduction, totalReception }
 */
async function getDetailedReport(phone, groupPrefix, fromDate = null, toDate = null) {
  if (!isInitialized || !phone) return { success: false, report: 'بيانات غير مكتملة' };

  const transSheet = config.sheets.sheetNames.transactions || 'سجل الحركات';
  const cleanPhone = phone.replace(/\D/g, '');

  // حساب فترة الكشف (الجمعة للجمعة)
  const now = new Date();
  const jordanNow = new Date(now.getTime() + (3 * 60 * 60 * 1000));

  if (!fromDate) {
    // الجمعة الماضية 23:00
    fromDate = new Date(jordanNow);
    const day = fromDate.getUTCDay(); // 0=Sun, 5=Fri
    const diff = (day >= 5) ? (day - 5) : (day + 2);
    fromDate.setUTCDate(fromDate.getUTCDate() - diff);
    fromDate.setUTCHours(0, 0, 0, 0);
    // إذا كان اليوم جمعة قبل 11م، نرجع للأسبوع الماضي
    if (day === 5 && jordanNow.getUTCHours() < 23) {
      fromDate.setUTCDate(fromDate.getUTCDate() - 7);
    }
  }
  if (!toDate) {
    toDate = jordanNow;
  }

  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${transSheet}'!A:J`,
    });
    const rows = response.data.values || [];

    // جلب اسم الشخص من ورقة المسجلين
    const regSheet = config.sheets.sheetNames.registeredUsers || 'المسجلين';
    let registeredNames = {};
    try {
      const regResponse = await sheetsApi.spreadsheets.values.get({
        spreadsheetId,
        range: `'${regSheet}'!A:B`,
      });
      const regRows = regResponse.data.values || [];
      for (const row of regRows) {
        if (row[0]) {
          registeredNames[row[0].replace(/\D/g, '')] = row[1] || '';
        }
      }
    } catch (e) { /* تجاهل */ }

    // الحصول على اسم صاحب الكشف
    const ownerName = Object.entries(registeredNames).find(([k]) => 
      k.endsWith(cleanPhone.slice(-9)) || cleanPhone.endsWith(k.slice(-9))
    )?.[1] || '';

    // فلترة العمليات
    const transactions = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[1]) continue;

      const rowTime = new Date(row[1]);
      if (isNaN(rowTime.getTime())) continue;
      if (rowTime < fromDate || rowTime > toDate) continue;

      // فلترة الجروب
      const rowPrefix = row[7] || '';
      if (groupPrefix && rowPrefix !== groupPrefix) continue;

      const rowProducer = (row[2] || '').replace(/\D/g, '');
      const rowCaptain = (row[3] || '').replace(/\D/g, '');
      const rowStatus = row[8] || '';

      // هل الشخص مشارك في هذه العملية؟
      const isProducer = cleanPhone.endsWith(rowProducer.slice(-9)) || rowProducer.endsWith(cleanPhone.slice(-9));
      const isCaptain = cleanPhone.endsWith(rowCaptain.slice(-9)) || rowCaptain.endsWith(cleanPhone.slice(-9));

      if (!isProducer && !isCaptain) continue;

      const qty = parseFloat(row[4]) || 0;
      const type = row[5] || '';
      const emoji = row[6] || '';

      // جلب اسم الطرف الآخر
      let otherPhone = '';
      let otherName = '';
      let role = '';

      if (isProducer) {
        role = 'إنتاج';
        otherPhone = row[3] || '';
        const otherClean = otherPhone.replace(/\D/g, '');
        otherName = Object.entries(registeredNames).find(([k]) => 
          k.endsWith(otherClean.slice(-9)) || otherClean.endsWith(k.slice(-9))
        )?.[1] || otherPhone;
      }
      if (isCaptain) {
        role = 'استلام';
        otherPhone = row[2] || '';
        const otherClean = otherPhone.replace(/\D/g, '');
        otherName = Object.entries(registeredNames).find(([k]) => 
          k.endsWith(otherClean.slice(-9)) || otherClean.endsWith(k.slice(-9))
        )?.[1] || otherPhone;
      }

      // إذا كان الشخص منتج وكابتن في نفس العملية (نادر)، نسجله كمنتج
      if (isProducer && isCaptain) role = 'إنتاج+استلام';

      transactions.push({
        time: rowTime,
        qty,
        type,
        role,
        status: rowStatus,
        otherName,
        otherPhone,
        emoji,
      });
    }

    if (transactions.length === 0) {
      return { success: true, report: `لا توجد عمليات لهذا الرقم في الفترة المحددة`, totalProduction: 0, totalReception: 0 };
    }

    // ترتيب حسب التاريخ
    transactions.sort((a, b) => a.time - b.time);

    // تجميع حسب اليوم
    const days = {};
    let totalProduction = 0;
    let totalReception = 0;

    for (const t of transactions) {
      const dayKey = t.time.toISOString().substring(0, 10);
      if (!days[dayKey]) days[dayKey] = [];
      days[dayKey].push(t);

      if (t.status === 'ملغى' || t.status === 'ملغاة') continue;
      if (t.role === 'إنتاج') totalProduction += t.qty;
      else if (t.role === 'استلام') totalReception += t.qty;
    }

    // بناء نص الكشف
    const dayNames = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    let report = `📊 *كشف تفصيلي*\n`;
    report += `👤 ${ownerName || phone}\n`;
    report += `📱 ${phone}\n`;
    report += `📅 ${fromDate.toISOString().substring(0, 10)} → ${toDate.toISOString().substring(0, 10)}\n`;
    report += `📦 الجروب: ${groupPrefix}\n`;
    report += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const [dayKey, dayTransactions] of Object.entries(days)) {
      const d = new Date(dayKey);
      const dayName = dayNames[d.getUTCDay()];
      report += `━━━ ${dayName} ${dayKey.substring(5)} ━━━\n`;

      for (const t of dayTransactions) {
        const timeStr = t.time.toISOString().substring(11, 16);
        let icon = '🟢';
        if (t.role === 'استلام') icon = '🔵';
        if (t.status === 'ملغى' || t.status === 'ملغاة') icon = '❌';
        if (t.type === 'إلغاء') icon = '❌';
        if (t.status === 'معدّل') icon = '✏️';

        const direction = t.role === 'إنتاج' ? '→ استلم:' : '← من:';
        report += `${icon} ${timeStr} | ${t.role} ${t.qty} ${direction} ${t.otherName}\n`;
      }
      report += `\n`;
    }

    report += `━━━━━━━━━━━━━━━━━━━━\n`;
    report += `📦 إجمالي الإنتاج: ${totalProduction}\n`;
    report += `📥 إجمالي الاستلام: ${totalReception}\n`;
    report += `📊 الصافي: ${totalProduction - totalReception >= 0 ? '+' : ''}${totalProduction - totalReception}`;

    return { success: true, report, totalProduction, totalReception };
  } catch (error) {
    logger.error('فشل جلب الكشف التفصيلي', { error: error.message });
    return { success: false, report: 'خطأ تقني في جلب الكشف' };
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
  // المسجلين
  loadRegisteredUsers,
  getRegisteredName,
  findPhoneByName,
  updateWhatsappName,
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
  // التعديل
  processEdit,
  findTransactionByMessageId,
  canEdit,
  logEdit,
  // الكشف التفصيلي
  getDetailedReport,
  // deprecated (للتوافق)
  updateBalance,
  updateTotals,
  getBalance,
  recordOrder,
  getOrderOwnerByMessageId,
  updateOrderStatus,
};
