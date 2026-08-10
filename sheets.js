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

// مسار ملف Service Account — يبحث أولاً في VOLUME_PATH ثم في المجلد الحالي
const VOLUME_PATH = process.env.VOLUME_PATH || './data';
const SA_KEY_PATH = fs.existsSync(path.resolve(VOLUME_PATH, 'service-account.json'))
  ? path.resolve(VOLUME_PATH, 'service-account.json')
  : path.resolve('./service-account.json');
// محتوى Service Account من Environment Variable (بديل عن الملف)
const SA_KEY_ENV = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || null;

// كاش لأسماء الأوراق الموجودة (لتجنب إنشاء مكرر)
const existingSheets = new Set();

// كاش أسماء المسجلين { normalizedPhone → { name, whatsappName, lid, rowIndex } }
// name: الاسم الرسمي (عمود B)
// whatsappName: اسم واتساب (عمود C) - اختياري
// lid: معرف LID (عمود D) - يُضاف تلقائياً عند حل LID
let registeredUsersCache = new Map();
let lastRegisteredUsersLoad = 0;
const REGISTERED_USERS_CACHE_TTL = 5 * 60 * 1000; // 5 دقائق

// خريطة LID → phone مبنية من ورقة المسجلين
const registeredLidToPhone = new Map();

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

  // استخدام Service Account بدلاً من OAuth — لا ينتهي أبداً
  let saKey = null;
  if (SA_KEY_ENV) {
    // قراءة من Environment Variable (Railway)
    try {
      saKey = JSON.parse(SA_KEY_ENV);
      logger.info('[Service Account] تم تحميل المفتاح من GOOGLE_SERVICE_ACCOUNT_JSON');
    } catch (e) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON غير صالح: ' + e.message);
    }
  } else if (fs.existsSync(SA_KEY_PATH)) {
    // قراءة من ملف (للتطوير المحلي)
    saKey = JSON.parse(fs.readFileSync(SA_KEY_PATH, 'utf8'));
    logger.info('[Service Account] تم تحميل المفتاح من الملف: ' + SA_KEY_PATH);
  } else {
    throw new Error('لم يُعثر على Service Account! أضف GOOGLE_SERVICE_ACCOUNT_JSON كـ Environment Variable في Railway');
  }
  if (saKey.type !== 'service_account')
    throw new Error('Service Account غير صالح — يجب أن يكون type: service_account');

  const auth = new google.auth.GoogleAuth({
    credentials: saKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsApi = google.sheets({ version: 'v4', auth });

  try {
    const response = await sheetsApi.spreadsheets.get({ spreadsheetId });
    const title = response.data.properties?.title;
    // تحميل أسماء الأوراق الموجودة
    if (response.data.sheets) {
      for (const sheet of response.data.sheets) {
        existingSheets.add(sheet.properties.title);
      }
    }
    logger.info('✅ [Service Account] تم الاتصال بالجدول', { title, sheets: existingSheets.size });
    isInitialized = true;
    
    // ضمان وجود أوراق التسجيل
    await ensureRegistrationSheets();
    
    // تحميل أسماء المسجلين في الكاش
    await loadRegisteredUsers();
  } catch (error) {
    if (error.code === 403)
      throw new Error('Service Account لا يملك صلاحية الوصول للجدول! شارك الجدول مع: ' + (saKey.client_email || 'unknown'));
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
    // نقرأ A:D للحصول على: A=الهاتف، B=الاسم الرسمي، C=اسم واتساب، D=LID
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:D`,
    });
    const rows = response.data.values || [];
    const newCache = new Map();
    registeredLidToPhone.clear();
    
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row[0]) {
        const np = normalizePhone(row[0]);
        if (np) {
          const lid = (row[3] || '').trim(); // عمود D: LID
          newCache.set(np, {
            name: (row[1] || '').trim(),
            whatsappName: (row[2] || '').trim(),  // عمود C: اسم واتساب
            lid,
            rowIndex: i + 1,
          });
          // بناء خريطة LID → phone
          if (lid && lid.includes('@lid')) {
            registeredLidToPhone.set(lid, np);
            // base-prefix matching
            const base = lid.split(':')[0];
            if (base !== lid) registeredLidToPhone.set(base + '@lid', np);
          }
        }
      }
    }
    
    registeredUsersCache = newCache;
    lastRegisteredUsersLoad = now;
    logger.info(`📚 تم تحميل ${newCache.size} مسجل من ورقة المسجلين (${registeredLidToPhone.size} LID مرتبط)`);
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

  // تطبيع النص العربي: حذف التشكيل وتوحيد الألف وحذف الألقاب
  function normalizeAr(s) {
    if (!s) return '';
    return s
      .trim()
      .toLowerCase()
      // حذف الألقاب الشائعة في أسماء واتساب (ك., كابتن, أبو, أم, ابو, ام)
      .replace(/^(ك\.|كابتن|أبو|ابو|أم|ام|د\.|دكتور|k\.|capt\.?|captain|dr\.?|mr\.?|ms\.?|mrs\.?)\s+/i, '')
      .replace(/[ً-ٰٟ]/g, '')           // حذف التشكيل
      .replace(/[آأإٱ]/g, 'ا')         // توحيد الألف
      .replace(/ة/g, 'ه')              // تاء مربوطة
      .replace(/ى/g, 'ي')              // ألف مقصورة
      .replace(/وو/g, 'و')             // واو مضاعف
      .replace(/يي/g, 'ي')             // ياء مضاعف
      .replace(/\s+/g, ' ')          // مسافات متعددة
      .trim();
  }

  const cleanName = normalizeAr(pushName);
  if (!cleanName) return null;
  const nameWords = cleanName.split(' ').filter(w => w.length > 1);

  // مساعد: استخراج الأسماء من الكاش (سواء string أو object)
  function getNames(entry) {
    if (!entry) return [];
    if (typeof entry === 'string') return [normalizeAr(entry)].filter(Boolean);
    return [
      normalizeAr(entry.name || ''),
      normalizeAr(entry.whatsappName || '')
    ].filter(Boolean);
  }

  // 1. مطابقة تامة (بعد التطبيع)
  for (const [phone, entry] of registeredUsersCache.entries()) {
    const names = getNames(entry);
    if (names.some(n => n === cleanName)) return phone;
  }

  // 2. بحث جزئي (الاسم يحتوي على pushName أو العكس)
  for (const [phone, entry] of registeredUsersCache.entries()) {
    const names = getNames(entry);
    if (names.some(n => n.includes(cleanName) || cleanName.includes(n))) return phone;
  }

  // 3. مطابقة على مستوى الكلمات (أي كلمتين مشتركتين)
  if (nameWords.length >= 2) {
    for (const [phone, entry] of registeredUsersCache.entries()) {
      const names = getNames(entry);
      for (const n of names) {
        const nWords = n.split(' ').filter(w => w.length > 1);
        const commonWords = nameWords.filter(w => nWords.includes(w));
        if (commonWords.length >= 2) return phone;
      }
    }
  }

  // 4. مطابقة أول كلمتين (الاسم الأول + الثاني)
  if (nameWords.length >= 1) {
    const firstWord = nameWords[0];
    if (firstWord.length >= 3) {
      for (const [phone, entry] of registeredUsersCache.entries()) {
        const names = getNames(entry);
        for (const n of names) {
          const nWords = n.split(' ').filter(w => w.length > 1);
          if (nWords.some(w => w === firstWord || w.startsWith(firstWord) || firstWord.startsWith(w))) {
            return phone;
          }
        }
      }
    }
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

/**
 * حل LID إلى رقم هاتف من ورقة المسجلين
 * يبحث في خريطة registeredLidToPhone أولاً (O(1))
 * @param {string} lid - معرف LID
 * @returns {string|null} رقم الهاتف (9 أرقام) أو null
 */
function resolvePhoneFromRegistered(lid) {
  if (!lid) return null;
  // مطابقة تامة
  const direct = registeredLidToPhone.get(lid);
  if (direct) return direct;
  // base-prefix matching
  const base = lid.split(':')[0];
  const baseMatch = registeredLidToPhone.get(base + '@lid');
  if (baseMatch) { registeredLidToPhone.set(lid, baseMatch); return baseMatch; }
  // بحث خطي (آخر حل)
  for (const [k, v] of registeredLidToPhone.entries()) {
    if (k.split(':')[0] === base) { registeredLidToPhone.set(lid, v); return v; }
  }
  return null;
}

/**
 * تحديث عمود D (الLID) في ورقة المسجلين
 * يُستدعى عند حل LID جديد لربطه برقم الهاتف
 * @param {string} phone - رقم الهاتف (9 أرقام)
 * @param {string} lid - معرف LID
 */
async function updateLidInRegistered(phone, lid) {
  if (!isInitialized || !phone || !lid) return;
  const np = normalizePhone(phone);
  if (!np) return;
  const entry = registeredUsersCache.get(np);
  if (!entry) return; // ليس مسجلاً
  if (entry.lid === lid) return; // لا تغيير
  
  // تحديث الكاش محلياً
  registeredUsersCache.set(np, { ...entry, lid });
  registeredLidToPhone.set(lid, np);
  const base = lid.split(':')[0];
  if (base !== lid) registeredLidToPhone.set(base + '@lid', np);
  
  // تحديث ورقة المسجلين في Sheets (عمود D)
  const sheetName = config.sheets.sheetNames.registeredUsers || 'المسجلين';
  try {
    const rowIndex = entry.rowIndex;
    if (!rowIndex) return;
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!D${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[lid]] },
    });
    logger.info(`🔗 ربط LID: ${np} → ${lid.substring(0,15)}...`);
  } catch (error) {
    logger.debug('فشل تحديث LID في المسجلين', { error: error.message });
  }
}

/**
 * الحصول على خريطة LID → phone من ورقة المسجلين
 */
function getRegisteredLidMap() { return registeredLidToPhone; }

/**
 * تسجيل عضو جديد تلقائياً في ورقة المسجلين عند انضمامه للجروب
 * يُضيف رقم الهاتف فقط (بدون اسم) ليملأه المشرف لاحقاً
 * @param {string} jid - JID العضو (phone@s.whatsapp.net أو LID@lid)
 * @param {string} pushName - اسم واتساب (اختياري)
 * @param {string} groupName - اسم الجروب
 * @returns {boolean} صحيح إذا تم التسجيل
 */
async function addNewMemberToRegistered(jid, pushName = '', groupName = '') {
  if (!isInitialized || !jid) return false;
  
  // استخراج رقم الهاتف
  let phone = '';
  let lid = '';
  
  if (jid.includes('@s.whatsapp.net')) {
    phone = normalizePhone(jid.split('@')[0]);
  } else if (jid.includes('@lid')) {
    lid = jid;
    // محاولة حل LID من الخريطة الحالية
    const resolved = resolvePhoneFromRegistered(lid);
    if (resolved) phone = resolved;
  }
  
  if (!phone && !lid) return false;
  
  // تحقق من عدم وجوده مسبقاً
  if (phone && registeredUsersCache.has(phone)) return false; // مسجل بالفعل
  
  const sheetName = config.sheets.sheetNames.registeredUsers || 'المسجلين';
  try {
    // إضافة صف جديد: رقم الهاتف | فارغ (للاسم) | اسم واتساب | LID
    const row = [
      phone ? `962${phone}` : '',  // عمود A: رقم الهاتف بمفتاح الدولة
      '',                           // عمود B: الاسم الرسمي (يملأه المشرف)
      pushName || '',               // عمود C: اسم واتساب
      lid || '',                    // عمود D: LID
    ];
    
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId,
      range: `'${sheetName}'!A:D`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    
    // تحديث الكاش محلياً
    if (phone) {
      registeredUsersCache.set(phone, { name: '', whatsappName: pushName || '', lid: lid || '' });
      if (lid) {
        registeredLidToPhone.set(lid, phone);
        const base = lid.split(':')[0];
        if (base !== lid) registeredLidToPhone.set(base + '@lid', phone);
      }
    }
    
    logger.info(`👤 عضو جديد: ${phone || lid.substring(0,15)} في ${groupName} — تم التسجيل تلقائياً`);
    return true;
  } catch (error) {
    logger.debug('فشل تسجيل عضو جديد', { error: error.message });
    return false;
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
      // مطابقة: معرف العملية (A) أو messageId في عمود I أو الملاحظات (J)
      const txId = rows[i][0] || '';
      const txMsgId = rows[i][8] || ''; // عمود I = messageId
      const txNotes = rows[i][9] || ''; // عمود J = ملاحظات
      const cleanTxId = txId.startsWith('CANCELLED_') ? txId.replace('CANCELLED_', '') : txId;
      if (cleanTxId === targetId || txId === targetId || txMsgId === targetId || 
          txMsgId.includes(targetId) || txNotes.includes(targetId)) {
        rowIndex = i + 1;
        transactionData = {
          id: txId,
          time: new Date(rows[i][1]),
          producer: rows[i][2],
          captain: rows[i][3],
          qty: parseFloat(rows[i][4]),
          type: rows[i][5],
          prefix: rows[i][7],
          isCancelled: txId.startsWith('CANCELLED_') || txNotes.includes('ملغى')
        };
        break;
      }
    }

    if (!transactionData) return { success: false, message: 'العملية غير موجودة' };
    if (transactionData.isCancelled) return { success: false, message: 'العملية ملغاة بالفعل' };

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
    await updateTransactionStatus(rowIndex, {
      status: 'ملغى',
      quantity: 0, // تصفير الكمية في السجل أيضاً لتجنب الحسابات الخاطئة لاحقاً
      notes: `تم الإلغاء بواسطة ${supervisorPhone} في ${new Date().toLocaleString('ar-JO')} | ملغى`
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
    transaction.messageId || transaction.status || 'نشط', // العمود I كان مخصص للحالة، الآن هو لمعرف الرسالة
    transaction.notes || transaction.status || '' // العمود J للملاحظات، يمكننا حفظ الحالة فيه
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
      const rowMsgId = row[8] || '';
      const rowNotes = row[9] || '';

      // تخطي الملغاة (نعرفها إذا كان معرف العملية يبدأ بـ CANCELLED أو الملاحظات تحتوي على ملغى)
      if (rowId.startsWith('CANCELLED') || rowNotes.includes('ملغى')) continue;

      // مطابقة: messageId في العمود المخصص له (I) أو ضمن الملاحظات (J)
      const idMatch = rowMsgId === messageId || rowMsgId.includes(messageId) || 
                      rowNotes.includes(messageId) || rowId.includes(messageId);
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
          status: row[8], // عمود I = messageId (اسم الحقل قديم لكنه يحمل messageId الآن)
          notes: row[9],  // عمود J = المصدر (reply/reaction) أو ملاحظات
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
          transaction.status, // عمود I = messageId (نحافظ على قيمته الأصلية من transaction.status الذي يحمل messageId)
          `تعديل من ${oldQuantity} إلى ${newQuantity} بواسطة ${editorPhone} في ${new Date().toISOString()} | ${transaction.notes || ''}` // عمود J = Notes
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

// ====================================================
// لوحة التحكم — API للواجهة الويب
// ====================================================

/**
 * جلب قائمة الأوراق اليومية لجروب محدد
 * @param {string} prefix - بادئة الجروب (مثل 'دريمكس')
 * @returns {Array<{name, date, totalProduction, totalReception}>}
 */
async function getDaysList(prefix) {
  if (!isInitialized) return [];
  try {
    const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
    const sheets = meta.data.sheets || [];
    const pattern = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})$`);
    const days = [];
    
    for (const sheet of sheets) {
      const title = sheet.properties.title;
      const match = title.match(pattern);
      if (!match) continue;
      const date = match[1];
      
      // جلب مجموع الانتاج والاستلام
      try {
        const res = await sheetsApi.spreadsheets.values.get({
          spreadsheetId,
          range: `'${title}'!A:D`,
        });
        const rows = (res.data.values || []).slice(1); // تخطي الرأس
        let totalProd = 0, totalRecv = 0;
        for (const row of rows) {
          if (!row[0]) continue;
          totalProd += parseInt(row[2]) || 0;
          totalRecv += parseInt(row[3]) || 0;
        }
        days.push({ name: title, date, totalProduction: totalProd, totalReception: totalRecv, rows: rows.length });
      } catch (e) {
        days.push({ name: title, date, totalProduction: 0, totalReception: 0, rows: 0 });
      }
    }
    
    // ترتيب تنازلي (الأحدث أولاً)
    days.sort((a, b) => b.date.localeCompare(a.date));
    return days;
  } catch (error) {
    logger.warn('فشل getDaysList', { error: error.message });
    return [];
  }
}

/**
 * جلب بيانات يوم محدد
 * @param {string} sheetName - اسم الورقة (مثل 'دريمكس-2026-08-07')
 * @returns {Array<{phone, name, production, reception}>}
 */
async function getDayData(sheetName) {
  if (!isInitialized) return [];
  try {
    const res = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:D`,
    });
    const rows = (res.data.values || []).slice(1);
    return rows
      .filter(r => r[0])
      .map(r => ({
        phone: r[0] || '',
        name: r[1] || '',
        production: parseInt(r[2]) || 0,
        reception: parseInt(r[3]) || 0,
      }));
  } catch (error) {
    logger.warn('فشل getDayData', { error: error.message });
    return [];
  }
}

// ====================================================
// ورقة المحذوف — تسجيل الرسائل المحذوفة
// ====================================================

async function ensureDeletedSheet() {
  const sheetName = 'المحذوف';
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
      range: `'المحذوف'!A1:F1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['التاريخ', 'الساعة', 'الرقم', 'الاسم', 'نص الرسالة', 'معرف الرسالة']],
      },
    });
    existingSheets.add(sheetName);
    logger.info('🗑️ تم إنشاء ورقة المحذوف');
  } catch (e) {
    if (e.message?.includes('already exists')) existingSheets.add('المحذوف');
    else logger.debug('فشل إنشاء ورقة المحذوف', { error: e.message });
  }
}

/**
 * تسجيل رسالة محذوفة في ورقة المحذوف
 * @param {object} data
 * @param {string} data.phone - رقم من حذف الرسالة
 * @param {string} data.name - اسم من حذف
 * @param {string} data.text - نص الرسالة
 * @param {string} data.messageId - معرف الرسالة
 */
async function saveDeletedMessage(data) {
  if (!isInitialized) return;
  await ensureDeletedSheet();
  
  const now = new Date();
  const jordanTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
  const dateStr = `${jordanTime.getUTCFullYear()}-${String(jordanTime.getUTCMonth()+1).padStart(2,'0')}-${String(jordanTime.getUTCDate()).padStart(2,'0')}`;
  const timeStr = `${String(jordanTime.getUTCHours()).padStart(2,'0')}:${String(jordanTime.getUTCMinutes()).padStart(2,'0')}:${String(jordanTime.getUTCSeconds()).padStart(2,'0')}`;
  
  try {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId,
      range: `'المحذوف'!A:F`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          dateStr,
          timeStr,
          data.phone || '',
          data.name || '',
          data.text || '[رسالة غير نصية]',
          data.messageId || '',
        ]],
      },
    });
    logger.info(`🗑️ تسجيل رسالة محذوفة: ${data.phone} — ${(data.text||'').substring(0,30)}`);
  } catch (error) {
    logger.debug('فشل تسجيل المحذوف', { error: error.message });
  }
}

// ====================================================
// ورقة الرئيسية (لوحة التحكم) داخل الشيت
// ====================================================

/**
 * إنشاء أو تحديث ورقة الرئيسية في الشيت
 * تعرض ملخصاً لكل جروب مع روابط مباشرة لجميع الأوراق
 */
async function createDashboardSheet() {
  if (!isInitialized) return;
  const DASHBOARD_NAME = '🏠 الرئيسية';
  const groups = config.whatsapp.targetGroups;

  // ألوان كل جروب (بنظام Azara)
  const GROUP_COLORS = [
    { bg: { red: 0.067, green: 0.282, blue: 0.529 }, fg: { red: 1, green: 1, blue: 1 }, rowBg: { red: 0.878, green: 0.918, blue: 0.965 }, altBg: { red: 0.937, green: 0.957, blue: 0.984 } }, // أزرق غامق
    { bg: { red: 0.106, green: 0.369, blue: 0.188 }, fg: { red: 1, green: 1, blue: 1 }, rowBg: { red: 0.878, green: 0.965, blue: 0.898 }, altBg: { red: 0.937, green: 0.984, blue: 0.945 } }, // أخضر غامق
    { bg: { red: 0.494, green: 0.114, blue: 0.114 }, fg: { red: 1, green: 1, blue: 1 }, rowBg: { red: 0.984, green: 0.878, blue: 0.878 }, altBg: { red: 0.984, green: 0.937, blue: 0.937 } }, // أحمر غامق
  ];

  try {
    // جلب بيانات الشيت كاملة
    const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
    const allSheets = meta.data.sheets || [];
    const allTitles = allSheets.map(s => s.properties.title);

    // إنشاء الورقة إذا لم تكن موجودة
    if (!allTitles.includes(DASHBOARD_NAME)) {
      await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title: DASHBOARD_NAME,
                index: 0,
                rightToLeft: true,
                gridProperties: { rowCount: 500, columnCount: 8 }
              }
            }
          }]
        }
      });
      logger.info('🏠 تم إنشاء ورقة الرئيسية');
    }

    // جلب sheetId لورقة الرئيسية
    const metaAfter = await sheetsApi.spreadsheets.get({ spreadsheetId });
    const allSheetsAfter = metaAfter.data.sheets || [];
    const dashSheet = allSheetsAfter.find(s => s.properties.title === DASHBOARD_NAME);
    const dashSheetId = dashSheet?.properties?.sheetId;
    if (dashSheetId === undefined) return;

    // توقيت الأردن GMT+3
    const now = new Date();
    const jordanNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const dateStr = jordanNow.toLocaleDateString('ar-JO', { timeZone: 'Asia/Amman', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = jordanNow.toLocaleTimeString('ar-JO', { timeZone: 'Asia/Amman', hour: '2-digit', minute: '2-digit' });

    // ====================================================
    // بناء بيانات الورقة
    // الهيكل: A-H (8 أعمدة)
    // A: اليوم  B: الانتاج  C: الاستلام  D: فتح  E-H: فارغ
    // ====================================================
    const values = [];
    const requests = []; // طلبات التنسيق
    const merges = [];   // طلبات الدمج
    let R = 0; // مؤشر السطر الحالي (0-indexed)

    // ====================================================
    // سطر 1: عنوان رئيسي ضخم (3 سطور مدمجة)
    // ====================================================
    values.push(['📊 لوحة التحكم — AbuSaif', '', '', '', '', '', '', '']);
    values.push(['', '', '', '', '', '', '', '']);
    values.push(['', '', '', '', '', '', '', '']);
    merges.push({ startRowIndex: R, endRowIndex: R + 3, startColumnIndex: 0, endColumnIndex: 8 });
    requests.push({
      repeatCell: {
        range: { sheetId: dashSheetId, startRowIndex: R, endRowIndex: R + 3, startColumnIndex: 0, endColumnIndex: 8 },
        cell: { userEnteredFormat: {
          backgroundColor: { red: 0.047, green: 0.047, blue: 0.137 },
          textFormat: { bold: true, fontSize: 22, foregroundColor: { red: 1, green: 0.843, blue: 0.0 }, fontFamily: 'Arial' },
          horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
          wrapStrategy: 'WRAP'
        }},
        fields: 'userEnteredFormat'
      }
    });
    R += 3;

    // سطر التاريخ (2 سطر مدمجة)
    values.push(['🕒 آخر تحديث: ' + dateStr + '  |  الساعة ' + timeStr, '', '', '', '', '', '', '']);
    values.push(['', '', '', '', '', '', '', '']);
    merges.push({ startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 0, endColumnIndex: 8 });
    requests.push({
      repeatCell: {
        range: { sheetId: dashSheetId, startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 0, endColumnIndex: 8 },
        cell: { userEnteredFormat: {
          backgroundColor: { red: 0.094, green: 0.094, blue: 0.22 },
          textFormat: { italic: true, fontSize: 11, foregroundColor: { red: 0.749, green: 0.749, blue: 0.949 } },
          horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
        }},
        fields: 'userEnteredFormat'
      }
    });
    R += 2;

    // سطر فارغ فاصل
    values.push(['', '', '', '', '', '', '', '']);
    requests.push({
      repeatCell: {
        range: { sheetId: dashSheetId, startRowIndex: R, endRowIndex: R + 1, startColumnIndex: 0, endColumnIndex: 8 },
        cell: { userEnteredFormat: { backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 } } },
        fields: 'userEnteredFormat'
      }
    });
    R += 1;

    // ====================================================
    // صندوق الأوراق العامة
    // ====================================================
    const fixedSheets = [
      { title: '👥 المسجلين', name: 'المسجلين' },
      { title: '🗑️ المحذوف', name: 'المحذوف' },
      { title: '✏️ سجل التعديلات', name: 'سجل التعديلات' },
      { title: '📜 سجل الحركات', name: 'سجل الحركات' },
    ];
    const availableFixed = fixedSheets.filter(fs => allTitles.includes(fs.name));

    if (availableFixed.length > 0) {
      // عنوان قسم الأوراق العامة (2 سطر)
      values.push(['📂  الأوراق العامة', '', '', '', '', '', '', '']);
      values.push(['', '', '', '', '', '', '', '']);
      merges.push({ startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 0, endColumnIndex: 8 });
      requests.push({
        repeatCell: {
          range: { sheetId: dashSheetId, startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 0, endColumnIndex: 8 },
          cell: { userEnteredFormat: {
            backgroundColor: { red: 0.2, green: 0.2, blue: 0.35 },
            textFormat: { bold: true, fontSize: 13, foregroundColor: { red: 1, green: 1, blue: 1 } },
            horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
          }},
          fields: 'userEnteredFormat'
        }
      });
      R += 2;

      // صفوف الأوراق العامة (2 سطر لكل ورقة)
      for (const fs of availableFixed) {
        const sheetObj = allSheetsAfter.find(s => s.properties.title === fs.name);
        const gid = sheetObj?.properties?.sheetId;
        const link = gid !== undefined
          ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}`
          : '';
        const cellVal = link ? '=HYPERLINK("' + link + '","' + fs.title + '  ← اضغط للفتح")' : fs.title;
        values.push([cellVal, '', '', '', '', '', '', '']);
        values.push(['', '', '', '', '', '', '', '']);
        merges.push({ startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 0, endColumnIndex: 8 });
        requests.push({
          repeatCell: {
            range: { sheetId: dashSheetId, startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 0, endColumnIndex: 8 },
            cell: { userEnteredFormat: {
              backgroundColor: { red: 0.937, green: 0.937, blue: 0.98 },
              textFormat: { bold: false, fontSize: 12, foregroundColor: { red: 0.1, green: 0.1, blue: 0.5 } },
              horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
            }},
            fields: 'userEnteredFormat'
          }
        });
        R += 2;
      }

      // فاصل
      values.push(['', '', '', '', '', '', '', '']);
      requests.push({
        repeatCell: {
          range: { sheetId: dashSheetId, startRowIndex: R, endRowIndex: R + 1, startColumnIndex: 0, endColumnIndex: 8 },
          cell: { userEnteredFormat: { backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 } } },
          fields: 'userEnteredFormat'
        }
      });
      R += 1;
    }

    // ====================================================
    // صندوق كل جروب
    // ====================================================
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const prefix = group.prefix;
      const color = GROUP_COLORS[gi % GROUP_COLORS.length];
      const pattern = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})$`);

      // جمع أوراق هذا الجروب مرتبة تنازلياً
      const groupSheets = allSheetsAfter
        .filter(s => pattern.test(s.properties.title))
        .sort((a, b) => b.properties.title.localeCompare(a.properties.title));

      // حساب إجمالي الجروب
      let totalProd = 0, totalRecv = 0;
      const dayRows = [];
      for (const s of groupSheets) {
        try {
          const res = await sheetsApi.spreadsheets.values.get({
            spreadsheetId,
            range: `'${s.properties.title}'!C:D`,
          });
          const rows = (res.data.values || []).slice(1);
          let dp = 0, dr = 0;
          for (const r of rows) {
            dp += parseInt(r[0]) || 0;
            dr += parseInt(r[1]) || 0;
          }
          totalProd += dp;
          totalRecv += dr;
          const gid = s.properties.sheetId;
          const link = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}`;
          dayRows.push({ title: s.properties.title, prod: dp, recv: dr, link });
        } catch (e) {
          dayRows.push({ title: s.properties.title, prod: 0, recv: 0, link: '' });
        }
      }

      // --- عنوان الجروب (3 سطور مدمجة) ---
      values.push([prefix + '  |  إجمالي الانتاج: ' + totalProd + '   إجمالي الاستلام: ' + totalRecv, '', '', '', '', '', '', '']);
      values.push(['', '', '', '', '', '', '', '']);
      values.push(['', '', '', '', '', '', '', '']);
      merges.push({ startRowIndex: R, endRowIndex: R + 3, startColumnIndex: 0, endColumnIndex: 8 });
      requests.push({
        repeatCell: {
          range: { sheetId: dashSheetId, startRowIndex: R, endRowIndex: R + 3, startColumnIndex: 0, endColumnIndex: 8 },
          cell: { userEnteredFormat: {
            backgroundColor: color.bg,
            textFormat: { bold: true, fontSize: 16, foregroundColor: color.fg },
            horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
            wrapStrategy: 'WRAP'
          }},
          fields: 'userEnteredFormat'
        }
      });
      R += 3;

      if (dayRows.length === 0) {
        // لا توجد بيانات
        values.push(['لا توجد بيانات بعد', '', '', '', '', '', '', '']);
        merges.push({ startRowIndex: R, endRowIndex: R + 1, startColumnIndex: 0, endColumnIndex: 8 });
        requests.push({
          repeatCell: {
            range: { sheetId: dashSheetId, startRowIndex: R, endRowIndex: R + 1, startColumnIndex: 0, endColumnIndex: 8 },
            cell: { userEnteredFormat: {
              backgroundColor: color.altBg,
              textFormat: { italic: true, fontSize: 11, foregroundColor: { red: 0.5, green: 0.5, blue: 0.5 } },
              horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
            }},
            fields: 'userEnteredFormat'
          }
        });
        R += 1;
      } else {
        // --- رأس الجدول (2 سطر) ---
        values.push(['📅 اليوم', '📦 الانتاج', '📥 الاستلام', '🔗 فتح', '', '', '', '']);
        values.push(['', '', '', '', '', '', '', '']);
        merges.push({ startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 0, endColumnIndex: 1 });
        merges.push({ startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 1, endColumnIndex: 2 });
        merges.push({ startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 2, endColumnIndex: 3 });
        merges.push({ startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 3, endColumnIndex: 8 });
        requests.push({
          repeatCell: {
            range: { sheetId: dashSheetId, startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 0, endColumnIndex: 8 },
            cell: { userEnteredFormat: {
              backgroundColor: color.bg,
              textFormat: { bold: true, fontSize: 12, foregroundColor: { red: 1, green: 1, blue: 0.8 } },
              horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
              borders: {
                bottom: { style: 'SOLID', width: 2, color: { red: 1, green: 1, blue: 1 } }
              }
            }},
            fields: 'userEnteredFormat'
          }
        });
        R += 2;

        // --- أسطر الأيام (2 سطر لكل يوم) ---
        for (let di = 0; di < dayRows.length; di++) {
          const d = dayRows[di];
          const dateLabel = d.title.replace(prefix + '-', '');
          const rowColor = di % 2 === 0 ? color.rowBg : color.altBg;
          const dayLink = d.link ? '=HYPERLINK("' + d.link + '","' + dateLabel + '")' : dateLabel;
          const openLink = d.link ? '=HYPERLINK("' + d.link + '","فتح ←")' : '';
          values.push([dayLink, d.prod, d.recv, openLink, '', '', '', '']);
          values.push(['', '', '', '', '', '', '', '']);
          // دمج عمود D-H
          merges.push({ startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 3, endColumnIndex: 8 });
          merges.push({ startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 0, endColumnIndex: 1 });
          merges.push({ startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 1, endColumnIndex: 2 });
          merges.push({ startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 2, endColumnIndex: 3 });
          requests.push({
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 0, endColumnIndex: 8 },
              cell: { userEnteredFormat: {
                backgroundColor: rowColor,
                textFormat: { fontSize: 12, foregroundColor: { red: 0.1, green: 0.1, blue: 0.1 } },
                horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
                borders: {
                  bottom: { style: 'SOLID', width: 1, color: { red: 0.8, green: 0.8, blue: 0.8 } }
                }
              }},
              fields: 'userEnteredFormat'
            }
          });
          // تنسيق خاص لعمود الانتاج
          requests.push({
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 1, endColumnIndex: 2 },
              cell: { userEnteredFormat: {
                textFormat: { bold: true, fontSize: 13, foregroundColor: { red: 0.067, green: 0.4, blue: 0.067 } },
                horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
              }},
              fields: 'userEnteredFormat'
            }
          });
          // تنسيق خاص لعمود الاستلام
          requests.push({
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 2, endColumnIndex: 3 },
              cell: { userEnteredFormat: {
                textFormat: { bold: true, fontSize: 13, foregroundColor: { red: 0.6, green: 0.1, blue: 0.1 } },
                horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
              }},
              fields: 'userEnteredFormat'
            }
          });
          R += 2;
        }
      }

      // سطر فاصل بين الجروبات
      values.push(['', '', '', '', '', '', '', '']);
      values.push(['', '', '', '', '', '', '', '']);
      requests.push({
        repeatCell: {
          range: { sheetId: dashSheetId, startRowIndex: R, endRowIndex: R + 2, startColumnIndex: 0, endColumnIndex: 8 },
          cell: { userEnteredFormat: { backgroundColor: { red: 0.15, green: 0.15, blue: 0.15 } } },
          fields: 'userEnteredFormat'
        }
      });
      R += 2;
    }

    // ====================================================
    // مسح الورقة أولاً ثم كتابة البيانات
    // ====================================================
    // مسح البيانات القديمة
    await sheetsApi.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${DASHBOARD_NAME}'!A1:H500`,
    });

    // كتابة البيانات
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${DASHBOARD_NAME}'!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });

    // تطبيق الدمج والتنسيق معاً
    const allRequests = [
      // ضبط عرض الأعمدة
      { updateDimensionProperties: { range: { sheetId: dashSheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 220 }, fields: 'pixelSize' } },
      { updateDimensionProperties: { range: { sheetId: dashSheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 110 }, fields: 'pixelSize' } },
      { updateDimensionProperties: { range: { sheetId: dashSheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 110 }, fields: 'pixelSize' } },
      { updateDimensionProperties: { range: { sheetId: dashSheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 8 }, properties: { pixelSize: 130 }, fields: 'pixelSize' } },
      // تجميد السطرين الأولين
      // تجميد الصفوف — الصيغة الصحيحة لـ Sheets API v4
      {
        updateSheetProperties: {
          properties: {
            sheetId: dashSheetId,
            gridProperties: { frozenRowCount: 5 }
          },
          fields: 'gridProperties.frozenRowCount'
        }
      },
      // دمج الخلايا
      ...merges.map(m => ({ mergeCells: { range: { sheetId: dashSheetId, ...m }, mergeType: 'MERGE_ALL' } })),
      // تنسيق الخلايا
      ...requests,
    ];

    // تطبيق على دفعات (50 طلب في كل دفعة)
    const BATCH = 50;
    for (let i = 0; i < allRequests.length; i += BATCH) {
      await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: allRequests.slice(i, i + BATCH) },
      });
    }

    logger.info('🏠 تم تحديث ورقة الرئيسية بتصميم Azara');
  } catch (error) {
    logger.warn('فشل إنشاء/تحديث ورقة الرئيسية', { error: error.message });
  }
}

/**
 * جلب جميع المسجلين كمصفوفة { phone, name, whatsappName }
 */
function getAllRegistered() {
  const result = [];
  for (const [phone, entry] of registeredUsersCache.entries()) {
    const name = typeof entry === 'string' ? entry : (entry.name || entry.whatsappName || '');
    const whatsappName = typeof entry === 'object' ? (entry.whatsappName || '') : '';
    result.push({ phone, name, whatsappName });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

// ====================================================
// تحديث حالة عملية في نفس الصف (بدون إنشاء سجل جديد)
// ====================================================

/**
 * تحديث حالة عملية موجودة في سجل الحركات (in-place)
 * @param {number} rowIndex - رقم الصف (1-based)
 * @param {object} updates - الحقول المراد تحديثها {status, notes, quantity}
 */
async function updateTransactionStatus(rowIndex, updates) {
  if (!isInitialized || !rowIndex) return;
  const transSheet = config.sheets.sheetNames.transactions || 'سجل الحركات';
  try {
    // قراءة الصف الحالي
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${transSheet}'!A${rowIndex}:J${rowIndex}`,
    });
    const currentRow = response.data.values?.[0] || [];

    // تحديث الحقول المطلوبة
    // إذا كانت العملية ملغاة، نضيف CANCELLED_ إلى معرف العملية (عمود A)
    let newTransactionId = currentRow[0] || '';
    if (updates.status === 'ملغى' && !newTransactionId.startsWith('CANCELLED_')) {
      newTransactionId = 'CANCELLED_' + newTransactionId;
    } else if (updates.status === 'نشط' && newTransactionId.startsWith('CANCELLED_')) {
      newTransactionId = newTransactionId.replace('CANCELLED_', '');
    }

    const updatedRow = [
      newTransactionId,     // A: transactionId (تعديل ليعكس الحالة)
      currentRow[1] || '',  // B: timestamp
      currentRow[2] || '',  // C: producerPhone
      currentRow[3] || '',  // D: captainPhone
      updates.quantity !== undefined ? updates.quantity : (currentRow[4] || ''),  // E: quantity
      currentRow[5] || '',  // F: type
      currentRow[6] || '',  // G: emoji
      currentRow[7] || '',  // H: groupPrefix
      currentRow[8] || '',  // I: messageId (يجب عدم استبداله بـ status)
      updates.notes || currentRow[9] || '',   // J: notes (نحفظ فيه الحالة أيضاً إذا أردنا)
    ];

    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${transSheet}'!A${rowIndex}:J${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [updatedRow] },
    });

    logger.info(`✅ تحديث حالة العملية في الصف ${rowIndex}: ${updates.status || 'بدون تغيير'}`);
  } catch (error) {
    logger.error('❌ فشل تحديث حالة العملية', { error: error.message, rowIndex });
  }
}

/**
 * البحث عن عملية بمعرف الرسالة (بما فيها الملغاة)
 * مثل findTransactionByMessageId لكن لا يتخطى الملغاة
 * @param {string} messageId - معرف الرسالة المستهدفة
 * @param {string|null} reactorPhone - رقم من وضع التفاعل (null = بدون فلترة)
 * @returns {object|null}
 */
async function findTransactionByMessageIdIncludingCancelled(messageId, reactorPhone) {
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
      const rowMsgId = row[8] || '';
      const rowNotes = row[9] || '';

      // مطابقة: messageId في العمود المخصص له (I) أو ضمن الملاحظات (J)
      const idMatch = rowMsgId === messageId || rowMsgId.includes(messageId) || 
                      rowNotes.includes(messageId) || rowId.includes(messageId);
      // مطابقة المنتج (اختياري)
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
    logger.error('خطأ في البحث عن العملية (شامل الملغاة)', { error: error.message });
    return null;
  }
}

// ====================================================
// خريطة LID الدائمة — تحميل/حفظ في Google Sheets
// ورقة مخفية باسم LID_MAP
// عمود A: LID | عمود B: رقم الهاتف | عمود C: آخر تحديث
// ====================================================

const LID_MAP_SHEET = 'LID_MAP';

/**
 * إنشاء ورقة LID_MAP إذا لم تكن موجودة
 */
async function ensureLidMapSheet() {
  if (existingSheets.has(LID_MAP_SHEET)) return;
  try {
    // تحقق إذا كانت موجودة بالفعل
    const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
    const exists = meta.data.sheets?.some(s => s.properties?.title === LID_MAP_SHEET);
    if (exists) { existingSheets.add(LID_MAP_SHEET); return; }
    // إنشاء الورقة
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: LID_MAP_SHEET, hidden: true } } }],
      },
    });
    // رأس الأعمدة
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${LID_MAP_SHEET}'!A1:C1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['LID', 'رقم الهاتف', 'آخر تحديث']] },
    });
    existingSheets.add(LID_MAP_SHEET);
    logger.info('✅ تم إنشاء ورقة LID_MAP');
  } catch (e) {
    if (e.message?.includes('already exists')) existingSheets.add(LID_MAP_SHEET);
    else logger.debug('فشل ensureLidMapSheet', { error: e.message });
  }
}

/**
 * تحميل خريطة LID من Google Sheets عند بدء التشغيل
 * @returns {Map<string, string>} خريطة LID → رقم هاتف
 */
async function loadLidMapFromSheets() {
  if (!isInitialized) return new Map();
  try {
    await ensureLidMapSheet();
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${LID_MAP_SHEET}'!A:B`,
    });
    const rows = response.data.values || [];
    const map = new Map();
    for (let i = 1; i < rows.length; i++) {
      const lid = (rows[i][0] || '').trim();
      const phone = (rows[i][1] || '').trim();
      if (lid && phone) map.set(lid, phone);
    }
    logger.info(`🗃️ تم تحميل خريطة LID من Sheets: ${map.size} ربط`);
    return map;
  } catch (e) {
    logger.debug('فشل تحميل LID_MAP من Sheets', { error: e.message });
    return new Map();
  }
}

/**
 * حفظ خريطة LID كاملة في Google Sheets (كتابة كاملة)
 * يستبدل المحتوى كله مرة واحدة
 * @param {Map<string, string>} lidMap - خريطة LID → رقم هاتف
 */
async function saveLidMapToSheets(lidMap) {
  if (!isInitialized || !lidMap || lidMap.size === 0) return;
  try {
    await ensureLidMapSheet();
    const now = new Date().toISOString();
    const rows = [['LID', 'رقم الهاتف', 'آخر تحديث']];
    for (const [lid, phone] of lidMap.entries()) {
      // تخزين فقط الربطات الصحيحة (ليس base-prefix المكررة)
      if (!lid.includes('@lid')) continue;
      if (!phone.includes('@s.whatsapp.net') && !/^\d{9,12}$/.test(phone.replace(/\D/g,''))) continue;
      rows.push([lid, phone, now]);
    }
    // مسح الورقة وإعادة الكتابة
    await sheetsApi.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${LID_MAP_SHEET}'!A:C`,
    });
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${LID_MAP_SHEET}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
    logger.info(`💾 حفظ خريطة LID في Sheets: ${rows.length - 1} ربط`);
  } catch (e) {
    logger.debug('فشل حفظ LID_MAP في Sheets', { error: e.message });
  }
}

/**
 * تحديث تدريجي (إضافة ربطات جديدة فقط دون مسح كامل)
 * أسرع من الحفظ الكامل — يُستخدم بعد كل دفعة حل
 * @param {Map<string, string>} newEntries - الربطات الجديدة فقط
 */
async function appendLidMapToSheets(newEntries) {
  if (!isInitialized || !newEntries || newEntries.size === 0) return;
  try {
    await ensureLidMapSheet();
    const now = new Date().toISOString();
    const rows = [];
    for (const [lid, phone] of newEntries.entries()) {
      if (!lid.includes('@lid')) continue;
      rows.push([lid, phone, now]);
    }
    if (rows.length === 0) return;
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId,
      range: `'${LID_MAP_SHEET}'!A:C`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    });
    logger.info(`➕ إضافة ${rows.length} ربط جديد لـ LID_MAP في Sheets`);
  } catch (e) {
    logger.debug('فشل appendLidMapToSheets', { error: e.message });
  }
}

/**
 * الطبقة 4: تحديث السجلات القديمة في سجل الحركات عند حل LID
 * يبحث عن سجلات مخزنة بـ LID مؤقت ويستبدلها بالرقم الحقيقي
 * @param {Map<string, string>} newlyResolvedMap - خريطة LID → رقم هاتف (محلولة حديثاً)
 */
async function backfillLidRecords(newlyResolvedMap) {
  if (!isInitialized || !newlyResolvedMap || newlyResolvedMap.size === 0) return;
  const transSheet = config.sheets.sheetNames.transactions || 'سجل الحركات';
  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${transSheet}'!A:J`,
    });
    const rows = response.data.values || [];
    if (rows.length <= 1) return;
    
    const updates = [];
    
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const producer = (row[2] || '').trim();
      const captain = (row[3] || '').trim();
      let newProducer = producer;
      let newCaptain = captain;
      let changed = false;
      
      for (const [lid, phone] of newlyResolvedMap.entries()) {
        // الجزء الرقمي من LID (بدون @lid)
        const lidBase = lid.split(':')[0].replace('@lid', '');
        const cleanPhone = phone.replace(/\D/g, '');
        const shortPhone = cleanPhone.length > 9 ? cleanPhone.slice(-9) : cleanPhone;
        
        if (lidBase.length < 8) continue; // تجنب المطابقة الخاطئة
        
        // مطابقة المنتج: هل الرقم المخزن هو LID مؤقت?
        if (producer && producer.length >= 10 && producer === lidBase) {
          newProducer = shortPhone;
          changed = true;
        }
        // مطابقة الكابتن
        if (captain && captain.length >= 10 && captain === lidBase) {
          newCaptain = shortPhone;
          changed = true;
        }
      }
      
      if (changed) {
        updates.push({
          range: `'${transSheet}'!C${i+1}:D${i+1}`,
          values: [[newProducer, newCaptain]],
        });
      }
    }
    
    if (updates.length === 0) {
      logger.debug('backfill: لا توجد سجلات تحتاج تحديث');
      return;
    }
    
    // تحديث دفعي
    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates,
      },
    });
    logger.info(`✅ backfill: تحديث ${updates.length} سجل قديم بعد حل LID`);
  } catch (e) {
    logger.debug('فشل backfillLidRecords', { error: e.message });
  }
}

/**
 * مطابقة الأوراق اليومية مع سجل الحركات وتصحيحها
 * يُحسب المجموع الصحيح لكل شخص بأخذ آخر قيمة لكل msgId
 * ويُحدَّث الصف في الورقة اليومية مباشرةً
 * @param {string|null} dateStr - التاريخ بصيغة YYYY-MM-DD (null = اليوم)
 */
async function reconcileDailySheets(dateStr = null) {
  if (!isInitialized) return { success: false, message: 'غير مهيأ' };

  // تحديد التاريخ المستهدف
  let targetDate = dateStr;
  if (!targetDate) {
    const now = new Date();
    const jordan = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const y = jordan.getUTCFullYear();
    const m = String(jordan.getUTCMonth() + 1).padStart(2, '0');
    const d = String(jordan.getUTCDate()).padStart(2, '0');
    targetDate = `${y}-${m}-${d}`;
  }

  const groups = config.whatsapp.targetGroups || [];
  const prefixes = groups.map(g => g.prefix).filter(Boolean);
  if (!prefixes.length) return { success: false, message: 'لا توجد جروبات' };

  try {
    // قراءة سجل الحركات كاملاً
    const transSheet = config.sheets.sheetNames.transactions || 'سجل الحركات';
    const resp = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${transSheet}'!A:J`,
    });
    const allRows = resp.data.values || [];

    // قراءة أسماء المسجلين
    const regSheet = config.sheets.sheetNames.registeredUsers || 'المسجلين';
    const regResp = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${regSheet}'!A:B`,
    });
    const regRows = regResp.data.values || [];
    const nameMap = {};
    for (const r of regRows.slice(1)) {
      if (r[0] && r[1]) {
        nameMap[normalizePhone(r[0])] = r[1];
      }
    }

    let totalUpdated = 0;
    const results = [];

    for (const prefix of prefixes) {
      const sheetName = `${prefix}-${targetDate}`;

      // تصفية عمليات هذا الجروب واليوم (بدون الملغاة)
      const dayRows = allRows.slice(1).filter(r =>
        r.length > 7 &&
        (r[7] || '').includes(prefix) &&
        (r[1] || '').startsWith(targetDate) &&
        !String(r[0] || '').startsWith('CANCELLED_')
      );

      if (!dayRows.length) {
        results.push(`${prefix}: لا توجد عمليات`);
        continue;
      }

      // أخذ آخر قيمة لكل msgId (التعديل يُلغي السابق)
      const byMsgId = {};
      for (const row of dayRows) {
        const msgId = row[8] || row[0]; // عمود I أو A كمفتاح
        byMsgId[msgId] = row;
      }

      // حساب المجاميع
      const production = {}; // phone → qty
      const reception = {};  // phone → qty
      for (const row of Object.values(byMsgId)) {
        const prod = normalizePhone(row[2] || '');
        const capt = normalizePhone(row[3] || '');
        const qty = parseFloat(row[4]) || 0;
        if (prod) production[prod] = (production[prod] || 0) + qty;
        if (capt) reception[capt] = (reception[capt] || 0) + qty;
      }

      // بناء بيانات الورقة
      const allPhones = new Set([...Object.keys(production), ...Object.keys(reception)]);
      const newRows = [['الهاتف', 'الاسم', '#الانتاج', 'الاستلام']];
      for (const phone of [...allPhones].sort()) {
        const name = nameMap[phone] || '';
        const prod = Math.max(0, production[phone] || 0);
        const recv = Math.max(0, reception[phone] || 0);
        newRows.push([phone, name, prod, recv]);
      }

      // إنشاء الورقة إذا لم تكن موجودة
      await ensureDailySheet(sheetName);

      // مسح البيانات القديمة وكتابة الجديدة
      await sheetsApi.spreadsheets.values.clear({
        spreadsheetId,
        range: `'${sheetName}'!A:D`,
      });
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: `'${sheetName}'!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: newRows },
      });

      totalUpdated++;
      results.push(`${prefix}: ${newRows.length - 1} شخص`);
      logger.info(`🔄 reconcile: ${sheetName} → ${newRows.length - 1} صف`);
    }

    return { success: true, date: targetDate, results, totalUpdated };
  } catch (error) {
    logger.error('❌ فشل reconcileDailySheets', { error: error.message });
    return { success: false, message: error.message };
  }
}

module.exports = {
  initialize,
  loadSettings,
  // المسجلين
  loadRegisteredUsers,
  getRegisteredName,
  findPhoneByName,
  getAllRegistered,
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
  findTransactionByMessageIdIncludingCancelled,
  updateTransactionStatus,
  canEdit,
  logEdit,
  // الكشف التفصيلي
  getDetailedReport,
  // لوحة التحكم
  getDaysList,
  getDayData,
  createDashboardSheet,
  // المحذوف
  saveDeletedMessage,
  // خريطة LID الدائمة
  loadLidMapFromSheets,
  saveLidMapToSheets,
  appendLidMapToSheets,
  // الطبقة 4: تحديث السجلات القديمة عند حل LID
  backfillLidRecords,
  // مطابقة يومية
  reconcileDailySheets,
  // deprecated (للتوافق)
  updateBalance,
  updateTotals,
  getBalance,
  recordOrder,
  getOrderOwnerByMessageId,
  updateOrderStatus,
  // الطبقة 4: تحديث السجلات القديمة عند حل LID
  backfillLidRecords,
  // وصول لـ sheetsApi من موديولات أخرى
  getSheetsApi: () => sheetsApi,
  getSpreadsheetId: () => spreadsheetId,
  isInitializedFn: () => isInitialized,
  // ورقة المسجلين — LID
  resolvePhoneFromRegistered,
  updateLidInRegistered,
  getRegisteredLidMap,
  addNewMemberToRegistered,
};
