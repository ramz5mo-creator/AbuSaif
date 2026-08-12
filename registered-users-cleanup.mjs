/**
 * تدقيق وتنظيف ورقة «المسجلين».
 *
 * الأوامر:
 *   node registered-users-cleanup.mjs audit
 *   node registered-users-cleanup.mjs apply
 *
 * لا يدمج الأمر apply إلا التكرارات المتطابقة أو غير المتعارضة. أي رقم له
 * أسماء رسمية أو أسماء واتساب أو LID مختلفة يبقى كما هو ويظهر في التقرير.
 * تنشأ ورقة نسخ احتياطي بالقيم الخام قبل أول تغيير.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { google } from 'googleapis';

const require = createRequire(import.meta.url);
const config = require('./config');

const mode = process.argv[2] || 'audit';
if (!['audit', 'apply'].includes(mode)) {
  throw new Error('الاستخدام: node registered-users-cleanup.mjs audit | apply');
}

const projectDir = path.dirname(new URL(import.meta.url).pathname);
const volumePath = process.env.VOLUME_PATH || path.join(projectDir, 'data');
const keyPath = fs.existsSync(path.join(volumePath, 'service-account.json'))
  ? path.join(volumePath, 'service-account.json')
  : path.join(projectDir, 'service-account.json');
const key = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  : JSON.parse(fs.readFileSync(keyPath, 'utf8'));

const spreadsheetId = config.sheets.spreadsheetId;
const sheetName = config.sheets.sheetNames.registeredUsers || 'المسجلين';
const auth = new google.auth.GoogleAuth({
  credentials: key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

function quoteSheet(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function normalizePhone(value) {
  let phone = String(value || '').replace(/\D/g, '');
  if (!phone || phone.length < 9) return '';
  while (phone.length > 12) phone = phone.slice(1);
  if (phone.length === 12 && phone.startsWith('962')) phone = phone.slice(3);
  else if (phone.length === 11 && phone.startsWith('96')) phone = phone.slice(2);
  else if (phone.length === 10 && phone.startsWith('0')) phone = phone.slice(1);
  return phone.length >= 9 ? phone : '';
}

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function rowCompleteness(row) {
  return row.slice(0, 4).filter((value) => normalizeText(value)).length;
}

function createAudit(rows) {
  const groups = new Map();
  const invalidRows = [];

  rows.slice(1).forEach((row, offset) => {
    const rowIndex = offset + 2;
    const phone = normalizePhone(row[0]);
    if (!phone) {
      if (row.some((value) => normalizeText(value))) invalidRows.push({ rowIndex, row });
      return;
    }
    const item = { rowIndex, row, phone };
    if (!groups.has(phone)) groups.set(phone, []);
    groups.get(phone).push(item);
  });

  const duplicates = [];
  for (const [phone, entries] of groups.entries()) {
    if (entries.length < 2) continue;

    const officialNames = uniqueNonEmpty(entries.map((entry) => entry.row[1]));
    const whatsappNames = uniqueNonEmpty(entries.map((entry) => entry.row[2]));
    const lids = uniqueNonEmpty(entries.map((entry) => entry.row[3]));
    const conflictingFields = [];
    if (officialNames.length > 1) conflictingFields.push('الاسم الرسمي');
    if (whatsappNames.length > 1) conflictingFields.push('اسم واتساب');
    if (lids.length > 1) conflictingFields.push('LID');

    const canonical = [...entries].sort((a, b) => {
      const aOfficial = normalizeText(a.row[1]) ? 1 : 0;
      const bOfficial = normalizeText(b.row[1]) ? 1 : 0;
      if (aOfficial !== bOfficial) return bOfficial - aOfficial;
      const completeness = rowCompleteness(b.row) - rowCompleteness(a.row);
      return completeness || a.rowIndex - b.rowIndex;
    })[0];

    duplicates.push({
      phone,
      rowIndexes: entries.map((entry) => entry.rowIndex),
      canonicalRowIndex: canonical.rowIndex,
      officialNames,
      whatsappNames,
      lids,
      status: conflictingFields.length ? 'يحتاج مراجعة' : 'آمن للدمج',
      conflictingFields,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    sheetName,
    totalDataRows: rows.length - 1,
    uniqueValidPhones: groups.size,
    duplicatePhoneGroups: duplicates.length,
    safeDuplicateGroups: duplicates.filter((item) => item.status === 'آمن للدمج').length,
    conflictDuplicateGroups: duplicates.filter((item) => item.status === 'يحتاج مراجعة').length,
    invalidPhoneRows: invalidRows.length,
    duplicates,
    invalidRows: invalidRows.map((item) => ({ rowIndex: item.rowIndex, values: item.row.slice(0, 4) })),
  };
}

function buildCleanRows(rows, audit) {
  const duplicateGroups = new Map(audit.duplicates.map((item) => [item.phone, item]));
  const rowsToRemove = new Set();
  const replacementRows = new Map();

  for (const group of duplicateGroups.values()) {
    const sourceRows = group.rowIndexes.map((rowIndex) => ({ rowIndex, row: rows[rowIndex - 1] || [] }));
    // الكاش الحالي للبوت يقرأ آخر ظهور للرقم في الورقة؛ نحتفظ به كسجل رئيسي
    // حتى لا يتغير الاسم الظاهر فجأة بعد التنظيف.
    const canonical = [...sourceRows].sort((a, b) => b.rowIndex - a.rowIndex)[0];
    const merged = [...canonical.row];
    merged[0] = group.phone;
    // إذا كان السجل الأحدث ناقصاً، نكمله من آخر قيمة موثوقة سابقة لنفس الرقم.
    for (const columnIndex of [1, 2, 3]) {
      if (!normalizeText(merged[columnIndex])) {
        const previousValue = [...sourceRows]
          .sort((a, b) => b.rowIndex - a.rowIndex)
          .map((item) => normalizeText(item.row[columnIndex]))
          .find(Boolean);
        if (previousValue) merged[columnIndex] = previousValue;
      }
    }
    replacementRows.set(canonical.rowIndex, merged);
    sourceRows.forEach((item) => {
      if (item.rowIndex !== canonical.rowIndex) rowsToRemove.add(item.rowIndex);
    });
  }

  const cleaned = [rows[0] || ['رقم الهاتف', 'الاسم', 'اسم واتساب', 'LID']];
  rows.slice(1).forEach((row, offset) => {
    const rowIndex = offset + 2;
    if (rowsToRemove.has(rowIndex)) return;
    cleaned.push(replacementRows.get(rowIndex) || row);
  });
  return { cleaned, mergedRowCount: rowsToRemove.size, mergedGroups: duplicateGroups.size };
}

function markdownReport(audit) {
  const rows = audit.duplicates.map((item) => {
    const names = item.officialNames.join(' / ') || '—';
    const conflicts = item.conflictingFields.join('، ') || '—';
    return `| ${item.phone} | ${item.rowIndexes.join(', ')} | ${names} | ${item.status} | ${conflicts} |`;
  }).join('\n') || '| — | — | — | لا توجد تكرارات | — |';

  return `# تدقيق ورقة المسجلين\n\n` +
    `- وقت الإنشاء: ${audit.generatedAt}\n` +
    `- صفوف بيانات: ${audit.totalDataRows}\n` +
    `- أرقام صحيحة فريدة: ${audit.uniqueValidPhones}\n` +
    `- مجموعات مكررة: ${audit.duplicatePhoneGroups}\n` +
    `- آمنة للدمج: ${audit.safeDuplicateGroups}\n` +
    `- تحتاج مراجعة: ${audit.conflictDuplicateGroups}\n` +
    `- صفوف رقمها غير صالح: ${audit.invalidPhoneRows}\n\n` +
    `| الرقم | الصفوف | الأسماء الرسمية | الحالة | تعارض |\n|---|---:|---|---|---|\n${rows}\n`;
}

async function createBackup(rows) {
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupTitle = `نسخة المسجلين ${date}`.slice(0, 95);
  const addResponse = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: backupTitle } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheet(backupTitle)}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
  return backupTitle;
}

async function createDuplicateReviewSheet(audit) {
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reviewTitle = `مراجعة تكرارات المسجلين ${date}`.slice(0, 95);
  const reviewRows = [
    ['رقم الهاتف', 'الصف الرئيسي المحتفَظ به', 'الصفوف المدمجة', 'الاسم المحتفَظ به', 'كل الأسماء الرسمية السابقة', 'أسماء واتساب', 'LID', 'الحالة', 'الحقول المتعارضة'],
    ...audit.duplicates.map((group) => {
      const retainedRow = Math.max(...group.rowIndexes);
      const retainedName = group.officialNames[group.officialNames.length - 1] || '';
      return [
        group.phone,
        retainedRow,
        group.rowIndexes.join(', '),
        retainedName,
        group.officialNames.join(' | '),
        group.whatsappNames.join(' | '),
        group.lids.join(' | '),
        group.status,
        group.conflictingFields.join('، '),
      ];
    }),
  ];
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: reviewTitle } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheet(reviewTitle)}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: reviewRows },
  });
  return reviewTitle;
}

const readResponse = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: `${quoteSheet(sheetName)}!A:Z`,
});
const rows = readResponse.data.values || [];
if (!rows.length) throw new Error('ورقة المسجلين فارغة؛ لم يُنفذ أي تغيير.');

const audit = createAudit(rows);
const auditJsonPath = '/home/ubuntu/abusaif-registered-users-audit.json';
const auditMarkdownPath = '/home/ubuntu/abusaif-registered-users-audit-report.md';
fs.writeFileSync(auditJsonPath, JSON.stringify(audit, null, 2));
fs.writeFileSync(auditMarkdownPath, markdownReport(audit));

console.log(JSON.stringify({
  mode,
  ...audit,
  auditJsonPath,
  auditMarkdownPath,
}, null, 2));

if (mode === 'apply') {
  const backupTitle = await createBackup(rows);
  const { cleaned, mergedRowCount, mergedGroups } = buildCleanRows(rows, audit);
  const reviewTitle = await createDuplicateReviewSheet(audit);
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${quoteSheet(sheetName)}!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheet(sheetName)}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: cleaned },
  });
  console.log(JSON.stringify({
    applied: true,
    backupTitle,
    reviewTitle,
    mergedGroups,
    removedDuplicateRows: mergedRowCount,
    remainingConflictGroups: audit.conflictDuplicateGroups,
  }, null, 2));
}
