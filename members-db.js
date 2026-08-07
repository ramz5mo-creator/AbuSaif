/**
 * members-db.js - قاعدة بيانات الأعضاء الدائمة
 * ================================================
 * ورقة "Members" في Google Sheets كمرجع أساسي
 * 
 * هيكل الورقة:
 *   A: LID          (مثال: 182957553799363@lid)
 *   B: رقم الهاتف   (مثال: 778793241)
 *   C: اسم واتساب   (مثال: محمد الحوراني)
 *   D: الجروب       (مثال: دريمكس)
 *   E: الدور        (مثال: عضو / مشرف)
 *   F: آخر تحديث    (ISO timestamp)
 * 
 * الخريطة في الذاكرة:
 *   lidToPhone: Map<lid → phone>
 *   phoneToMember: Map<phone → {lid, name, group, role}>
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const MEMBERS_SHEET = 'Members';
const TOKEN_PATH = path.resolve('./token.json');
const CREDENTIALS_PATH = path.resolve('./oauth-credentials.json');

let sheetsApi = null;
let spreadsheetId = '';
let isReady = false;

// الخرائط في الذاكرة (تُبنى من ورقة Members عند البدء)
const lidToPhone = new Map();     // lid@lid → phone (9 أرقام)
const phoneToMember = new Map();  // phone → { lid, name, group, role, rowIndex }

// تتبع الصفوف لتحديث in-place
const lidToRowIndex = new Map();  // lid → rowIndex (1-based)

// قائمة التحديثات المعلقة (batch write)
let pendingUpdates = [];
let batchWriteTimer = null;

/**
 * تهيئة الاتصال بـ Google Sheets
 */
async function initialize() {
  if (isReady) return;
  try {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2Client.setCredentials(token);
    sheetsApi = google.sheets({ version: 'v4', auth: oAuth2Client });
    spreadsheetId = config.sheets.spreadsheetId;
    isReady = true;
    logger.info('✅ members-db: تم الاتصال بـ Google Sheets');
  } catch (e) {
    logger.error('❌ members-db: فشل التهيئة', { error: e.message });
  }
}

/**
 * ضمان وجود ورقة Members
 */
async function ensureMembersSheet() {
  try {
    const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
    const exists = meta.data.sheets?.some(s => s.properties?.title === MEMBERS_SHEET);
    if (exists) return;
    // إنشاء الورقة
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: MEMBERS_SHEET } } }],
      },
    });
    // رأس الأعمدة
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${MEMBERS_SHEET}'!A1:F1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['LID', 'رقم الهاتف', 'اسم واتساب', 'الجروب', 'الدور', 'آخر تحديث']],
      },
    });
    logger.info('✅ members-db: تم إنشاء ورقة Members');
  } catch (e) {
    if (!e.message?.includes('already exists')) {
      logger.debug('فشل ensureMembersSheet', { error: e.message });
    }
  }
}

/**
 * تحميل قاعدة البيانات من Google Sheets إلى الذاكرة
 * يُستدعى مرة واحدة عند بدء التشغيل
 */
async function loadFromSheets() {
  if (!isReady) await initialize();
  try {
    await ensureMembersSheet();
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${MEMBERS_SHEET}'!A:F`,
    });
    const rows = response.data.values || [];
    let loaded = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const lid   = (row[0] || '').trim();
      const phone = (row[1] || '').trim();
      const name  = (row[2] || '').trim();
      const group = (row[3] || '').trim();
      const role  = (row[4] || '').trim();

      if (!lid && !phone) continue;

      const member = { lid, name, group, role, rowIndex: i + 1 };

      if (lid) {
        lidToPhone.set(lid, phone);
        lidToRowIndex.set(lid, i + 1);
        // أيضاً base-prefix (بدون :0)
        const base = lid.split(':')[0];
        if (base !== lid) {
          lidToPhone.set(base + '@lid', phone);
          lidToRowIndex.set(base + '@lid', i + 1);
        }
      }
      if (phone) {
        phoneToMember.set(phone, member);
      }
      loaded++;
    }

    logger.info(`🗃️ members-db: تم تحميل ${loaded} عضو من Sheets`);
    return { lidToPhone, phoneToMember };
  } catch (e) {
    logger.error('❌ members-db: فشل التحميل', { error: e.message });
    return { lidToPhone: new Map(), phoneToMember: new Map() };
  }
}

/**
 * البحث عن رقم هاتف من LID
 * @param {string} lid
 * @returns {string|null} رقم الهاتف أو null
 */
function resolvePhone(lid) {
  if (!lid) return null;
  // مطابقة تامة
  const direct = lidToPhone.get(lid);
  if (direct) return direct;
  // مطابقة base-prefix
  const base = lid.split(':')[0];
  const baseKey = base + '@lid';
  const baseMatch = lidToPhone.get(baseKey);
  if (baseMatch) {
    lidToPhone.set(lid, baseMatch); // cache للمرة القادمة
    return baseMatch;
  }
  // بحث خطي (آخر حل)
  for (const [k, v] of lidToPhone.entries()) {
    if (k.split(':')[0] === base) {
      lidToPhone.set(lid, v);
      return v;
    }
  }
  return null;
}

/**
 * البحث عن بيانات عضو من رقم الهاتف
 */
function getMember(phone) {
  if (!phone) return null;
  return phoneToMember.get(phone) || null;
}

/**
 * إضافة أو تحديث عضو في الذاكرة وجدولة الحفظ في Sheets
 * @param {object} member - { lid, phone, name, group, role }
 */
function upsertMember({ lid, phone, name = '', group = '', role = 'عضو' }) {
  if (!lid && !phone) return;

  const now = new Date().toISOString();
  const normalizedPhone = phone ? String(phone).replace(/\D/g, '').slice(-9) : '';

  // تحديث الذاكرة
  if (lid) {
    lidToPhone.set(lid, normalizedPhone);
    const base = lid.split(':')[0];
    if (base !== lid) lidToPhone.set(base + '@lid', normalizedPhone);
  }
  if (normalizedPhone) {
    const existing = phoneToMember.get(normalizedPhone) || {};
    phoneToMember.set(normalizedPhone, {
      lid: lid || existing.lid || '',
      name: name || existing.name || '',
      group: group || existing.group || '',
      role: role || existing.role || 'عضو',
      rowIndex: existing.rowIndex,
    });
  }

  // جدولة الكتابة في Sheets (batch)
  pendingUpdates.push({ lid, phone: normalizedPhone, name, group, role, timestamp: now });
  scheduleBatchWrite();
}

/**
 * تحديث اسم واتساب لعضو موجود
 */
function updateMemberName(phone, name) {
  if (!phone || !name) return;
  const normalized = String(phone).replace(/\D/g, '').slice(-9);
  const existing = phoneToMember.get(normalized);
  if (existing && existing.name !== name) {
    existing.name = name;
    phoneToMember.set(normalized, existing);
    pendingUpdates.push({ phone: normalized, name, _nameOnly: true });
    scheduleBatchWrite();
  }
}

/**
 * جدولة الكتابة الدفعية (كل 10 ثوانٍ)
 */
function scheduleBatchWrite() {
  if (batchWriteTimer) return;
  batchWriteTimer = setTimeout(async () => {
    batchWriteTimer = null;
    await flushPendingUpdates();
  }, 10000);
}

/**
 * كتابة التحديثات المعلقة في Sheets
 */
async function flushPendingUpdates() {
  if (!isReady || pendingUpdates.length === 0) return;
  const updates = [...pendingUpdates];
  pendingUpdates = [];

  try {
    // جلب الورقة الحالية لمعرفة الصفوف الموجودة
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${MEMBERS_SHEET}'!A:B`,
    });
    const rows = response.data.values || [];

    // بناء خريطة lid → rowIndex من الورقة الحالية
    const existingLids = new Map();
    for (let i = 1; i < rows.length; i++) {
      const lid = (rows[i][0] || '').trim();
      if (lid) existingLids.set(lid, i + 1);
    }

    const batchData = [];
    const newRows = [];

    for (const u of updates) {
      if (u._nameOnly) continue; // تحديث الاسم يتم في الدفعة الكاملة

      const rowIndex = existingLids.get(u.lid) || lidToRowIndex.get(u.lid);
      if (rowIndex) {
        // تحديث صف موجود
        batchData.push({
          range: `'${MEMBERS_SHEET}'!A${rowIndex}:F${rowIndex}`,
          values: [[u.lid, u.phone, u.name, u.group, u.role, u.timestamp]],
        });
      } else {
        // صف جديد
        newRows.push([u.lid, u.phone, u.name, u.group, u.role, u.timestamp]);
      }
    }

    // تحديث الصفوف الموجودة
    if (batchData.length > 0) {
      await sheetsApi.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data: batchData },
      });
    }

    // إضافة الصفوف الجديدة
    if (newRows.length > 0) {
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId,
        range: `'${MEMBERS_SHEET}'!A:F`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: newRows },
      });
    }

    if (batchData.length + newRows.length > 0) {
      logger.info(`💾 members-db: حفظ ${batchData.length} تحديث + ${newRows.length} جديد`);
    }
  } catch (e) {
    logger.debug('فشل flushPendingUpdates', { error: e.message });
    // أعد التحديثات للمحاولة لاحقاً
    pendingUpdates = [...updates, ...pendingUpdates];
    scheduleBatchWrite();
  }
}

/**
 * حفظ كامل للخريطة في Sheets (يُستخدم بعد بناء الخريطة الأولي)
 * @param {Array} members - مصفوفة من { lid, phone, name, group, role }
 */
async function saveAllMembers(members) {
  if (!isReady || !members || members.length === 0) return;
  try {
    await ensureMembersSheet();
    const now = new Date().toISOString();
    const rows = [['LID', 'رقم الهاتف', 'اسم واتساب', 'الجروب', 'الدور', 'آخر تحديث']];
    for (const m of members) {
      rows.push([m.lid || '', m.phone || '', m.name || '', m.group || '', m.role || 'عضو', now]);
    }
    // مسح وإعادة كتابة
    await sheetsApi.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${MEMBERS_SHEET}'!A:F`,
    });
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${MEMBERS_SHEET}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
    logger.info(`💾 members-db: حفظ كامل ${members.length} عضو في Sheets`);
  } catch (e) {
    logger.error('❌ members-db: فشل الحفظ الكامل', { error: e.message });
  }
}

/**
 * إحصائيات قاعدة البيانات
 */
function getStats() {
  return {
    totalLids: lidToPhone.size,
    totalPhones: phoneToMember.size,
    resolvedLids: [...lidToPhone.values()].filter(v => v && v.length >= 9).length,
    unresolvedLids: [...lidToPhone.values()].filter(v => !v || v.length < 9).length,
  };
}

/**
 * الحصول على جميع LIDs غير المحلولة
 */
function getUnresolvedLids() {
  const unresolved = [];
  for (const [lid, phone] of lidToPhone.entries()) {
    if (!phone || phone.length < 9) {
      unresolved.push(lid);
    }
  }
  return unresolved;
}

/**
 * تصدير الخرائط للاستخدام في whatsapp.js
 */
function getLidToPhoneMap() { return lidToPhone; }
function getPhoneToMemberMap() { return phoneToMember; }

module.exports = {
  initialize,
  loadFromSheets,
  saveAllMembers,
  resolvePhone,
  getMember,
  upsertMember,
  updateMemberName,
  flushPendingUpdates,
  getStats,
  getUnresolvedLids,
  getLidToPhoneMap,
  getPhoneToMemberMap,
};
