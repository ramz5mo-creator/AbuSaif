'use strict';

/**
 * message-log.js — سجل الاستلام والمعالجة الدائم
 * =================================================
 * لا يعتمد على الذاكرة: كل رسالة تُكتب في Volume قبل تمريرها للتصنيف.
 * السجل هو صندوق المراجعة غير المالي للرسائل التي فشلت أو بقيت معلّقة.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const LOG_PATH = path.resolve(config.volumePath || '/data', 'message-processing-log.json');
const ORDER_REVIEW_LOG_PATH = path.resolve(config.volumePath || '/data', 'incomplete-order-review.json');
const MAX_RECORDS = 50_000;
const STALE_PROCESSING_MS = 5 * 60 * 1000;

let _loaded = false;
let _records = {};
let _orderReviews = {};

function _ensureLoaded() {
  if (_loaded) return;
  try {
    if (fs.existsSync(LOG_PATH)) {
      const data = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
      _records = data && typeof data === 'object' ? data : {};
    }
    if (fs.existsSync(ORDER_REVIEW_LOG_PATH)) {
      const data = JSON.parse(fs.readFileSync(ORDER_REVIEW_LOG_PATH, 'utf8'));
      _orderReviews = data && typeof data === 'object' ? data : {};
    }
  } catch (error) {
    // لا نتابع المعالجة على سجل لا يمكن الوثوق بقراءته.
    _records = {};
    logger.error('[MessageLog] تعذر تحميل سجل الرسائل الدائم', { error: error.message });
  }
  _loaded = true;
}

function _writeAtomic() {
  const directory = path.dirname(LOG_PATH);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${LOG_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(_records, null, 2));
  fs.renameSync(tempPath, LOG_PATH);
}

function _writeOrderReviewsAtomic() {
  const directory = path.dirname(ORDER_REVIEW_LOG_PATH);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${ORDER_REVIEW_LOG_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(_orderReviews, null, 2));
  fs.renameSync(tempPath, ORDER_REVIEW_LOG_PATH);
}

function _trimIfNeeded() {
  const entries = Object.entries(_records);
  if (entries.length <= MAX_RECORDS) return;
  const done = entries
    .filter(([, record]) => record.status === 'done')
    .sort((a, b) => (a[1].completedAt || a[1].receivedAt || 0) - (b[1].completedAt || b[1].receivedAt || 0));
  const removeCount = Math.min(done.length, entries.length - MAX_RECORDS);
  for (let index = 0; index < removeCount; index += 1) delete _records[done[index][0]];
}

function _serializeMessage(msg) {
  // بيانات Baileys كائن JSON؛ يحفظ النص/الرد/الإيموجي الخام من دون أي قرار مالي.
  try { return JSON.parse(JSON.stringify(msg)); }
  catch (_) { return { key: msg?.key || {}, messageTimestamp: msg?.messageTimestamp || 0, serializationError: true }; }
}

function recordIncoming(msg, { source = 'live' } = {}) {
  const messageId = msg?.key?.id;
  if (!messageId) throw new Error('لا يمكن حفظ رسالة بلا Message ID');
  _ensureLoaded();

  const current = _records[messageId];
  if (current) return { ...current, existed: true };

  const now = Date.now();
  _records[messageId] = {
    messageId,
    groupId: msg?.key?.remoteJid || '',
    timestamp: Number(msg?.messageTimestamp || 0) * 1000 || now,
    receivedAt: now,
    source,
    status: 'pending',
    retryCount: 0,
    rawMessage: _serializeMessage(msg),
  };
  _trimIfNeeded();
  _writeAtomic();
  return { ..._records[messageId], existed: false };
}

function beginProcessing(messageId) {
  _ensureLoaded();
  const record = _records[messageId];
  if (!record) throw new Error(`الرسالة ${messageId} غير موجودة في السجل الدائم`);
  if (record.status === 'done') return { acquired: false, reason: 'done', record: { ...record } };
  if (record.status === 'processing') return { acquired: false, reason: 'processing', record: { ...record } };

  record.status = 'processing';
  record.processingAt = Date.now();
  record.lastError = '';
  _writeAtomic();
  return { acquired: true, record: { ...record } };
}

function markDone(messageId, details = {}) {
  _ensureLoaded();
  const record = _records[messageId];
  if (!record) throw new Error(`الرسالة ${messageId} غير موجودة في السجل الدائم`);
  record.status = 'done';
  record.completedAt = Date.now();
  record.lastError = '';
  record.processingAt = record.processingAt || record.completedAt;
  Object.assign(record, details);
  _writeAtomic();
  return { ...record };
}

function markFailed(messageId, error, details = {}) {
  _ensureLoaded();
  const record = _records[messageId];
  if (!record) throw new Error(`الرسالة ${messageId} غير موجودة في السجل الدائم`);
  record.status = 'failed';
  record.failedAt = Date.now();
  record.retryCount = (record.retryCount || 0) + 1;
  record.lastError = String(error?.message || error || 'خطأ غير معروف').slice(0, 2000);
  Object.assign(record, details);
  _writeAtomic();
  return { ...record };
}

function resetStaleProcessing(now = Date.now()) {
  _ensureLoaded();
  let reset = 0;
  for (const record of Object.values(_records)) {
    if (record.status !== 'processing' || !record.processingAt) continue;
    if (now - record.processingAt < STALE_PROCESSING_MS) continue;
    record.status = 'failed';
    record.failedAt = now;
    record.retryCount = (record.retryCount || 0) + 1;
    record.lastError = 'انقطعت الخدمة أثناء المعالجة؛ أُعيدت الرسالة إلى طابور المحاولة';
    reset += 1;
  }
  if (reset > 0) {
    _writeAtomic();
    logger.warn(`[MessageLog] أعيدت ${reset} رسالة معلقة بعد انقطاع سابق إلى طابور المحاولة`);
  }
  return reset;
}

function isDone(messageId) {
  _ensureLoaded();
  return _records[messageId]?.status === 'done';
}

function getRetryCandidates({ limit = 100 } = {}) {
  _ensureLoaded();
  return Object.values(_records)
    .filter(record => record.status === 'pending' || record.status === 'failed')
    .sort((a, b) => (a.timestamp || a.receivedAt || 0) - (b.timestamp || b.receivedAt || 0))
    .slice(0, limit)
    .map(record => ({ ...record }));
}

function getIncompleteReviews({ limit = 100 } = {}) {
  // هذا صندوق مراجعة تشغيلي فقط: لا يستدعي Google Sheets ولا ينشئ أو يعدّل أرصدة.
  const messageFailures = getRetryCandidates({ limit }).map(record => ({
    reviewType: 'message-processing',
    messageId: record.messageId,
    groupId: record.groupId,
    timestamp: record.timestamp,
    status: record.status,
    retryCount: record.retryCount || 0,
    reason: record.lastError || 'بانتظار المعالجة',
    rawMessage: record.rawMessage,
  }));
  _ensureLoaded();
  const incompleteOrders = Object.values(_orderReviews)
    .filter(review => review.status !== 'complete')
    .sort((a, b) => (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0))
    .slice(0, limit)
    .map(review => ({ reviewType: 'incomplete-order', ...review }));
  return [...messageFailures, ...incompleteOrders].slice(0, limit);
}

function trackOrderCandidate({ messageId, groupId, timestamp, ownerPhone = '', orderText = '', classification = '', reason = '' }) {
  if (!messageId || classification === 'invalid' || classification === 'blocked') return null;
  _ensureLoaded();
  const now = Date.now();
  const current = _orderReviews[messageId];
  if (current) return { ...current };
  _orderReviews[messageId] = {
    orderMessageId: messageId,
    groupId: groupId || '',
    timestamp: timestamp || now,
    ownerPhone,
    orderText: String(orderText || '').slice(0, 1000),
    classification,
    classificationReason: reason,
    status: 'waiting_captain',
    captainReplyMessageId: '',
    captainPhone: '',
    captainReplyText: '',
    quantityEmoji: '',
    quantity: 0,
    createdAt: now,
    updatedAt: now,
  };
  _writeOrderReviewsAtomic();
  return { ..._orderReviews[messageId] };
}

function markCaptainReply({ orderMessageId, replyMessageId, captainPhone = '', captainReplyText = '' }) {
  _ensureLoaded();
  const review = _orderReviews[orderMessageId];
  if (!review) return null;
  review.captainReplyMessageId = replyMessageId || review.captainReplyMessageId;
  review.captainPhone = captainPhone || review.captainPhone;
  review.captainReplyText = String(captainReplyText || review.captainReplyText || '').slice(0, 1000);
  review.status = review.quantity > 0 ? 'complete' : 'waiting_quantity';
  review.updatedAt = Date.now();
  _writeOrderReviewsAtomic();
  return { ...review };
}

function markOrderQuantity({ orderMessageId, emoji = '', quantity = 0 }) {
  _ensureLoaded();
  const review = _orderReviews[orderMessageId];
  if (!review) return null;
  review.quantityEmoji = emoji || '';
  review.quantity = Number(quantity) || 0;
  review.status = review.captainReplyMessageId && review.quantity > 0 ? 'complete' : 'waiting_captain';
  review.updatedAt = Date.now();
  _writeOrderReviewsAtomic();
  return { ...review };
}

function getLatestGroupActivity(groupId) {
  _ensureLoaded();
  let latest = null;
  for (const record of Object.values(_records)) {
    if (record.groupId !== groupId) continue;
    const recordTimestamp = record.timestamp || record.receivedAt || 0;
    if (!latest || recordTimestamp > (latest.timestamp || latest.receivedAt || 0)) latest = record;
  }
  return latest ? {
    messageId: latest.messageId,
    timestamp: latest.timestamp,
    receivedAt: latest.receivedAt,
    status: latest.status,
  } : null;
}

function getStats() {
  _ensureLoaded();
  const stats = { total: 0, pending: 0, processing: 0, done: 0, failed: 0 };
  for (const record of Object.values(_records)) {
    stats.total += 1;
    if (Object.prototype.hasOwnProperty.call(stats, record.status)) stats[record.status] += 1;
  }
  return stats;
}

function getRecord(messageId) {
  _ensureLoaded();
  const record = _records[messageId];
  return record ? { ...record } : null;
}

function _resetForTests() {
  _loaded = true;
  _records = {};
  _orderReviews = {};
  if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
  if (fs.existsSync(ORDER_REVIEW_LOG_PATH)) fs.unlinkSync(ORDER_REVIEW_LOG_PATH);
}

module.exports = {
  recordIncoming,
  beginProcessing,
  markDone,
  markFailed,
  resetStaleProcessing,
  isDone,
  getRetryCandidates,
  getIncompleteReviews,
  trackOrderCandidate,
  markCaptainReply,
  markOrderQuantity,
  getLatestGroupActivity,
  getStats,
  getRecord,
  LOG_PATH,
  ORDER_REVIEW_LOG_PATH,
  _resetForTests,
};
