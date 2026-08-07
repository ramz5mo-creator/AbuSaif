'use strict';
/**
 * members-db.js - قاعدة بيانات الأعضاء الدائمة
 * يستخدم sheetsApi من sheets.js مباشرة (لا اتصال جديد)
 * 
 * هيكل ورقة Members:
 *   A: LID | B: رقم الهاتف | C: اسم واتساب | D: الجروب | E: الدور | F: آخر تحديث
 */

const MEMBERS_SHEET = 'Members';

// الخرائط في الذاكرة
const lidToPhone = new Map();     // lid → phone (9 أرقام)
const phoneToMember = new Map();  // phone → { lid, name, group, role, rowIndex }
const lidToRowIndex = new Map();  // lid → rowIndex

let pendingUpdates = [];
let batchWriteTimer = null;
let _loaded = false;

/** جلب sheetsApi و spreadsheetId من sheets.js */
function getApi() {
  const sheets = require('./sheets');
  return {
    api: sheets.getSheetsApi(),
    id: sheets.getSpreadsheetId(),
    ready: sheets.isInitializedFn(),
  };
}

/** ضمان وجود ورقة Members */
async function ensureMembersSheet(api, id) {
  try {
    const meta = await api.spreadsheets.get({ spreadsheetId: id });
    const exists = meta.data.sheets?.some(s => s.properties?.title === MEMBERS_SHEET);
    if (exists) return;
    await api.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: { requests: [{ addSheet: { properties: { title: MEMBERS_SHEET } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: id,
      range: `'${MEMBERS_SHEET}'!A1:F1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['LID', 'رقم الهاتف', 'اسم واتساب', 'الجروب', 'الدور', 'آخر تحديث']] },
    });
    console.log('[members-db] ✅ تم إنشاء ورقة Members');
  } catch(e) {
    if (!e.message?.includes('already exists')) console.error('[members-db] ensureSheet:', e.message);
  }
}

/** تحميل البيانات من Sheets إلى الذاكرة */
async function loadFromSheets() {
  const { api, id, ready } = getApi();
  if (!api || !id || !ready) {
    console.log('[members-db] sheets غير جاهز — سيُعاد المحاولة بعد 30 ثانية');
    setTimeout(loadFromSheets, 30000);
    return 0;
  }
  try {
    await ensureMembersSheet(api, id);
    const resp = await api.spreadsheets.values.get({
      spreadsheetId: id,
      range: `'${MEMBERS_SHEET}'!A:F`,
    });
    const rows = resp.data.values || [];
    lidToPhone.clear(); phoneToMember.clear(); lidToRowIndex.clear();
    let loaded = 0;
    for (let i = 1; i < rows.length; i++) {
      const [lid, phone, name, group, role] = rows[i].map(v => (v||'').trim());
      if (!lid && !phone) continue;
      if (lid) {
        lidToPhone.set(lid, phone);
        lidToRowIndex.set(lid, i + 1);
        const base = lid.split(':')[0];
        if (base !== lid) { lidToPhone.set(base + '@lid', phone); lidToRowIndex.set(base + '@lid', i + 1); }
      }
      if (phone) phoneToMember.set(phone, { lid: lid||'', name: name||'', group: group||'', role: role||'عضو', rowIndex: i+1 });
      loaded++;
    }
    _loaded = true;
    console.log(`[members-db] ✅ تم تحميل ${loaded} عضو من ورقة Members`);
    return loaded;
  } catch(e) {
    console.error('[members-db] فشل التحميل:', e.message);
    setTimeout(loadFromSheets, 60000);
    return 0;
  }
}

/** حل LID إلى رقم هاتف */
function resolvePhone(lid) {
  if (!lid) return null;
  const direct = lidToPhone.get(lid);
  if (direct) return direct.length >= 9 ? `${direct}@s.whatsapp.net` : null;
  const base = lid.split(':')[0];
  const baseMatch = lidToPhone.get(base + '@lid');
  if (baseMatch) { lidToPhone.set(lid, baseMatch); return baseMatch.length >= 9 ? `${baseMatch}@s.whatsapp.net` : null; }
  for (const [k, v] of lidToPhone.entries()) {
    if (k.split(':')[0] === base && v && v.length >= 9) { lidToPhone.set(lid, v); return `${v}@s.whatsapp.net`; }
  }
  return null;
}

/** إضافة/تحديث عضو */
function upsertMember({ lid, phone, name = '', group = '', role = 'عضو' }) {
  if (!lid && !phone) return;
  const now = new Date().toISOString();
  const p = phone ? String(phone).replace(/\D/g,'').slice(-9) : '';
  if (lid) {
    lidToPhone.set(lid, p);
    const base = lid.split(':')[0];
    if (base !== lid) lidToPhone.set(base + '@lid', p);
  }
  if (p) {
    const ex = phoneToMember.get(p) || {};
    phoneToMember.set(p, { lid: lid||ex.lid||'', name: name||ex.name||'', group: group||ex.group||'', role: role||ex.role||'عضو', rowIndex: ex.rowIndex });
  }
  pendingUpdates.push({ lid: lid||'', phone: p, name, group, role, timestamp: now });
  scheduleBatchWrite();
}

function scheduleBatchWrite() {
  if (batchWriteTimer) return;
  batchWriteTimer = setTimeout(async () => { batchWriteTimer = null; await flushPendingUpdates(); }, 10000);
}

async function flushPendingUpdates() {
  if (pendingUpdates.length === 0) return;
  const { api, id, ready } = getApi();
  if (!api || !id || !ready) { batchWriteTimer = setTimeout(flushPendingUpdates, 30000); return; }
  const updates = [...pendingUpdates]; pendingUpdates = [];
  try {
    const resp = await api.spreadsheets.values.get({ spreadsheetId: id, range: `'${MEMBERS_SHEET}'!A:B` });
    const rows = resp.data.values || [];
    const existingLids = new Map();
    for (let i = 1; i < rows.length; i++) { const l = (rows[i][0]||'').trim(); if (l) existingLids.set(l, i+1); }
    const batchData = [], newRows = [];
    for (const u of updates) {
      const rowIndex = existingLids.get(u.lid) || lidToRowIndex.get(u.lid);
      if (rowIndex) batchData.push({ range: `'${MEMBERS_SHEET}'!A${rowIndex}:F${rowIndex}`, values: [[u.lid, u.phone, u.name, u.group, u.role, u.timestamp]] });
      else newRows.push([u.lid, u.phone, u.name, u.group, u.role, u.timestamp]);
    }
    if (batchData.length > 0) await api.spreadsheets.values.batchUpdate({ spreadsheetId: id, requestBody: { valueInputOption: 'RAW', data: batchData } });
    if (newRows.length > 0) await api.spreadsheets.values.append({ spreadsheetId: id, range: `'${MEMBERS_SHEET}'!A:F`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: newRows } });
    if (batchData.length + newRows.length > 0) console.log(`[members-db] 💾 حفظ ${batchData.length} تحديث + ${newRows.length} جديد`);
  } catch(e) {
    console.error('[members-db] فشل الحفظ:', e.message);
    pendingUpdates = [...updates, ...pendingUpdates];
    batchWriteTimer = setTimeout(flushPendingUpdates, 60000);
  }
}

function getStats() {
  return {
    totalLids: lidToPhone.size,
    totalPhones: phoneToMember.size,
    resolvedLids: [...lidToPhone.values()].filter(v => v && v.length >= 9).length,
    unresolvedLids: [...lidToPhone.values()].filter(v => !v || v.length < 9).length,
    pendingUpdates: pendingUpdates.length,
    loaded: _loaded,
  };
}

function getUnresolvedLids() {
  return [...lidToPhone.entries()].filter(([,v]) => !v || v.length < 9).map(([k]) => k);
}

/** تهيئة — تُستدعى بعد sheets.initialize() */
async function initialize() {
  return await loadFromSheets();
}

module.exports = {
  initialize,
  loadFromSheets,
  resolvePhone,
  upsertMember,
  flushPendingUpdates,
  getStats,
  getUnresolvedLids,
  isLoaded: () => _loaded,
  getLidToPhoneMap: () => lidToPhone,
  getPhoneToMemberMap: () => phoneToMember,
};
