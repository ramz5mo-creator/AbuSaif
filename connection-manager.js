'use strict';
/**
 * connection-manager.js — مدير الاتصال المستقل لـ Baileys
 * =========================================================
 * المسؤوليات:
 *  - إنشاء Socket واحد فقط في أي وقت (منع التكرار)
 *  - معالجة connection.update مع تحديد سبب الانقطاع
 *  - إعادة الاتصال التلقائي مع Exponential Backoff
 *  - الحفاظ على جلسة Authentication دون QR طالما الجلسة صالحة
 *  - إصدار أحداث واضحة: CONNECTED / DISCONNECTED / RECONNECTING / RECONNECTED
 *  - عدم السماح لخطأ في معالجة رسالة بإسقاط Socket
 *
 * الاستخدام:
 *   const cm = require('./connection-manager');
 *   cm.on('CONNECTED', ({ sock, isReconnect }) => { ... });
 *   cm.on('DISCONNECTED', ({ reason, code }) => { ... });
 *   cm.on('RECONNECTING', ({ attempt, delayMs }) => { ... });
 *   cm.on('RECONNECTED', ({ sock, attempt }) => { ... });
 *   cm.start();
 */

const EventEmitter = require('events');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

// ====================================================
// الثوابت
// ====================================================

const BACKOFF_BASE_MS   = 5_000;   // 5 ثوانٍ
const BACKOFF_MAX_MS    = 120_000; // دقيقتان
const BACKOFF_FACTOR    = 2;
const BACKOFF_JITTER    = 0.2;     // ±20%
const CONFLICT_DELAY_MS = 60_000;  // 60 ثانية عند تعارض الجلسة (440)
const TIMEOUT_DELAY_MS  = 15_000;  // 15 ثانية عند timeout/unavailable
const BAD_SESSION_RETRY_DELAY_MS = 10_000; // 10 ثوانٍ — إعادة المحاولة بنفس الجلسة
const BAD_SESSION_MAX_RETRIES    = 3;      // بعد 3 فشل متتالي → مسح session

// أسباب الانقطاع المعروفة
const DISCONNECT_REASONS = {
  [DisconnectReason.badSession]:          'جلسة تالفة — يجب مسح auth',
  [DisconnectReason.connectionClosed]:    'أُغلق الاتصال',
  [DisconnectReason.connectionLost]:      'فُقد الاتصال',
  [DisconnectReason.connectionReplaced]:  'استُبدل الاتصال بجلسة أخرى',
  [DisconnectReason.loggedOut]:           'تم تسجيل الخروج',
  [DisconnectReason.restartRequired]:     'مطلوب إعادة تشغيل',
  [DisconnectReason.timedOut]:            'انتهت مهلة الاتصال',
  408:  'انتهت مهلة الطلب (408)',
  440:  'تعارض جلسة (440)',
  503:  'الخدمة غير متاحة (503)',
};

// ====================================================
// ConnectionManager
// ====================================================

class ConnectionManager extends EventEmitter {
  constructor() {
    super();
    this._sock         = null;   // Socket الحالي
    this._isStarted    = false;  // هل بدأ المدير
    this._isConnecting = false;  // هل جارٍ الاتصال الآن
    this._reconnectTimer = null; // مؤقت إعادة الاتصال
    this._attempt      = 0;      // عداد المحاولات المتتالية
    this._isFirstConnect = true; // هل هذا أول اتصال
    this._isConnected  = false;  // حالة موثوقة تحدثها connection.update
    this._destroyed    = false;  // هل تم إيقاف المدير نهائياً
    this._messageHandler = null; // معالج الرسائل الخارجي
    this._qrCallback   = null;   // callback لعرض QR
    this._qrClearCallback = null;
    this._authState    = null;   // حالة المصادقة
    this._saveCreds    = null;   // دالة حفظ بيانات الاعتماد
    this._pairingPhone = null;   // رقم مؤقت لطلب رمز الربط أثناء إنشاء Socket فقط
    this._pairingCodePromise = null;
    this._resolvePairingCode = null;
    this._rejectPairingCode = null;
    this._pairingModeActive = false;
    this._pairingCodeRequestedSock = null;
  }

  // ====================================================
  // واجهة عامة
  // ====================================================

  /** بدء تشغيل المدير (يُستدعى مرة واحدة فقط) */
  async start() {
    if (this._isStarted) {
      logger.warn('[CM] المدير يعمل بالفعل — تجاهل start()');
      return;
    }
    this._isStarted = true;
    logger.info('[CM] بدء تشغيل Connection Manager');
    await this._connect();
  }

  /** إيقاف المدير نهائياً (مثلاً عند تسجيل الخروج) */
  stop() {
    this._destroyed = true;
    this._clearReconnectTimer();
    this._closeSock('إيقاف يدوي');
    logger.info('[CM] تم إيقاف Connection Manager');
  }

  /** تسجيل معالج الرسائل الخارجي */
  setMessageHandler(handler) {
    this._messageHandler = handler;
  }

  /** تسجيل callback لعرض QR */
  onQRUpdate(updateFn, clearFn) {
    this._qrCallback      = updateFn;
    this._qrClearCallback = clearFn;
  }

  /** الحصول على Socket الحالي */
  getSocket() {
    return this._sock;
  }

  /** هل الاتصال مفتوح الآن */
  isConnected() {
    return Boolean(this._isConnected && this._sock);
  }

  /**
   * إصدار رمز ربط بديل من Socket جديد مُدار.
   * لا يُخزّن الرقم أو الرمز، ولا ينشئ أكثر من Socket واحد في أي وقت.
   */
  async requestPairingCode(phoneNumber) {
    const normalizedPhone = String(phoneNumber || '').replace(/\D/g, '').replace(/^00/, '');
    if (!/^\d{8,15}$/.test(normalizedPhone)) {
      throw new Error('صيغة رقم الهاتف غير صالحة لرمز الربط');
    }
    if (this._authState?.creds?.registered) {
      throw new Error('جلسة واتساب مرتبطة بالفعل');
    }
    if (this._pairingCodePromise) return this._pairingCodePromise;

    const pairingPromise = new Promise((resolve, reject) => {
      this._resolvePairingCode = resolve;
      this._rejectPairingCode = reject;
    });
    this._pairingPhone = normalizedPhone;
    this._pairingCodePromise = pairingPromise;
    this._pairingModeActive = true;
    this._pairingCodeRequestedSock = null;

    // نبدأ طلب الربط من Socket جديد؛ لا يُطلب الرمز إلا عند حدث QR/connecting
    // الذي يؤكد أن النقل صار جاهزاً، وفق تسلسل Baileys الرسمي.
    this._clearReconnectTimer();
    this._isConnecting = false;
    await this._connect();
    return pairingPromise;
  }

  // ====================================================
  // منطق الاتصال الداخلي
  // ====================================================

  async _connect() {
    if (this._destroyed) return;
    if (this._isConnecting) {
      logger.debug('[CM] الاتصال جارٍ بالفعل — تجاهل');
      return;
    }
    this._isConnecting = true;

    try {
      const authPath = path.resolve(config.whatsapp.authPath);
      if (!fs.existsSync(authPath)) {
        fs.mkdirSync(authPath, { recursive: true });
      }

      // تحميل بيانات المصادقة (مرة واحدة فقط أو عند الحاجة)
      if (!this._saveCreds) {
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        this._authState = state;
        this._saveCreds = saveCreds;
      }

      // جلب إصدار Baileys مع timeout
      let version;
      try {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 10_000);
        const res  = await fetchLatestBaileysVersion({ signal: ctrl.signal });
        clearTimeout(tid);
        version = res.version;
      } catch {
        version = [2, 3000, 1015901307];
        logger.debug('[CM] استخدام إصدار Baileys الافتراضي');
      }

      // إغلاق Socket القديم إن وُجد
      this._closeSock('إعادة اتصال');

      // إنشاء Socket جديد
      const sock = makeWASocket({
        version,
        auth:                this._authState,
        printQRInTerminal:   false,
        logger:              require('pino')({ level: 'silent' }),
        browser:             ['AbuSaif-Bot', 'Safari', '17.0'],
        syncFullHistory:     false,
        retryRequestDelayMs: 500,
        keepAliveIntervalMs: 20_000,  // ping كل 20 ثانية (أقل من 408 timeout)
        connectTimeoutMs:    60_000,  // 60 ثانية للاتصال الأولي
        markOnlineOnConnect: false,
        getMessage: async (key) => {
          // يُستدعى من الخارج عبر حدث 'getMessage'
          const handler = this.listenerCount('getMessage') > 0
            ? await new Promise(resolve => this.emit('getMessage', key, resolve))
            : undefined;
          return handler;
        },
      });

      this._sock = sock;

      // ربط الأحداث
      sock.ev.on('creds.update', this._saveCreds);
      sock.ev.on('connection.update', (update) => this._onConnectionUpdate(update, sock));
      sock.ev.on('messages.upsert', (data) => this._onMessagesUpsert(data));
      sock.ev.on('messages.delete', (data) => this._onMessagesDelete(data));

    } catch (err) {
      this._isConnecting = false;
      logger.error('[CM] خطأ في إنشاء Socket', { error: err.message });
      this._scheduleReconnect(null, err.message);
    }
  }

  // ====================================================
  // معالجة connection.update
  // ====================================================

  _onConnectionUpdate(update, sourceSock) {
    const { connection, lastDisconnect, qr } = update;

    // عرض QR
    if (qr) {
      if (this._pairingModeActive && sourceSock === this._sock) {
        logger.info('[CM] 📲 تم تجاوز QR لأن رمز الربط قيد الإصدار');
      } else {
        logger.info('[CM] 📱 رمز QR جديد — امسحه بواتساب');
        if (this._qrCallback) this._qrCallback(qr);
      }
    }

    // في وضع رمز الربط، QR أو connecting هو الإشارة الموثوقة بأن النقل جاهز.
    // لا نعرض QR للمستخدم ولا نطلب الرمز أكثر من مرة على Socket واحد.
    if (
      this._pairingModeActive &&
      this._pairingPhone &&
      sourceSock === this._sock &&
      !this._authState?.creds?.registered &&
      (connection === 'connecting' || Boolean(qr))
    ) {
      this._requestPairingCodeAtReadyEvent(sourceSock);
    }

    if (connection === 'open') {
      this._onConnected();
    } else if (connection === 'close') {
      this._onDisconnected(lastDisconnect);
    }
  }

  /**
   * يطلب رمز الربط عند أول حدث QR أو connecting من Socket غير مسجّل.
   * هذا هو التوقيت الموصى به في توثيق Baileys، وليس وقت makeWASocket.
   */
  _requestPairingCodeAtReadyEvent(sock) {
    if (this._pairingCodeRequestedSock === sock) return;
    this._pairingCodeRequestedSock = sock;

    Promise.resolve().then(async () => {
      try {
        const pairingCode = await sock.requestPairingCode(this._pairingPhone);
        if (!pairingCode) throw new Error('لم يُرجع واتساب رمز ربط صالحاً');
        logger.info('[CM] 📲 تم إصدار رمز ربط بديل مؤقت');
        this._resolvePairingCode?.(pairingCode);
        this._clearPairingCodeWaiter();
      } catch (error) {
        // إذا أُغلق النقل أثناء الإصدار، يعاد الطلب فقط بعد حدث QR/connecting
        // من Socket إعادة الاتصال التالي.
        if (/connection closed|connection terminated|not open/i.test(error.message || '')) {
          this._pairingCodeRequestedSock = null;
          logger.warn('[CM] قناة رمز الربط أغلقت قبل الإصدار — ستتم المحاولة على الاتصال التالي');
          return;
        }
        logger.warn('[CM] تعذر إصدار رمز الربط البديل', { error: error.message });
        this._rejectPairingCode?.(error);
        this._clearPairingMode();
      }
    });
  }

  _clearPairingCodeWaiter() {
    this._pairingPhone = null;
    this._pairingCodePromise = null;
    this._resolvePairingCode = null;
    this._rejectPairingCode = null;
  }

  _clearPairingMode() {
    this._clearPairingCodeWaiter();
    this._pairingModeActive = false;
    this._pairingCodeRequestedSock = null;
  }

  _onConnected() {
    const wasReconnect = !this._isFirstConnect;
    const prevAttempts = this._attempt;

    this._isConnecting  = false;
    this._isConnected   = true;
    this._isFirstConnect = false;
    this._attempt       = 0;
    this._badSessionRetries = 0; // نجح الاتصال — نصفّر عداد BAD_SESSION
    this._clearReconnectTimer();
    this._clearPairingMode();
    if (this._qrClearCallback) this._qrClearCallback();

    const ts = new Date().toISOString();
    if (wasReconnect) {
      logger.info(`[CM] ✅ RECONNECTED | ${ts} | بعد ${prevAttempts} محاولة`);
      this.emit('RECONNECTED', { sock: this._sock, attempt: prevAttempts, ts });
    } else {
      logger.info(`[CM] ✅ CONNECTED | ${ts}`);
      this.emit('CONNECTED', { sock: this._sock, isReconnect: false, ts });
    }
  }

  _onDisconnected(lastDisconnect) {
    this._isConnecting = false;
    this._isConnected  = false;
    const err        = new Boom(lastDisconnect?.error);
    const code       = err?.output?.statusCode;
    const rawReason  = DISCONNECT_REASONS[code] || `كود غير معروف (${code})`;
    const ts         = new Date().toISOString();

    logger.warn(`[CM] ⚡ DISCONNECTED | ${ts} | السبب: ${rawReason}`);
    this.emit('DISCONNECTED', { reason: rawReason, code, ts });

    // تسجيل الخروج الكامل — لا إعادة اتصال
    if (code === DisconnectReason.loggedOut) {
      logger.warn('[CM] ⚠️ LOGGED_OUT — مسح auth وإعادة الاتصال تلقائياً...');
      this.emit('LOGGED_OUT', { ts });
      this._clearPairingMode();
      this._clearAuthAndReconnect(ts, 'LOGGED_OUT');
      return;
    }

    // جلسة تالفة — لا إعادة اتصال تلقائية
    if (code === DisconnectReason.badSession) {
      this._badSessionRetries = (this._badSessionRetries || 0) + 1;
      this.emit('BAD_SESSION', { ts, retries: this._badSessionRetries });
      if (this._badSessionRetries <= BAD_SESSION_MAX_RETRIES) {
        logger.warn(`[CM] ⚠️ BAD_SESSION (${this._badSessionRetries}/${BAD_SESSION_MAX_RETRIES}) — إعادة المحاولة بنفس الجلسة...`);
        this._scheduleReconnect(BAD_SESSION_RETRY_DELAY_MS, `BAD_SESSION retry ${this._badSessionRetries}`);
      } else {
        logger.warn(`[CM] ⚠️ BAD_SESSION تكرر ${this._badSessionRetries}x — مسح session وطلب QR جديد`);
        this._badSessionRetries = 0;
        this._clearAuthAndReconnect(ts, 'BAD_SESSION');
      }
      return;
    }

    if (this._destroyed) return;

    // تحديد التأخير بناءً على الكود
    let delayMs;
    if (code === 440) {
      delayMs = CONFLICT_DELAY_MS + Math.random() * 30_000;
    } else if (code === 408 || code === 503) {
      delayMs = TIMEOUT_DELAY_MS + Math.random() * 5_000;
    } else {
      delayMs = this._calcBackoff();
    }

    this._scheduleReconnect(delayMs, rawReason);
  }

  // ====================================================
  // إعادة الاتصال مع Exponential Backoff
  // ====================================================

  _calcBackoff() {
    const exp    = Math.min(this._attempt, 10);
    const base   = BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, exp);
    const capped = Math.min(base, BACKOFF_MAX_MS);
    const jitter = capped * BACKOFF_JITTER * (Math.random() * 2 - 1);
    return Math.round(capped + jitter);
  }

  _scheduleReconnect(delayMs, reason) {
    if (this._destroyed) return;
    this._clearReconnectTimer();

    this._attempt++;
    const delay = delayMs ?? this._calcBackoff();
    const ts    = new Date().toISOString();

    logger.info(`[CM] 🔄 RECONNECTING | ${ts} | محاولة ${this._attempt} | بعد ${Math.round(delay / 1000)}ث | السبب: ${reason || 'غير محدد'}`);
    this.emit('RECONNECTING', { attempt: this._attempt, delayMs: delay, reason, ts });

    this._reconnectTimer = setTimeout(async () => {
      if (this._destroyed) return;
      // إعادة تحميل بيانات المصادقة قبل الاتصال
      try {
        const authPath = path.resolve(config.whatsapp.authPath);
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        this._authState = state;
        this._saveCreds = saveCreds;
      } catch (e) {
        logger.warn('[CM] فشل إعادة تحميل بيانات المصادقة', { error: e.message });
      }
      await this._connect();
    }, delay);
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  // ====================================================
  // مسح auth التالفة وإعادة الاتصال (QR جديد)
  // ====================================================

  _clearAuthAndReconnect(ts, reason) {
    if (this._destroyed) return;

    const authPath = path.resolve(config.whatsapp.authPath);
    logger.warn(`[CM] 🗑️ مسح ملفات auth التالفة (${reason}) — المسار: ${authPath}`);

    try {
      if (fs.existsSync(authPath)) {
        // مسح المجلد بالكامل (authPath = /app/auth/session — لا يحتوي على الكاشات الدائمة)
        fs.rmSync(authPath, { recursive: true, force: true });
        logger.info(`[CM] ✅ تم مسح مجلد session — سيظهر QR جديد`);
      }
    } catch (e) {
      logger.error('[CM] فشل مسح auth', { error: e.message });
    }

    // إعادة تهيئة saveCreds لإعادة تحميل الجلسة الجديدة
    this._saveCreds = null;
    this._authState = null;

    // جدولة إعادة الاتصال بعد تأخير قصير
    this._scheduleReconnect(BAD_SESSION_RETRY_DELAY_MS, reason);
  }

  // ====================================================
  // إغلاق Socket بأمان
  // ====================================================

  _closeSock(reason) {
    this._isConnected = false;
    if (!this._sock) return;
    try {
      this._sock.ev.removeAllListeners();
      this._sock.ws?.close();
      this._sock.end(new Error(reason));
    } catch { /* تجاهل أخطاء الإغلاق */ }
    this._sock = null;
  }

  // ====================================================
  // معالجة الرسائل (تحمي Socket من الأخطاء)
  // ====================================================

  async _onMessagesUpsert(data) {
    if (!this._messageHandler) return;
    try {
      await this._messageHandler(data, this._sock);
    } catch (err) {
      // خطأ في معالجة رسالة لا يُسقط Socket
      logger.error('[CM] خطأ في معالجة رسالة (محمي)', { error: err.message });
      this.emit('MESSAGE_HANDLER_ERROR', { error: err.message });
    }
  }

  async _onMessagesDelete(data) {
    try {
      this.emit('messages.delete', data);
    } catch { /* تجاهل */ }
  }
}

// ====================================================
// تصدير instance وحيد (Singleton)
// ====================================================

const connectionManager = new ConnectionManager();
module.exports = connectionManager;
