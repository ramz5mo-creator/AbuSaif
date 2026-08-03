/**
 * logger.js - نظام السجل
 * ================================
 * يسجل جميع الأحداث والأخطاء في ملفات وفي الطرفية.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

// التأكد من وجود مجلد السجلات
const logsDir = path.resolve(config.logging.logsPath);
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
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
 * كتابة السجل في ملف
 */
function writeToFile(level, message, data) {
  const logEntry = {
    timestamp: getTimestamp(),
    level,
    message,
    ...(data && { data }),
  };

  const fileName = level === 'error' ? 'errors.log' : 'app.log';
  const filePath = path.join(logsDir, fileName);

  fs.appendFileSync(filePath, JSON.stringify(logEntry) + '\n', 'utf8');
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
