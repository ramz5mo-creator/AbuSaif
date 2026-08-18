'use strict';

/**
 * telegram-monitor.js
 * -------------------
 * قناة مراقبة أحادية الاتجاه: واتساب → تيليجرام.
 * لا تقرأ أوامر تيليجرام ولا تعدّل Google Sheets أو الأرصدة.
 * فشل تيليجرام معزول دائماً ولا يجوز أن يعطل معالجة رسالة واتساب.
 */

const config = require('./config');
const logger = require('./logger');

const MAX_TELEGRAM_TEXT_LENGTH = 3900;
const MAX_QUEUE_SIZE = 500;
const SEND_DELAY_MS = 75;

let sendQueue = [];
let draining = false;
let lastErrorAt = 0;

function getSettings() {
  return config.telegramMonitor || {};
}

function isEnabled() {
  const settings = getSettings();
  return Boolean(settings.enabled && settings.botToken && settings.chatId);
}

function getStatus() {
  const settings = getSettings();
  return {
    enabled: isEnabled(),
    configured: Boolean(settings.botToken && settings.chatId),
    forwardMessages: Boolean(settings.forwardMessages),
    queued: sendQueue.length,
    username: settings.botUsername || '',
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function clip(value, maxLength = 1100) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function extractMessageText(msg) {
  const content = msg?.message || {};
  if (content.conversation) return content.conversation;
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  if (content.imageMessage?.caption) return `[صورة] ${content.imageMessage.caption}`;
  if (content.videoMessage?.caption) return `[فيديو] ${content.videoMessage.caption}`;
  if (content.audioMessage) return '[تسجيل صوتي]';
  if (content.stickerMessage) return '[ملصق]';
  if (content.reactionMessage) {
    const reaction = content.reactionMessage;
    return `[تفاعل: ${reaction.text || 'إزالة'} على ${reaction.key?.id?.slice(0, 12) || 'رسالة'}]`;
  }
  return `[${Object.keys(content)[0] || 'رسالة غير نصية'}]`;
}

function formatIncomingMessage({ msg, groupName }) {
  const remoteJid = msg?.key?.remoteJid || '';
  const sender = msg?.key?.participant || msg?.key?.remoteJid || '';
  const messageId = msg?.key?.id || '';
  const text = extractMessageText(msg);
  return [
    '📩 <b>رسالة واتساب واردة</b>',
    `<b>الجروب:</b> ${escapeHtml(groupName || remoteJid)}`,
    `<b>المرسل:</b> <code>${escapeHtml(sender.split('@')[0])}</code>`,
    `<b>المعرف:</b> <code>${escapeHtml(messageId)}</code>`,
    `<b>المحتوى:</b> ${escapeHtml(clip(text))}`,
  ].join('\n');
}

function formatProcessingStatus({ status, messageId, groupName, detail }) {
  const icon = status === 'done' ? '✅' : status === 'failed' ? '❌' : '⏳';
  const title = status === 'done' ? 'اكتملت معالجة رسالة' : status === 'failed' ? 'فشلت معالجة رسالة' : 'رسالة بانتظار المعالجة';
  return [
    `${icon} <b>${title}</b>`,
    `<b>الجروب:</b> ${escapeHtml(groupName || 'غير معروف')}`,
    `<b>المعرف:</b> <code>${escapeHtml(messageId)}</code>`,
    detail ? `<b>التفاصيل:</b> ${escapeHtml(clip(detail, 1200))}` : '',
  ].filter(Boolean).join('\n');
}

function formatSystemAlert({ title, detail }) {
  return [
    '⚠️ <b>مراقبة أبو سيف</b>',
    `<b>${escapeHtml(title)}</b>`,
    detail ? escapeHtml(clip(detail, 1500)) : '',
  ].filter(Boolean).join('\n');
}

function queueText(text, { disablePreview = true } = {}) {
  if (!isEnabled()) return { queued: false, reason: 'disabled' };
  const safeText = clip(text, MAX_TELEGRAM_TEXT_LENGTH);
  if (sendQueue.length >= MAX_QUEUE_SIZE) {
    sendQueue.shift();
    logger.warn('[Telegram] امتلأ طابور المراقبة؛ أزيل أقدم تنبيه غير مرسل');
  }
  sendQueue.push({ text: safeText, disablePreview });
  void drainQueue();
  return { queued: true };
}

async function drainQueue() {
  if (draining || !isEnabled()) return;
  draining = true;
  try {
    while (sendQueue.length && isEnabled()) {
      const payload = sendQueue.shift();
      const settings = getSettings();
      try {
        const response = await fetch(`https://api.telegram.org/bot${settings.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: settings.chatId,
            text: payload.text,
            parse_mode: 'HTML',
            disable_web_page_preview: payload.disablePreview,
          }),
          signal: AbortSignal.timeout(12_000),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) throw new Error(result.description || `HTTP ${response.status}`);
      } catch (error) {
        // لا نعيد رمي الخطأ: تيليجرام قناة مراقبة غير حرجة لمسار واتساب.
        const now = Date.now();
        if (now - lastErrorAt > 60_000) {
          lastErrorAt = now;
          logger.warn('[Telegram] تعذر إرسال تنبيه المراقبة؛ يستمر واتساب بصورة مستقلة', { error: error.message });
        }
      }
      if (sendQueue.length) await new Promise(resolve => setTimeout(resolve, SEND_DELAY_MS));
    }
  } finally {
    draining = false;
  }
}

function notifyIncomingMessage(payload) {
  if (!getSettings().forwardMessages) return { queued: false, reason: 'forwarding-disabled' };
  return queueText(formatIncomingMessage(payload));
}

function notifyProcessingStatus(payload) {
  return queueText(formatProcessingStatus(payload));
}

function notifySystemAlert(title, detail) {
  return queueText(formatSystemAlert({ title, detail }));
}

function notifyIncompleteOrder(review) {
  return queueText([
    '🔎 <b>سلسلة طلب تحتاج متابعة</b>',
    `<b>الحالة:</b> ${escapeHtml(review.status || 'غير مكتملة')}`,
    `<b>الجروب:</b> ${escapeHtml(review.groupName || review.groupId || 'غير معروف')}`,
    `<b>معرف الطلب:</b> <code>${escapeHtml(review.orderMessageId || '')}</code>`,
    review.orderText ? `<b>الطلب:</b> ${escapeHtml(clip(review.orderText))}` : '',
    review.reason ? `<b>السبب:</b> ${escapeHtml(clip(review.reason))}` : '',
    '<i>تنبيه متابعة فقط — لا ينشئ أي رصيد.</i>',
  ].filter(Boolean).join('\n'));
}

async function verifyBot() {
  const settings = getSettings();
  if (!settings.botToken) return { ok: false, reason: 'missing-token' };
  try {
    const response = await fetch(`https://api.telegram.org/bot${settings.botToken}/getMe`, {
      signal: AbortSignal.timeout(12_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) return { ok: false, reason: data.description || `HTTP ${response.status}` };
    return { ok: true, username: data.result?.username || '', id: data.result?.id || null };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function _resetForTests() {
  sendQueue = [];
  draining = false;
  lastErrorAt = 0;
}

module.exports = {
  isEnabled,
  getStatus,
  extractMessageText,
  formatIncomingMessage,
  formatProcessingStatus,
  formatSystemAlert,
  notifyIncomingMessage,
  notifyProcessingStatus,
  notifySystemAlert,
  notifyIncompleteOrder,
  verifyBot,
  _resetForTests,
};
