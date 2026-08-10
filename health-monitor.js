'use strict';
/**
 * health-monitor.js — مراقب صحة مستقل لاتصال واتساب
 * =====================================================
 * يفحص حالة الاتصال كل 30 ثانية ويطلب إعادة الاتصال
 * إذا كان Socket مفتوحاً ظاهرياً لكن غير مستجيب.
 */

const logger = require('./logger');

const CHECK_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS   = 10_000;

class HealthMonitor {
  constructor() {
    this._timer     = null;
    this._cm        = null; // ConnectionManager
    this._lastPong  = Date.now();
    this._started   = false;
  }

  /** بدء المراقبة */
  start(connectionManager) {
    if (this._started) return;
    this._cm      = connectionManager;
    this._started = true;
    this._timer   = setInterval(() => this._check(), CHECK_INTERVAL_MS);
    logger.info('[HealthMonitor] بدء المراقبة');
  }

  /** إيقاف المراقبة */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._started = false;
    logger.info('[HealthMonitor] تم الإيقاف');
  }

  /** تسجيل استجابة ping */
  recordPong() {
    this._lastPong = Date.now();
  }

  _check() {
    if (!this._cm) return;
    const sock = this._cm.getSocket();

    if (!sock) {
      logger.debug('[HealthMonitor] لا يوجد Socket');
      return;
    }

    const wsState = sock.ws?.readyState;

    if (wsState === 1) {
      // الاتصال مفتوح — فحص الاستجابة
      const timeSinceLastPong = Date.now() - this._lastPong;
      if (timeSinceLastPong > PING_TIMEOUT_MS * 3) {
        logger.warn(`[HealthMonitor] ⚠️ Socket مفتوح لكن لا استجابة منذ ${Math.round(timeSinceLastPong/1000)}ث`);
      } else {
        logger.debug('[HealthMonitor] 💓 الاتصال سليم');
      }
    } else if (wsState === 3 || wsState === 2) {
      // مغلق أو يُغلق — إذا لم يكن هناك إعادة اتصال جارية
      if (!this._cm._isConnecting && !this._cm._reconnectTimer) {
        logger.warn('[HealthMonitor] ⚠️ Socket مغلق بدون إعادة اتصال — إطلاق إعادة اتصال');
        this._cm._scheduleReconnect(null, 'HealthMonitor: Socket مغلق');
      }
    }
  }
}

const healthMonitor = new HealthMonitor();
module.exports = healthMonitor;
