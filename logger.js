/**
 * logger.js - نظام السجل
 * ================================
 * يسجل جميع الأحداث والأخطاء في ملفات وفي الطرفية.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

// التأكد من وجود مجلد السجلات محلياً داخل مسار المشروع لضمان الصلاحيات وعدم حدوث خطأ EACCES
const logsDir = path.join(__dirname, 'logs');
try {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
} catch (err) {
  // في حال فشل إنشاء الملف محلياً، نتجاهله لكي لا يتوقف البوت
}

/**
 * مستويات السجل
 */
const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const currentLevel = LEVELS[config.logging.level] || LEVELS.info;

/**
 * تنسيق التاريخ والوقت
 */
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * Log Rotation — حد أقصى 50MB لكل ملف، أرشفة تلقائية
 */
const MAX_LOG_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_ARCHIVES = 3;

function rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_LOG_SIZE) return;
    const oldest = `${filePath}.${MAX_ARCHIVES}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let i = MAX_ARCHIVES - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`;
      const dst = `${filePath}.${i + 1}`;
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
    fs.renameSync(filePath, `${filePath}.1`);
  } catch (e) { /* لا نوقف البوت */ }
}

function writeToFile(level, message, data) {
  const logEntry = {
    timestamp: getTimestamp(),
    level,
    message,
    ...(data && { data }),
  };

  const fileName = level === 'error' ? 'errors.log' : 'app.log';
  const filePath = path.join(logsDir, fileName);

  rotateIfNeeded(filePath);
  try {
    fs.appendFileSync(filePath, JSON.stringify(logEntry) + '\n', 'utf8');
  } catch (e) {
    // نتجاهل خطأ الكتابة في حال تقييد الصلاحيات لضمان استمرار عمل البوت
  }
}

/**
 * طباعة في الطرفية مع ألوان
 */
function printToConsole(level, message, data) {
  const colors = {
    error: '\x1b[31m',   // أحمر
    warn: '\x1b[33m',    // أصفر
    info: '\x1b[36m',    // سماوي
    debug: '\x1b[90m',   // رمادي
  };
  const reset = '\x1b[0m';
  const color = colors[level] || reset;

  const prefix = `${color}[${getTimestamp()}] [${level.toUpperCase()}]${reset}`;
  if (data) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

/**
 * دالة السجل الرئيسية
 */
function log(level, message, data = null) {
  if (LEVELS[level] > currentLevel) return;

  printToConsole(level, message, data);
  writeToFile(level, message, data);
}

module.exports = {
  error: (message, data) => log('error', message, data),
  warn: (message, data) => log('warn', message, data),
  info: (message, data) => log('info', message, data),
  debug: (message, data) => log('debug', message, data),
};
