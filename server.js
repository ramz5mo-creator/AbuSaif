/**
 * server.js - نقطة تشغيل النظام v5 (Self-Healing + Recovery)
 * ================================
 * المنطق:
 *
 * 1. أي رسالة تبدأ بـ "تم" → تُحفظ في tamCache + سجل_تم
 *    (لا تُسجَّل كطلب ولا كانتاج/استلام)
 *
 * 2. إيموجي (👍/2️⃣/3️⃣/5️⃣) على رسالة "تم":
 *    → انتاج لمن وضع الإيموجي
 *    → استلام لمن كتب "تم" (الكابتن)
 *    → يُسجَّل في ورقة يومية (كل يوم ورقة)
 *
 * 3. ❌ على رسالة "تم":
 *    → خصم من الطرفين
 *
 * 4. أي رسالة أخرى → تُتجاهل (لا نسجل الطلبات)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const config = require('./config');
const logger = require('./logger');
const whatsapp = require('./whatsapp');
const parser = require('./parser');
const sheets = require('./sheets');
const { createOneTimeBroadcastProcessor } = require('./one-time-broadcast');

// ============================================================
// تنظيف السجلات عند بدء التشغيل — يفرّغ كل ملف >10MB فوراً
// ============================================================
(function cleanOldLogs() {
  try {
    const logsDir = path.join(process.env.VOLUME_PATH || '/app/auth', 'logs');
    if (!fs.existsSync(logsDir)) return;
    const files = fs.readdirSync(logsDir);
    let freed = 0;
    for (const file of files) {
      const filePath = path.join(logsDir, file);
      try {
        const stat = fs.statSync(filePath);
        const sizeMB = stat.size / (1024 * 1024);
        // تفريغ فوري لأي ملف سجل يتجاوز 10MB
        if (sizeMB > 10) {
          fs.writeFileSync(filePath, '');
          freed += stat.size;
          console.log(`[STARTUP] ✅ تم تفريغ: ${file} (${sizeMB.toFixed(1)} MB محرَّرة)`);
        }
      } catch (e) {}
    }
    if (freed > 0) {
      console.log(`[STARTUP] 🧹 إجمالي المساحة المحرَّرة: ${(freed/1024/1024).toFixed(1)} MB`);
    } else {
      console.log('[STARTUP] ✅ السجلات نظيفة (كل ملف < 10MB)');
    }
  } catch (e) {
    console.error('[STARTUP] خطأ في تنظيف السجلات:', e.message);
  }
})();



// ====================================================
// v5: Deduplication — منع معالجة نفس الرسالة مرتين
// يعمل مع الرسائل العادية والمسترجعة (Recovery)
// ====================================================
const processedMessageIds = new Set();
const PROCESSED_MSG_MAX = 10000;
// Map مؤقتة لتخزين الإيموجي الجديد (غير المعتمد) عند تغيير الإيموجي
// مفتاح: `${phone}_${targetMsgId}` قيمة: { emoji, ts }
const pendingEmojiReplace = new Map();
const PENDING_EMOJI_TTL = 5000; // 5 ثوانٍ كافية لربط remove + add

function isAlreadyProcessed(msgId) {
  return processedMessageIds.has(msgId);
}

function markAsProcessed(msgId) {
  if (!msgId) return;
  processedMessageIds.add(msgId);
  if (processedMessageIds.size > PROCESSED_MSG_MAX) {
    const oldest = Array.from(processedMessageIds).slice(0, 1000);
    oldest.forEach(id => processedMessageIds.delete(id));
  }
}

// ====================================================
// خادم ويب لعرض QR + حالة البوت
// ====================================================
let currentQR = null;
let oneTimeBroadcast = null;

const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/qr') {
    if (!currentQR) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="background:#111;color:#0f0;font-size:20px;text-align:center;padding:40px;font-family:monospace;">
        <div style="border:2px solid #0f0;padding:20px;border-radius:10px;display:inline-block;">
          <h1>✅ البوت متصل بواتساب</h1>
          <p>tamCache: ${whatsapp.getCacheStats().tamCache} رسالة</p>
          <p>نظام التسجيل: <span style="color:#ff0;">مُفعّل (المسجلين فقط)</span></p>
          <p>آخر تحديث: ${new Date().toLocaleString('ar-JO', {timeZone:'Asia/Amman'})}</p>
        </div>
        <div style="margin-top:30px;">
          ${config.sheets.weeklyReport?.enabled === true
            ? '<a href="/weekly-report" style="color:#0f0;text-decoration:none;border:1px solid #0f0;padding:10px;border-radius:5px;margin-left:10px;">📊 تقرير نهاية الأسبوع</a>'
            : '<span style="color:#888;border:1px solid #555;padding:10px;border-radius:5px;margin-left:10px;">📊 تقرير نهاية الأسبوع (موقوف مؤقتاً)</span>'}
          <a href="/groups" style="color:#0f0;text-decoration:none;border:1px solid #0f0;padding:10px;border-radius:5px;margin-left:10px;">👥 الجروبات</a>
          <a href="/logout" style="color:#f00;text-decoration:none;border:1px solid #f00;padding:10px;border-radius:5px;">⚠️ تسجيل الخروج</a>
        </div>
        <script>setTimeout(()=>location.reload(), 30000);</script>
      </body></html>`);
      return;
    }
    try {
      const qrImage = await QRCode.toDataURL(currentQR, { width: 400 });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="background:#000;text-align:center;padding:30px;">
        <h1 style="color:#fff;">📱 امسح رمز QR بواتساب</h1>
        <img src="${qrImage}" style="width:400px;height:400px;border:10px solid #fff;border-radius:10px;" />
        <p style="color:#ff0;font-size:18px;">يتغير كل 20 ثانية — حدّث الصفحة</p>
        <script>setTimeout(()=>location.reload(), 20000);</script>
      </body></html>`);
    } catch (e) {
      res.writeHead(500);
      res.end('Error');
    }
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ...whatsapp.getCacheStats() }));
  } else if (req.url === '/status') {
    // v5: حالة النظام الكاملة
    const cm = whatsapp.getConnectionManager ? whatsapp.getConnectionManager() : null;
    const recoveryStats = whatsapp.getRecoveryStats ? whatsapp.getRecoveryStats() : {};
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      version: 'v5',
      connected: whatsapp.isConnected ? whatsapp.isConnected() : false,
      processedMessages: processedMessageIds.size,
      cacheStats: whatsapp.getCacheStats(),
      connectionManager: cm ? { connected: cm.isConnected() } : null,
      recovery: recoveryStats,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }, null, 2));
  } else if (req.url === '/recovery-status/dreamax-2026-08-12') {
    // قراءة فقط: لا تشغّل أي Recovery ولا تعرض بيانات رسائل أو أرقام هواتف.
    const receiptPath = path.resolve(config.volumePath, 'historical-recovery-dreamax-2026-08-12.complete.json');
    let receipt = null;
    try {
      if (fs.existsSync(receiptPath)) receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    } catch (error) {
      logger.warn('[Historical Recovery] تعذر قراءة إيصال دريمكس', { error: error.message });
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      recovery: 'dreamax-2026-08-12',
      completed: Boolean(receipt),
      result: receipt ? {
        completedAt: receipt.completedAt || null,
        recovered: Number(receipt.recovered || 0),
        skipped: Number(receipt.skipped || 0),
        errors: Number(receipt.errors || 0),
      } : null,
    }, null, 2));
  } else if (req.method === 'POST' && req.url === '/internal/recover-dreamax-2026-08-12') {
    // مسار مؤقت ومحمي لاستعادة فجوة دريمكس التي تم اعتمادها فقط (00:00–00:41 بتوقيت عمّان).
    const expectedToken = process.env.HISTORICAL_RECOVERY_TOKEN || '';
    const receivedToken = String(req.headers['x-historical-recovery-token'] || '');
    const tokenMatches = expectedToken.length > 0 && receivedToken.length === expectedToken.length &&
      crypto.timingSafeEqual(Buffer.from(expectedToken), Buffer.from(receivedToken));
    if (!tokenMatches) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'غير مصرح' }));
      return;
    }

    const socket = whatsapp.getSocket();
    const recovery = whatsapp.recoveryService;
    const dreamax = (config.whatsapp.targetGroups || []).find(group => group.prefix === 'دريمكس');
    if (!socket || !whatsapp.isConnected?.() || !recovery || !dreamax) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'واتساب أو خدمة الاسترجاع غير جاهزة' }));
      return;
    }

    try {
      const result = await recovery.runHistoricalRecovery(socket, {
        groupId: dreamax.id,
        fromTimestamp: Date.parse('2026-08-11T21:00:00.000Z'),
        toTimestamp: Date.parse('2026-08-11T21:41:59.999Z'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (error) {
      logger.error('[Historical Recovery] فشل الاسترجاع المعتمد لدريمكس', { error: error.message });
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
  } else if (req.url.startsWith('/debug/')) {
    const phone = req.url.replace('/debug/', '').trim();
    const lookup = whatsapp.lookupPhone(phone);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ phone, ...lookup }, null, 2));
  } else if (req.url === '/participants') {
    try {
      const sock = whatsapp.getSocket();
      const targetGroups = config.whatsapp.targetGroups || [];
      const allParticipants = {};
      for (const group of targetGroups) {
        try {
          const metadata = await sock.groupMetadata(group.id);
          allParticipants[group.name] = (metadata.participants || []).map(p => ({
            id: p.id || null,
            lid: p.lid || null,
            admin: p.admin || null
          }));
        } catch(e) { allParticipants[group.name] = 'error: ' + e.message; }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(allParticipants, null, 2));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/groups') {
    const groups = whatsapp.getDiscoveredGroups();
    let html = `<html><head><meta charset="utf-8"><style>
      body{background:#111;color:#0f0;font-family:monospace;padding:20px;direction:rtl;}
      table{border-collapse:collapse;width:100%;margin-top:20px;}
      th,td{border:1px solid #0f0;padding:10px;text-align:center;}
      th{background:#0f0;color:#000;}
      tr:hover{background:#1a3a1a;}
      h1{text-align:center;}
      .id{font-size:10px;color:#888;word-break:break-all;}
    </style></head><body>`;
    html += `<h1>📋 الجروبات المكتشفة (${groups.size})</h1>`;
    html += `<table><tr><th>#</th><th>اسم آخر مرسل</th><th>عدد الرسائل</th><th>آخر رسالة</th><th>معرف الجروب</th></tr>`;
    let i = 0;
    for (const [id, info] of groups) {
      i++;
      const lastTime = info.lastMessage ? new Date(info.lastMessage).toLocaleString('ar-JO', {timeZone:'Asia/Amman'}) : '-';
      html += `<tr><td>${i}</td><td>${info.name || '-'}</td><td>${info.messageCount}</td><td>${lastTime}</td><td class="id">${id}</td></tr>`;
    }
    html += `</table>`;
    html += `<p style="text-align:center;margin-top:20px;color:#ff0;">حدّث الصفحة بعد إرسال رسائل في الجروبات</p>`;
    html += `<script>setTimeout(()=>location.reload(), 15000);</script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (req.url === '/all-groups') {
    const sock = whatsapp.getSocket();
    if (!sock) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('البوت غير متصل حالياً');
      return;
    }
    try {
      const groups = await sock.groupFetchAllParticipating();
      const groupList = Object.values(groups);
      let html = `<html><head><meta charset="utf-8"><style>
        body{background:#111;color:#0f0;font-family:monospace;padding:20px;direction:rtl;}
        table{border-collapse:collapse;width:100%;margin-top:20px;}
        th,td{border:1px solid #0f0;padding:10px;text-align:center;}
        th{background:#0f0;color:#000;}
        tr:hover{background:#1a3a1a;}
        h1{text-align:center;}
        .id{font-size:12px;color:#fff;word-break:break-all;user-select:all;background:#333;padding:5px;}
      </style></head><body>`;
      html += `<h1>📋 كافة الجروبات المشترك بها (${groupList.length})</h1>`;
      html += `<table><tr><th>#</th><th>اسم الجروب</th><th>معرف الجروب (JID)</th></tr>`;
      groupList.forEach((group, i) => {
        html += `<tr><td>${i+1}</td><td>${group.subject}</td><td><div class="id">${group.id}</div></td></tr>`;
      });
      html += `</table></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Error: ' + e.message);
    }
  } else if (req.url === '/reconcile' || req.url.startsWith('/reconcile?')) {
    // مطابقة يدوية للأوراق اليومية
    try {
      const urlParams = new URL(req.url, 'http://localhost').searchParams;
      const dateStr = urlParams.get('date') || null; // ?date=2026-08-09
      const result = await sheets.reconcileDailySheets(dateStr);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (result.success) {
        const rows = result.results.map(r => `<li>${r}</li>`).join('');
        res.end(`<html><body style="background:#111;color:#0f0;text-align:center;padding:40px;font-family:monospace;direction:rtl;">
          <h1>🔄 تمت المطابقة بنجاح!</h1>
          <p>التاريخ: ${result.date}</p>
          <ul style="list-style:none;padding:0">${rows}</ul>
          <br><a href="/" style="color:#fff;text-decoration:none;border:1px solid #fff;padding:10px;border-radius:5px;">العودة للرئيسية</a>
        </body></html>`);
      } else {
        res.end('فشلت المطابقة: ' + result.message);
      }
    } catch (e) {
      res.writeHead(500);
      res.end('Error: ' + e.message);
    }
  } else if (req.url === '/weekly-report') {
    if (config.sheets.weeklyReport?.enabled !== true) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="background:#111;color:#ff0;text-align:center;padding:40px;font-family:monospace;direction:rtl;"><h1>تقرير نهاية الأسبوع موقوف مؤقتاً</h1><p>لن يتم إنشاء أو تعديل أي تقرير حتى إعادة تفعيله صراحةً.</p><br><a href="/" style="color:#fff;">العودة للرئيسية</a></body></html>');
      return;
    }
    try {
      const success = await sheets.generateWeeklyReport();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (success) {
        res.end(`<html><body style="background:#111;color:#0f0;text-align:center;padding:40px;font-family:monospace;direction:rtl;">
          <h1>📊 تم توليد تقرير نهاية الأسبوع بنجاح!</h1>
          <p>يمكنك الآن مراجعة ورقة "نهاية الاسبوع" في Google Sheets.</p>
          <br>
          <a href="/" style="color:#fff;text-decoration:none;border:1px solid #fff;padding:10px;border-radius:5px;">العودة للرئيسية</a>
        </body></html>`);
      } else {
        res.end('فشل توليد التقرير. راجع السجلات.');
      }
    } catch (e) {
      res.writeHead(500);
      res.end('Error: ' + e.message);
    }
  } else if (req.url === '/logout') {
    // مسح ملفات الجلسة وإعادة التشغيل
    const fs = require('fs');
    const path = require('path');
    const authPath = path.resolve(config.whatsapp.authPath);
    try {
      if (fs.existsSync(authPath)) {
        const files = fs.readdirSync(authPath);
        for (const file of files) {
          const curPath = path.join(authPath, file);
          if (fs.lstatSync(curPath).isDirectory()) {
            fs.rmSync(curPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(curPath);
          }
        }
        logger.info('🗑️ تم مسح محتويات مجلد الجلسة');
      }
    } catch (e) {
      logger.error('خطأ في مسح الجلسة', { error: e.message });
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><body style="background:#111;color:#ff0;font-size:20px;text-align:center;padding:40px;font-family:monospace;">
      <h1>🗑️ تم مسح الجلسة</h1>
      <p>البوت سيعيد التشغيل الآن...</p>
      <p>انتظر دقيقة ثم افتح الصفحة الرئيسية لمسح QR الجديد</p>
      <script>setTimeout(()=>location.href='/', 5000);</script>
    </body></html>`);
    // إعادة التشغيل فوراً
    setTimeout(() => process.exit(0), 1000);
  } else if (req.url === '/dashboard') {
    // لوحة التحكم الرئيسية
    const groups = config.whatsapp.targetGroups || [];
    const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>لوحة التحكم — AbuSaif</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:linear-gradient(135deg,#0a0a1a 0%,#0d1b2a 100%);min-height:100vh;font-family:'Segoe UI',Tahoma,sans-serif;color:#e0e0e0;}
    .header{background:rgba(0,0,0,0.4);backdrop-filter:blur(10px);padding:20px 30px;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:space-between;}
    .header h1{font-size:24px;color:#fff;font-weight:700;}
    .header .subtitle{color:#888;font-size:14px;margin-top:4px;}
    .status-dot{width:10px;height:10px;border-radius:50%;background:#00ff88;display:inline-block;margin-left:8px;animation:pulse 2s infinite;}
    @keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.4;}}
    .container{padding:30px;max-width:1200px;margin:0 auto;}
    .page-title{font-size:20px;color:#aaa;margin-bottom:25px;}
    .groups-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px;}
    .group-card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:25px;cursor:pointer;transition:all 0.3s;text-decoration:none;color:inherit;display:block;}
    .group-card:hover{background:rgba(255,255,255,0.1);border-color:rgba(99,179,237,0.5);transform:translateY(-3px);box-shadow:0 10px 30px rgba(0,0,0,0.3);}
    .group-icon{width:56px;height:56px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:26px;margin-bottom:15px;}
    .group-name{font-size:20px;font-weight:700;color:#fff;margin-bottom:6px;}
    .group-meta{color:#888;font-size:13px;}
    .group-arrow{float:left;color:#63b3ed;font-size:20px;margin-top:-5px;}
    .card-dreamex .group-icon{background:linear-gradient(135deg,#667eea,#764ba2);}
    .card-nashama .group-icon{background:linear-gradient(135deg,#f093fb,#f5576c);}
    .card-alsaif .group-icon{background:linear-gradient(135deg,#4facfe,#00f2fe);}
    .card-default .group-icon{background:linear-gradient(135deg,#43e97b,#38f9d7);}
    .loading{text-align:center;padding:60px;color:#666;}
    .back-btn{display:inline-flex;align-items:center;gap:8px;color:#63b3ed;text-decoration:none;font-size:14px;padding:8px 16px;border:1px solid rgba(99,179,237,0.3);border-radius:8px;transition:all 0.2s;}
    .back-btn:hover{background:rgba(99,179,237,0.1);}
    .days-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;}
    .day-card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:20px;cursor:pointer;transition:all 0.3s;text-decoration:none;color:inherit;display:block;}
    .day-card:hover{background:rgba(255,255,255,0.09);border-color:rgba(99,179,237,0.4);transform:translateY(-2px);}
    .day-date{font-size:18px;font-weight:700;color:#fff;margin-bottom:12px;}
    .day-stats{display:flex;gap:12px;}
    .stat{flex:1;background:rgba(0,0,0,0.3);border-radius:8px;padding:10px;text-align:center;}
    .stat-val{font-size:22px;font-weight:700;}
    .stat-lbl{font-size:11px;color:#888;margin-top:2px;}
    .prod .stat-val{color:#68d391;}
    .recv .stat-val{color:#63b3ed;}
    .today-badge{background:linear-gradient(135deg,#f6d365,#fda085);color:#000;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;margin-right:8px;vertical-align:middle;}
    .data-table{width:100%;border-collapse:collapse;margin-top:20px;}
    .data-table th{background:rgba(255,255,255,0.08);padding:12px 16px;text-align:right;font-size:13px;color:#aaa;border-bottom:1px solid rgba(255,255,255,0.1);}
    .data-table td{padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.05);font-size:14px;}
    .data-table tr:hover td{background:rgba(255,255,255,0.04);}
    .data-table .phone{color:#888;font-size:12px;direction:ltr;text-align:left;}
    .data-table .name{font-weight:600;color:#fff;}
    .data-table .prod{color:#68d391;font-weight:700;font-size:16px;text-align:center;}
    .data-table .recv{color:#63b3ed;font-weight:700;font-size:16px;text-align:center;}
    .totals-bar{display:flex;gap:20px;margin-bottom:25px;}
    .total-box{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:16px 24px;flex:1;text-align:center;}
    .total-box .val{font-size:32px;font-weight:800;}
    .total-box .lbl{font-size:12px;color:#888;margin-top:4px;}
    .total-prod .val{color:#68d391;}
    .total-recv .val{color:#63b3ed;}
    .total-diff .val{color:#f6ad55;}
    .spinner{display:inline-block;width:20px;height:20px;border:2px solid rgba(255,255,255,0.2);border-top-color:#63b3ed;border-radius:50%;animation:spin 0.8s linear infinite;}
    @keyframes spin{to{transform:rotate(360deg);}}
    #content{min-height:300px;}
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>✨ لوحة التحكم <span class="status-dot"></span></h1>
      <div class="subtitle">نظام تجريد الطلبات — AbuSaif</div>
    </div>
    <div style="color:#888;font-size:13px;" id="clock"></div>
  </div>
  <div class="container">
    <div id="content">
      <div class="loading">جاري التحميل...</div>
    </div>
  </div>
  <script>
    const GROUPS = ${JSON.stringify(groups.map(g => ({ name: g.name, prefix: g.prefix, id: g.id })))};
    
    function updateClock() {
      const now = new Date();
      const t = now.toLocaleString('ar-JO', {timeZone:'Asia/Amman',hour:'2-digit',minute:'2-digit',second:'2-digit',weekday:'long',day:'numeric',month:'long'});
      document.getElementById('clock').textContent = t;
    }
    setInterval(updateClock, 1000); updateClock();

    function getCardClass(name) {
      const n = name.toLowerCase();
      if(n.includes('dream')) return 'card-dreamex';
      if(n.includes('nasha')) return 'card-nashama';
      if(n.includes('saif')) return 'card-alsaif';
      return 'card-default';
    }
    function getIcon(name) {
      const n = name.toLowerCase();
      if(n.includes('dream')) return '🚀';
      if(n.includes('nasha')) return '💥';
      if(n.includes('saif')) return '⚔️';
      return '📊';
    }

    async function showLinkLid() {
      document.getElementById('content').innerHTML = '<div class="loading"><div class="spinner"></div> جاري جلب بيانات الربط...</div>';
      const res = await fetch('/api/registered-lid-status');
      const registered = await res.json();
      const unresolved = registered.filter(r => !r.resolved);
      const resolved = registered.filter(r => r.resolved);
      let html = '<a class="back-btn" onclick="showGroups();return false;" href="#">&rarr; الرئيسية</a>';
      html += '<h2 style="margin:20px 0 10px;color:#fff;font-size:20px;">🔗 ربط LID يدوياً</h2>';
      html += '<p style="color:#888;font-size:13px;margin-bottom:20px;">الأشخاص الذين لم يُربط رقمهم بعد — عند وضع إيموجي على ردودهم لن يُسجَّل الانتاج لهم</p>';
      if(!unresolved.length) {
        html += '<div style="background:rgba(104,211,145,0.1);border:1px solid rgba(104,211,145,0.3);border-radius:12px;padding:20px;text-align:center;color:#68d391;">✅ جميع المسجلين مربوطون بـ LID</div>';
      } else {
        html += '<div style="background:rgba(245,101,101,0.1);border:1px solid rgba(245,101,101,0.3);border-radius:12px;padding:16px;margin-bottom:20px;">';
        html += '<span style="color:#fc8181;font-weight:700;">' + unresolved.length + ' شخص غير مربوط</span>';
        html += '<span style="color:#888;font-size:13px;margin-right:10px;">— أدخل رقم الهاتف لكل شخص لربطه</span></div>';
        html += '<table class="data-table"><thead><tr><th>الاسم</th><th>الهاتف</th><th>رقم الهاتف (للربط)</th><th></th></tr></thead><tbody>';
        for(const r of unresolved) {
          html += '<tr id="row-' + r.phone + '">';
          html += '<td class="name">' + r.name + '</td>';
          html += '<td class="phone">' + r.phone + '</td>';
          html += '<td><input id="inp-' + r.phone + '" type="text" placeholder="مثال: 962778793241" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:6px 10px;color:#fff;width:200px;font-size:13px;direction:ltr;"></td>';
          html += '<td><button onclick="linkLid(\'' + r.phone + '\')" style="background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;border-radius:6px;padding:7px 16px;cursor:pointer;font-size:13px;">ربط</button></td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
      }
      if(resolved.length) {
        html += '<h3 style="margin:30px 0 15px;color:#68d391;font-size:16px;">✅ مربوطون (' + resolved.length + ')</h3>';
        html += '<table class="data-table"><thead><tr><th>الاسم</th><th>الهاتف</th><th>LID</th></tr></thead><tbody>';
        for(const r of resolved) {
          html += '<tr><td class="name">' + r.name + '</td><td class="phone">' + r.phone + '</td><td style="color:#888;font-size:11px;direction:ltr;">' + (r.lid||'').substring(0,20) + '...</td></tr>';
        }
        html += '</tbody></table>';
      }
      document.getElementById('content').innerHTML = html;
    }

    async function linkLid(phone) {
      const inp = document.getElementById('inp-' + phone);
      const fullPhone = (inp.value || '').trim().replace(/[^0-9]/g, '');
      if(!fullPhone || fullPhone.length < 9) { alert('أدخل رقم هاتف صحيح'); return; }
      // البحث عن LID في أعضاء الجروب
      let lid = null;
      for(const g of GROUPS) {
        const res2 = await fetch('/api/group-members?groupId=' + encodeURIComponent(g.id));
        const members = await res2.json();
        for(const m of members) {
          if(!m.resolved && m.pushName) {
            // نحاول مطابقة pushName مع اسم الشخص
            const row = document.getElementById('row-' + phone);
            const nameCell = row ? row.cells[0].textContent : '';
            if(m.pushName.includes(nameCell.trim()) || nameCell.includes(m.pushName.trim())) {
              lid = m.lid;
              break;
            }
          }
        }
        if(lid) break;
      }
      // ربط مباشر برقم الهاتف
      const res3 = await fetch('/api/link-lid?lid=' + encodeURIComponent(lid || 'manual-' + phone) + '&phone=' + encodeURIComponent(fullPhone), { method: 'POST' });
      const data = await res3.json();
      if(data.ok || data.lid) {
        const row = document.getElementById('row-' + phone);
        if(row) { row.style.opacity='0.4'; row.cells[3].innerHTML = '<span style="color:#68d391;">✅ تم الربط</span>'; }
      } else {
        alert('فشل الربط: ' + (data.error || 'خطأ غير معروف'));
      }
    }

    async function showMembersStatus() {
      document.getElementById('content').innerHTML = '<div class="loading"><div class="spinner"></div> جاري جلب حالة الأعضاء...</div>';
      let html = '<a class="back-btn" onclick="showGroups();return false;" href="#">&rarr; الرئيسية</a>';
      html += '<h2 style="margin:20px 0 10px;color:#fff;font-size:20px;">👥 حالة أعضاء الجروبات</h2>';
      html += '<p style="color:#888;font-size:13px;margin-bottom:20px;">🟢 رقم حقيقي &nbsp;|&nbsp; 🟡 LID محلول &nbsp;|&nbsp; 🔴 LID غير محلول</p>';
      for(const g of GROUPS) {
        html += '<h3 style="color:#f6ad55;margin:25px 0 10px;">' + g.prefix + '</h3>';
        try {
          const r = await fetch('/api/group-members?groupId=' + encodeURIComponent(g.id));
          const members = await r.json();
          if(!members.length) { html += '<p style="color:#888;">لا يوجد بيانات</p>'; continue; }
          const real = members.filter(function(m){ return m.status === 'real'; });
          const resolved = members.filter(function(m){ return m.status === 'resolved'; });
          const unresolved = members.filter(function(m){ return m.status === 'unresolved'; });
          html += '<div style="display:flex;gap:15px;margin-bottom:12px;flex-wrap:wrap;">';
          html += '<span style="background:rgba(104,211,145,0.15);border:1px solid #68d391;border-radius:8px;padding:5px 12px;color:#68d391;font-size:13px;">🟢 رقم حقيقي: ' + real.length + '</span>';
          html += '<span style="background:rgba(246,173,85,0.15);border:1px solid #f6ad55;border-radius:8px;padding:5px 12px;color:#f6ad55;font-size:13px;">🟡 LID محلول: ' + resolved.length + '</span>';
          html += '<span style="background:rgba(245,101,101,0.15);border:1px solid #fc8181;border-radius:8px;padding:5px 12px;color:#fc8181;font-size:13px;">🔴 LID غير محلول: ' + unresolved.length + '</span>';
          html += '<span style="background:rgba(160,174,192,0.15);border:1px solid #a0aec0;border-radius:8px;padding:5px 12px;color:#a0aec0;font-size:13px;">المجموع: ' + members.length + '</span>';
          html += '</div>';
          html += '<table class="data-table"><thead><tr><th>الاسم</th><th>الهاتف / LID</th><th>الحالة</th></tr></thead><tbody>';
          const sorted = members.slice().sort(function(a,b){
            const order = {unresolved:0, resolved:1, real:2};
            return (order[a.status]||0) - (order[b.status]||0);
          });
          for(let i=0;i<sorted.length;i++) {
            const m = sorted[i];
            const statusIcon = m.status==='real' ? '🟢' : m.status==='resolved' ? '🟡' : '🔴';
            const statusText = m.status==='real' ? 'رقم حقيقي' : m.status==='resolved' ? 'LID محلول' : 'LID غير محلول';
            const phoneDisplay = m.phone || ((m.lid||'').substring(0,20)+'...');
            html += '<tr><td class="name">' + (m.pushName||'—') + '</td><td class="phone" style="direction:ltr;font-size:12px;">' + phoneDisplay + '</td><td>' + statusIcon + ' ' + statusText + '</td></tr>';
          }
          html += '</tbody></table>';
        } catch(e) {
          html += '<p style="color:#fc8181;">خطأ في جلب البيانات: ' + e.message + '</p>';
        }
      }
      document.getElementById('content').innerHTML = html;
    }

    function showGroups() {
      let html = '<p class="page-title">اختر جروباً لعرض بياناته</p>';
      html += '<div style="margin-bottom:20px;display:flex;gap:10px;flex-wrap:wrap;">';
      html += '<a class="back-btn" onclick="showLinkLid();return false;" href="#" style="background:rgba(102,126,234,0.15);border-color:rgba(102,126,234,0.4);">\uD83D\uDD17 ربط LID للأرقام</a>';
      html += '<a class="back-btn" onclick="showMembersStatus();return false;" href="#" style="background:rgba(104,211,145,0.15);border-color:rgba(104,211,145,0.4);color:#68d391;">👥 حالة الأعضاء</a>';
      html += '</div>';
      html += '<div class="groups-grid">';
      for(const g of GROUPS) {
        const cls = getCardClass(g.name);
        html += \`<a class="group-card \${cls}" onclick="showDays('\${g.prefix}','\${g.name}');return false;" href="#">
          <div class="group-icon">\${getIcon(g.name)}</div>
          <div class="group-name">\${g.prefix}</div>
          <div class="group-meta">\${g.name}</div>
          <span class="group-arrow">&larr;</span>
        </a>\`;
      }
      html += '</div>';
      document.getElementById('content').innerHTML = html;
    }

    async function showDays(prefix, name) {
      document.getElementById('content').innerHTML = '<div class="loading"><div class="spinner"></div> جاري جلب البيانات...</div>';
      const res = await fetch('/api/days?prefix=' + encodeURIComponent(prefix));
      const days = await res.json();
      const today = new Date().toLocaleDateString('sv-SE', {timeZone:'Asia/Amman'});
      let html = \`<a class="back-btn" onclick="showGroups();return false;" href="#">&rarr; الجروبات</a>
        <h2 style="margin:20px 0 25px;color:#fff;font-size:22px;">📅 أيام \${prefix}</h2>\`;
      if(!days.length) { html += '<p style="color:#888;">\u0644ا توجد بيانات حتى الآن</p>'; }
      else {
        html += '<div class="days-grid">';
        for(const d of days) {
          const isToday = d.date === today;
          const dateLabel = new Date(d.date + 'T00:00:00').toLocaleDateString('ar-JO', {weekday:'long',day:'numeric',month:'long',year:'numeric'});
          html += \`<a class="day-card" onclick="showDay('\${d.name}','\${d.date}');return false;" href="#">
            <div class="day-date">\${isToday ? '<span class="today-badge">اليوم</span>' : ''}\${dateLabel}</div>
            <div class="day-stats">
              <div class="stat prod"><div class="stat-val">\${d.totalProduction}</div><div class="stat-lbl">الانتاج</div></div>
              <div class="stat recv"><div class="stat-val">\${d.totalReception}</div><div class="stat-lbl">الاستلام</div></div>
              <div class="stat"><div class="stat-val" style="color:#f6ad55;">\${d.rows}</div><div class="stat-lbl">شخص</div></div>
            </div>
          </a>\`;
        }
        html += '</div>';
      }
      document.getElementById('content').innerHTML = html;
    }

    async function showDay(sheetName, date) {
      document.getElementById('content').innerHTML = '<div class="loading"><div class="spinner"></div> جاري جلب بيانات اليوم...</div>';
      const res = await fetch('/api/day?sheet=' + encodeURIComponent(sheetName));
      const rows = await res.json();
      const parts = sheetName.split('-');
      const prefix = parts[0];
      const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('ar-JO', {weekday:'long',day:'numeric',month:'long',year:'numeric'});
      const totalProd = rows.reduce((s,r)=>s+r.production,0);
      const totalRecv = rows.reduce((s,r)=>s+r.reception,0);
      const diff = totalProd - totalRecv;
      let html = \`<a class="back-btn" onclick="showDays('\${prefix}','\${prefix}');return false;" href="#">&rarr; أيام \${prefix}</a>
        <h2 style="margin:20px 0 20px;color:#fff;font-size:20px;">📆 \${dateLabel}</h2>
        <div class="totals-bar">
          <div class="total-box total-prod"><div class="val">\${totalProd}</div><div class="lbl">إجمالي الانتاج</div></div>
          <div class="total-box total-recv"><div class="val">\${totalRecv}</div><div class="lbl">إجمالي الاستلام</div></div>
          <div class="total-box total-diff"><div class="val">\${diff >= 0 ? '+' : ''}\${diff}</div><div class="lbl">الفرق</div></div>
        </div>\`;
      if(!rows.length) { html += '<p style="color:#888;">لا توجد بيانات لهذا اليوم</p>'; }
      else {
        html += '<table class="data-table"><thead><tr><th>الاسم</th><th>الهاتف</th><th style="text-align:center;">الانتاج</th><th style="text-align:center;">الاستلام</th></tr></thead><tbody>';
        const sorted = [...rows].sort((a,b) => (b.production+b.reception)-(a.production+a.reception));
        for(const r of sorted) {
          html += \`<tr><td class="name">\${r.name || '—'}</td><td class="phone">\${r.phone}</td><td class="prod">\${r.production || '—'}</td><td class="recv">\${r.reception || '—'}</td></tr>\`;
        }
        html += '</tbody></table>';
      }
      document.getElementById('content').innerHTML = html;
    }

    showGroups();
  </script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (req.url.startsWith('/api/days')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const prefix = urlObj.searchParams.get('prefix') || '';
    try {
      const days = await sheets.getDaysList(prefix);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(days));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url.startsWith('/api/day')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const sheetName = urlObj.searchParams.get('sheet') || '';
    try {
      const data = await sheets.getDayData(sheetName);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/internal/one-time-saif-greeting' && req.method === 'POST') {
    const configuredToken = process.env.ONE_TIME_BROADCAST_TOKEN || '';
    const requestToken = req.headers['x-one-time-broadcast-token'] || '';
    if (!configuredToken || requestToken !== configuredToken) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'غير موجود' }));
      return;
    }
    const requestPath = path.join(config.volumePath, 'one-time-broadcast.json');
    const sentPath = path.join(config.volumePath, 'one-time-broadcast.sent.json');
    const sendingPath = path.join(config.volumePath, 'one-time-broadcast.sending.json');
    if (fs.existsSync(sentPath)) {
      const receipt = JSON.parse(fs.readFileSync(sentPath, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'already-sent', messageId: receipt.messageId || '' }));
      return;
    }
    if (fs.existsSync(sendingPath)) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'محاولة الإرسال قيد التحقق بالفعل' }));
      return;
    }
    if (!fs.existsSync(requestPath)) {
      fs.writeFileSync(requestPath, JSON.stringify({
        type: 'dreamax-test-message',
        text: 'اهلا بالجميع',
      }));
      logger.info('📣 تم تجهيز طلب التحية الأحادي إلى السيف');
    }
    if (!oneTimeBroadcast) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'معالج الإرسال لم يكتمل تشغيله بعد' }));
      return;
    }
    const result = await oneTimeBroadcast.processPendingRequest();
    if (result.status !== 'sent') {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: result.status, error: result.error || 'لم يتم الإرسال بعد' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: result.status, messageId: result.receipt.messageId || '' }));
  } else if (req.url.startsWith('/api/link-lid') && req.method === 'POST') {
    // ربط LID برقم يدوياً: POST /api/link-lid?lid=XXX@lid&phone=9627XXXXXXXX
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        const lid = urlObj.searchParams.get('lid') || '';
        const phone = urlObj.searchParams.get('phone') || '';
        if (!lid || !phone) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'lid and phone are required' }));
          return;
        }
        const jid = phone.includes('@') ? phone : phone + '@s.whatsapp.net';
        whatsapp.addLidMapping(lid, jid);
        logger.info('ربط LID يدوي: ' + lid + ' -> ' + jid);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, lid, phone: jid }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (req.url.startsWith('/api/group-members')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const groupId = urlObj.searchParams.get('groupId') || '';
    try {
      const members = await whatsapp.getGroupMembersWithLidStatus(groupId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(members));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/api/registered-lid-status') {
    try {
      const status = whatsapp.getRegisteredLidStatus ? whatsapp.getRegisteredLidStatus() : [];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(status));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/api/unresolved-lids') {
    try {
      const unresolvedMap = whatsapp.getUnresolvedLids ? whatsapp.getUnresolvedLids() : [];
      const cacheStats = whatsapp.getCacheStats();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ unresolved: unresolvedMap, stats: cacheStats }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/refresh-dashboard' || req.url === '/api/refresh-dashboard') {
    // تحديث ورقة الرئيسية يدوياً
    try {
      await sheets.createDashboardSheet();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, message: 'تم تحديث ورقة الرئيسية بنجاح' }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/sync-all-lids' || req.url === '/api/sync-all-lids') {
    // مزامنة LID شاملة لجميع الجروبات مع محاولة حل غير المحلول
    try {
      logger.info('🔄 طلب مزامنة LID شاملة');
      const result = await whatsapp.syncAllLidsFull();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      logger.error('❌ فشل المزامنة الشاملة', { error: e.message });
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  } else if (req.url === '/force-sync-lids' || req.url === '/api/force-sync-lids') {
    // مزامنة LID يدوياً لجميع الجروبات
    try {
      const syncResult = await whatsapp.syncGroupLids();
      // إعادة تحميل أسماء المسجلين
      await sheets.loadRegisteredUsers(true);
      const unresolved = whatsapp.getUnresolvedLids ? whatsapp.getUnresolvedLids() : [];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        newLinks: syncResult.newLinks,
        total: syncResult.total,
        unresolvedCount: unresolved.length,
        unresolved: unresolved.map(u => ({ name: u.pushName, lid: u.lid?.substring(0, 15) }))
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/unresolved-lids') {
    // عرض جميع الأعضاء الذين لم يُحل LID الخاص بهم
    try {
      const lidMap = whatsapp.getLidToPhoneMap ? whatsapp.getLidToPhoneMap() : new Map();
      const msgCache = whatsapp.getMessageCache ? whatsapp.getMessageCache() : new Map();
      
      // جمع جميع LIDs غير المحلولة من messageCache
      const unresolvedMap = new Map(); // lid → { name, lid }
      for (const [msgId, msg] of msgCache) {
        const senderJid = msg.key?.participant || msg.key?.remoteJid || '';
        if (senderJid.includes('@lid') && !lidMap.has(senderJid)) {
          const name = msg.pushName || 'غير معروف';
          if (!unresolvedMap.has(senderJid)) {
            unresolvedMap.set(senderJid, { name, lid: senderJid });
          }
        }
      }
      
      const list = Array.from(unresolvedMap.values());
      
      // عرض HTML جميل
      let html = `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>LIDs غير محلولة</title>
      <style>body{background:#111;color:#0f0;font-family:monospace;padding:20px;}
      table{border-collapse:collapse;width:100%;} th,td{border:1px solid #0f0;padding:8px;text-align:right;}
      th{background:#003300;} tr:hover{background:#001100;}
      .btn{background:#003300;color:#0f0;border:1px solid #0f0;padding:5px 10px;cursor:pointer;border-radius:4px;}
      input{background:#001100;color:#0f0;border:1px solid #0f0;padding:5px;width:150px;border-radius:4px;}
      </style></head><body>
      <h2>🔍 LIDs غير محلولة (${list.length})</h2>
      <p>لربط LID برقم هاتف، أدخل الرقم واضغط ربط</p>
      <table><tr><th>الاسم</th><th>LID (مختصر)</th><th>ربط برقم هاتف</th></tr>`;
      
      for (const item of list) {
        const shortLid = item.lid.substring(0, 20);
        html += `<tr>
          <td>${item.name}</td>
          <td style="direction:ltr">${shortLid}</td>
          <td>
            <input type="text" id="phone_${shortLid}" placeholder="مثال: 962778793241">
            <button class="btn" onclick="mapLid('${item.lid}', document.getElementById('phone_${shortLid}').value)">ربط</button>
          </td>
        </tr>`;
      }
      
      html += `</table>
      <script>
      async function mapLid(lid, phone) {
        if (!phone) { alert('أدخل رقم الهاتف'); return; }
        const r = await fetch('/map-lid?lid=' + encodeURIComponent(lid) + '&phone=' + encodeURIComponent(phone));
        const d = await r.json();
        if (d.success) { alert('✅ تم الربط: ' + phone); location.reload(); }
        else { alert('❌ فشل: ' + d.error); }
      }
      </script></body></html>`;
      
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url?.startsWith('/map-lid')) {
    // ربط LID برقم هاتف يدوياً
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const lid = urlObj.searchParams.get('lid');
      const phone = urlObj.searchParams.get('phone');
      if (!lid || !phone) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'lid و phone مطلوبان' }));
        return;
      }
      // تنظيف الرقم
      const cleanedPhone = phone.replace(/[^0-9]/g, '');
      const phoneJid = cleanedPhone.includes('@') ? cleanedPhone : `${cleanedPhone}@s.whatsapp.net`;
      whatsapp.addLidMapping(lid, phoneJid);
      logger.info(`✅ ربط LID يدوي: ${lid.substring(0,15)} → ${cleanedPhone}`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, lid: lid.substring(0,20), phone: cleanedPhone }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/members-db' || req.url === '/api/members-db') {
    // حالة قاعدة بيانات Members
    try {
      const membersDb = require('./members-db');
      const stats = membersDb.getStats();
      const unresolved = membersDb.getUnresolvedLids().slice(0, 20);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        stats,
        unresolvedSample: unresolved,
        lidMapSize: whatsapp.getLidToPhoneMap ? whatsapp.getLidToPhoneMap().size : 0,
      }, null, 2));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('AbuSaif Bot v4');
  }
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  logger.info(`🌐 خادم يعمل على البورت ${PORT}`);
});

function setCurrentQR(qr) { currentQR = qr; }

// v5: تصدير دالة معالجة الرسائل للـ Recovery Service
// تسمح لـ recovery-service.js بتمرير الرسائل الفائتة عبر نفس pipeline
async function processRecoveredMessage(msg) {
  const _msgId = msg?.key?.id;
  if (_msgId && isAlreadyProcessed(_msgId)) {
    logger.debug('[Recovery][Dedup] تجاهل رسالة مسترجعة مكررة', { msgId: _msgId?.substring(0, 8) });
    return false;
  }
  if (_msgId) markAsProcessed(_msgId);
  // تمرير الرسالة عبر نفس pipeline الرسائل العادية
  try {
    await whatsapp._triggerMessageHandler(msg);
    return true;
  } catch (e) {
    logger.error('[Recovery] خطأ في معالجة رسالة مسترجعة', { error: e.message, msgId: _msgId?.substring(0, 8) });
    return false;
  }
}
module.exports = { processRecoveredMessage };
function clearCurrentQR() { currentQR = null; }

// ====================================================
// البحث عن رقم الكابتن
// ====================================================
async function findCaptainPhone(quotedMessageId, fallbackPhone) {
  // 1. tamCache (الأسرع)
  if (quotedMessageId) {
    const fromCache = whatsapp.getCaptainByMessageId(quotedMessageId);
    if (fromCache) {
      logger.info('💾 كابتن من tamCache', { captain: fromCache });
      return fromCache;
    }
  }

  // 2. من بيانات الرسالة (orderOwnerPhone)
  if (fallbackPhone) {
    logger.info('📱 كابتن من بيانات الرسالة', { captain: fallbackPhone });
    return fallbackPhone;
  }

  // 3. من ورقة سجل_تم (بعد إعادة الاتصال)
  if (quotedMessageId) {
    const fromSheet = await sheets.getCaptainFromTamSheet(quotedMessageId);
    if (fromSheet) {
      whatsapp.setCaptainForMessage(quotedMessageId, fromSheet);
      return fromSheet;
    }
  }

  return null;
}

// ====================================================
// دالة مساعدة: حل LID إلى رقم هاتف حقيقي
// تُستخدم قبل كل تسجيل في الشيت
// ====================================================
async function resolveLidPhone(phone) {
  if (!phone) return phone;
  // إذا لم يكن LID → أرجعه كما هو
  if (!phone.includes('@lid')) return phone;
  
  // محاولة 1: resolveLid() مع base-prefix matching
  const fromMap = whatsapp.resolveLid(phone);
  if (fromMap && !fromMap.includes('@lid')) {
    const clean = fromMap.split('@')[0].replace(/\D/g, '');
    if (clean.length >= 9) {
      logger.info(`✅ حل LID للتسجيل (resolveLid): ${phone.substring(0,15)} → ${clean}`);
      return clean;
    }
  }
  
  // محاولة 2: USyncQuery مباشرة
  try {
    const directResolved = await whatsapp.resolveLidDirect(phone);
    if (directResolved && !directResolved.includes('@lid')) {
      const clean = directResolved.split('@')[0].replace(/\D/g, '');
      if (clean.length >= 9) {
        logger.info(`✅ حل LID للتسجيل (USyncQuery): ${phone.substring(0,15)} → ${clean}`);
        return clean;
      }
    }
  } catch (e) {
    logger.debug('فشل حل LID عبر USyncQuery', { error: e.message });
  }
  
  // إذا لم يُحل → أرجع الجزء الرقمي فقط (سيُسجل كمعرف مؤقت)
  logger.warn(`⚠️ LID لم يُحل للتسجيل: ${phone.substring(0,15)} — سيُسجل كـ LID مؤقت`);
  whatsapp.queueLidForResolve(phone);
  return phone.split(':')[0]; // أرجع الجزء الرقمي فقط (بدون @lid)
}

function normalizePhoneForComparison(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : digits;
}

function getCachedMessageContext(message) {
  const payload = message?.message || {};
  return payload.extendedTextMessage?.contextInfo ||
    payload.imageMessage?.contextInfo ||
    payload.videoMessage?.contextInfo ||
    payload.audioMessage?.contextInfo ||
    payload.documentMessage?.contextInfo || null;
}

/** يستخرج نص الرسالة الأصلية المضمّن داخل رد واتساب عندما لا تكون في messageCache. */
function getQuotedContextText(contextInfo) {
  if (!contextInfo?.quotedMessage) return '';
  return whatsapp.extractText({ message: contextInfo.quotedMessage }) || '';
}

/** يبني صف التدقيق دون الاعتماد على نجاحه في تسجيل الأرصدة اليومية. */
function buildOrderDetail({ result, msg, quotedMsgId, groupPrefix, producerPhone, captainPhone, reactorPhone }) {
  const targetMessage = quotedMsgId ? whatsapp.getCachedMessage(quotedMsgId) : null;
  const targetContext = getCachedMessageContext(targetMessage);
  const persistedContext = quotedMsgId ? whatsapp.getOrderContextByReplyId(quotedMsgId) : null;
  const orderMessageId = persistedContext?.orderMessageId || targetContext?.stanzaId || quotedMsgId || '';
  const originalOrderMessage = orderMessageId
    ? whatsapp.getCachedMessage(orderMessageId)
    : targetMessage;
  const embeddedOrderText = getQuotedContextText(targetContext);
  const cachedOrderText = whatsapp.extractText(originalOrderMessage) || '';
  const cachedTamText = whatsapp.extractText(targetMessage) || '';

  const producerName = sheets.getRegisteredName(producerPhone) ||
    whatsapp.getPushName(originalOrderMessage) || 'غير معروف';
  const captainName = sheets.getRegisteredName(captainPhone) ||
    whatsapp.getPushName(targetMessage) || 'غير محدد';
  const reactorName = sheets.getRegisteredName(reactorPhone) || whatsapp.getPushName(msg) || '';
  const samePerson = normalizePhoneForComparison(producerPhone) &&
    normalizePhoneForComparison(producerPhone) === normalizePhoneForComparison(captainPhone);

  return {
    transactionId: result.transactionId,
    timestamp: result.timestamp,
    groupPrefix,
    producerName,
    producerPhone,
    captainName,
    captainPhone,
    reactorName,
    reactorPhone,
    quantity: result.quantity,
    orderText: persistedContext?.orderText || cachedOrderText || embeddedOrderText || result.quotedText || 'غير متوفر',
    tamText: persistedContext?.tamText || (targetContext ? (cachedTamText || result.quotedText || 'غير متوفر') : ''),
    emoji: result.text || '',
    status: samePerson ? 'يحتاج مراجعة' : 'نشط',
    tamMessageId: (targetContext || persistedContext) ? quotedMsgId : '',
    orderMessageId,
    source: (targetContext || persistedContext) ? 'تفاعل على رسالة تم' : 'تفاعل على الطلب',
    notes: samePerson ? 'تحذير: رقم المنتج والكابتن متطابقان' : '',
  };
}

// ====================================================
// بدء التشغيل
// ====================================================
async function start() {
  logger.info('═══════════════════════════════════════');
  logger.info('   🚀 نظام AbuSaif v5 — Self-Healing + Recovery');
  logger.info('═══════════════════════════════════════');

  // 0. إنشاء مجلدات VOLUME إذا لم تكن موجودة
  const fs = require('fs');
  const path = require('path');
  const volumePath = path.resolve(config.volumePath);
  const authSessionPath = path.resolve(config.whatsapp.authPath);
  const logsPath = path.resolve(config.logging.logsPath);
  [volumePath, authSessionPath, logsPath].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info(`📁 تم إنشاء المجلد: ${dir}`);
    }
  });
  logger.info(`💾 VOLUME_PATH: ${volumePath} (${process.env.VOLUME_PATH ? 'Railway Volume' : 'محلي'})`);
  logger.info(`🔑 AUTH_PATH: ${authSessionPath}`);

  // 1. تهيئة Google Sheets
  try {
    await sheets.initialize();
    logger.info('✅ Google Sheets متصل');
        await sheets.loadSettings();
    logger.info('✅ الإعدادات محمّلة');
    await sheets.ensureOrderDetailsSheet();
    logger.info('✅ ورقة تفاصيل الطلبات جاهزة');
    await sheets.ensureOperationReviewsSheet();
    logger.info('✅ ورقة مراجعة العمليات جاهزة');
    const importedReviews = await sheets.backfillOperationReviewsFromOrderDetails();
    if (importedReviews.created) logger.info('✅ تم استيراد مراجعات قائمة', importedReviews);
    // إنشاء/تحديث ورقة الرئيسية عند بدء التشغيل
    sheets.createDashboardSheet().catch(e => logger.warn('فشل تحديث الرئيسية', { error: e.message }));
  } catch (error) {
    logger.warn('⚠️ Google Sheets غير متاح', { error: error.message });
  }
  // 2. معالج الرسائل
  whatsapp.setMessageHandler(async (msg, sock) => {

    // ====================================================
    // حالة 1: تفاعل (reaction) 👍 / 2️⃣ / 3️⃣ / ❌
    // ====================================================
    if (whatsapp.isReaction(msg)) {
      const result = await parser.processMessage(msg, sock);
      if (!result) return;

      const producerPhone = result.phone;
      const quantity = result.quantity;
      const quotedMsgId = result.quotedMessageId;
      const remoteJid = msg.key.remoteJid;
      const orderOwnerPhone = result.orderOwnerPhone || result.quotedPhone || null;

      // === قاعدة: إذا وضع شخص إيموجي على رسالته هو نفسه → تجاهل
      // لكن هذه القاعدة لا تنطبق إذا كان الإيموجي على رسالة "تم" لكابتن آخر
      // لأن صاحب الطلب (أمجد) يضع إيموجي على رد الكابتن (يعقوب) لتحديد الكمية
      const _captainFromTamEarly = quotedMsgId ? whatsapp.getCaptainByMessageId(quotedMsgId) : null;
      // فحص إضافي: هل الرسالة المستهدفة هي reply (تم) من messageCache
      let _isTargetAReply = !!_captainFromTamEarly;
      if (!_isTargetAReply && quotedMsgId) {
        const _targetMsgEarly = whatsapp.getCachedMessage(quotedMsgId);
        const _targetMsgObjEarly = _targetMsgEarly?.message || {};
        const _targetCtxEarly = 
          _targetMsgObjEarly.extendedTextMessage?.contextInfo ||
          _targetMsgObjEarly.imageMessage?.contextInfo ||
          _targetMsgObjEarly.videoMessage?.contextInfo ||
          _targetMsgObjEarly.audioMessage?.contextInfo ||
          _targetMsgObjEarly.documentMessage?.contextInfo || null;
        _isTargetAReply = !!_targetCtxEarly?.quotedMessage;
      }

      if (!_isTargetAReply) {
        // فقط إذا لم يكن الإيموجي على رسالة "تم" — نطبق قاعدة التجاهل الذاتي
        const _producerFromOrderEarly = quotedMsgId ? whatsapp.getOrderByReplyId(quotedMsgId) : null;
        const _realOwner = _producerFromOrderEarly || orderOwnerPhone;
        if (_realOwner && producerPhone) {
          const cleanProducer = producerPhone.replace(/\D/g, '');
          const cleanOwner = _realOwner.replace(/\D/g, '');
          if (cleanProducer === cleanOwner ||
              (cleanProducer.length >= 9 && cleanOwner.length >= 9 &&
               cleanProducer.slice(-9) === cleanOwner.slice(-9))) {
            logger.info('⚠️ تجاهل: شخص وضع إيموجي على رسالته هو نفسه', {
              phone: producerPhone,
              msgId: quotedMsgId?.substring(0, 8)
            });
            return;
          }
        }
      } else {
        // الإيموجي على رسالة "تم" — تحقق فقط أن واضع الإيموجي ليس الكابتن نفسه
        // الكابتن = من tamCache أو من orderOwnerPhone (صاحب الرسالة المستهدفة)
        const _captainForGuard = _captainFromTamEarly || orderOwnerPhone;
        if (_captainForGuard) {
          const cleanProducer = producerPhone.replace(/\D/g, '');
          const cleanCaptain = _captainForGuard.replace(/\D/g, '');
          if (cleanProducer === cleanCaptain ||
              (cleanProducer.length >= 9 && cleanCaptain.length >= 9 &&
               cleanProducer.slice(-9) === cleanCaptain.slice(-9))) {
            logger.info('⚠️ تجاهل: الكابتن وضع إيموجي على رسالته هو نفسه', {
              phone: producerPhone,
              msgId: quotedMsgId?.substring(0, 8)
            });
            return;
          }
        }
      }

      // تحديد بادئة الجروب
      const targetGroups = config.whatsapp.targetGroups || [];
      const groupInfo = targetGroups.find(g => g.id === remoteJid);
      const groupPrefix = groupInfo ? groupInfo.prefix : '';

            // ====================================================
      // تحديد الكابتن وصاحب الطلب بشكل صحيح
      // الحالة 1: الإيموجي على رسالة "تم" مباشرة
      //   - quotedMsgId موجود في tamCache → الكابتن معروف
      //   - orderCache[quotedMsgId] موجود → صاحب الطلب معروف
      // الحالة 2: الإيموجي على رسالة الطلب مباشرة
      //   - quotedMsgId ليس في tamCache → واضع الإيموجي هو الكابتن
      //   - orderOwnerPhone = صاحب الرسالة (المنتج)
      // ====================================================

      // أولاً: هل الإيموجي على رسالة "تم"?
      const captainFromTam = quotedMsgId ? whatsapp.getCaptainByMessageId(quotedMsgId) : null;
      // صاحب الطلب من orderCache (مربوط بـ id رسالة "تم")
      const producerFromOrder = quotedMsgId ? whatsapp.getOrderByReplyId(quotedMsgId) : null;

      let captainPhone, realProducerPhone;

      if (captainFromTam) {
        // الحالة 1: الإيموجي على رسالة "تم"
        // الكابتن = من tamCache
        // صاحب الطلب = من orderCache أو orderOwnerPhone
        let resolvedCaptain = captainFromTam;
        // إذا كان الكابتن LID غير محلول، نحاول حله الآن
        if (resolvedCaptain && resolvedCaptain.includes('@lid')) {
          // محاولة 1: من lidToPhoneMap
          const lidResolved = whatsapp.resolveLid(resolvedCaptain);
          if (lidResolved && !lidResolved.includes('@lid')) {
            logger.info(`✅ حل LID الكابتن عند الإيموجي (lidMap): ${resolvedCaptain.substring(0,15)} → ${lidResolved}`);
            resolvedCaptain = lidResolved;
            if (quotedMsgId) whatsapp.setCaptainForMessage(quotedMsgId, resolvedCaptain);
          } else {
            // محاولة 2: من pushName رسالة "تم" في messageCache
            const tamMsg = quotedMsgId ? whatsapp.getCachedMessage(quotedMsgId) : null;
            const captainPushName = tamMsg?.pushName || whatsapp.getPushNameFromCachedMessage(quotedMsgId);
            if (captainPushName && captainPushName !== 'غير معروف') {
              const resolvedByName = whatsapp.resolvePhoneByPushName(captainPushName);
              if (resolvedByName && !resolvedByName.includes('@lid')) {
                logger.info(`✅ حل LID الكابتن عند الإيموجي (pushName): ${captainPushName} → ${resolvedByName}`);
                resolvedCaptain = resolvedByName;
                whatsapp.addLidMapping(captainFromTam, resolvedByName);
                if (quotedMsgId) whatsapp.setCaptainForMessage(quotedMsgId, resolvedCaptain);
              } else {
                // محاولة 3: resolveLidDirect عبر USyncQuery
                const directResolved = await whatsapp.resolveLidDirect(resolvedCaptain);
                if (directResolved && !directResolved.includes('@lid')) {
                  logger.info(`✅ حل LID الكابتن عند الإيموجي (USyncQuery): ${resolvedCaptain.substring(0,15)} → ${directResolved}`);
                  resolvedCaptain = directResolved;
                  if (quotedMsgId) whatsapp.setCaptainForMessage(quotedMsgId, resolvedCaptain);
                } else {
                  logger.warn(`⚠️ كابتن LID لا يزال غير محلول عند الإيموجي`, {
                    lid: resolvedCaptain.substring(0,15),
                    pushName: captainPushName
                  });
                }
              }
            } else {
              // محاولة 3 (بدون pushName): resolveLidDirect عبر USyncQuery
              const directResolved = await whatsapp.resolveLidDirect(resolvedCaptain);
              if (directResolved && !directResolved.includes('@lid')) {
                logger.info(`✅ حل LID الكابتن عند الإيموجي (USyncQuery/noPushName): ${resolvedCaptain.substring(0,15)} → ${directResolved}`);
                resolvedCaptain = directResolved;
                if (quotedMsgId) whatsapp.setCaptainForMessage(quotedMsgId, resolvedCaptain);
              } else {
                logger.warn(`⚠️ كابتن LID بدون pushName`, { lid: resolvedCaptain.substring(0,15) });
              }
            }
          }
        }
        captainPhone = resolvedCaptain;
        // صاحب الطلب: من orderCache أولاً
        // إذا كان orderOwnerPhone = الكابتن نفسه (مقلوب)، استخدم واضع الإيموجي بدلاً
        const _captainNorm = captainPhone ? captainPhone.replace(/\D/g, '').slice(-9) : null;
        const _ownerNorm = orderOwnerPhone ? orderOwnerPhone.replace(/\D/g, '').slice(-9) : null;
        const _ownerIsCaptain = _captainNorm && _ownerNorm && _captainNorm === _ownerNorm;
        if (producerFromOrder) {
          realProducerPhone = producerFromOrder;
        } else if (_ownerIsCaptain) {
          // orderOwnerPhone هو الكابتن — واضع الإيموجي هو صاحب الطلب
          realProducerPhone = producerPhone;
        } else {
          realProducerPhone = orderOwnerPhone;
        }
        logger.info('📌 حالة 1: إيموجي على رسالة تم', {
          captain: captainPhone, producer: realProducerPhone, ownerWasCaptain: _ownerIsCaptain, qty: quantity
        });
      } else {
        // tamCache فارغ — نحاول طرق بديلة لتحديد إذا كانت رسالة "تم"
        
        // محاولة 1: فحص Sheet (سجل_تم)
        const captainFromSheet = quotedMsgId ? await sheets.getCaptainFromTamSheet(quotedMsgId) : null;
        if (captainFromSheet) {
          captainPhone = captainFromSheet;
          // نفس منطق حالة 1: إذا orderOwnerPhone = الكابتن → واضع الإيموجي هو صاحب الطلب
          const _cNorm1b = captainPhone ? captainPhone.replace(/\D/g, '').slice(-9) : null;
          const _oNorm1b = orderOwnerPhone ? orderOwnerPhone.replace(/\D/g, '').slice(-9) : null;
          if (producerFromOrder) {
            realProducerPhone = producerFromOrder;
          } else if (_cNorm1b && _oNorm1b && _cNorm1b === _oNorm1b) {
            realProducerPhone = producerPhone;
          } else {
            realProducerPhone = orderOwnerPhone;
          }
          logger.info('📌 حالة 1b: إيموجي على رسالة تم (من Sheet)', {
            captain: captainPhone, producer: realProducerPhone, qty: quantity
          });
        } else {
          // محاولة 2: فحص messageCache — إذا الرسالة المستهدفة هي reply (رد على رسالة أخرى)
          // فهي رسالة "تم" وصاحبها هو الكابتن
          const targetMsg = quotedMsgId ? whatsapp.getCachedMessage(quotedMsgId) : null;
          const targetMsgObj = targetMsg?.message || {};
          const targetContextInfo = 
            targetMsgObj.extendedTextMessage?.contextInfo ||
            targetMsgObj.imageMessage?.contextInfo ||
            targetMsgObj.videoMessage?.contextInfo ||
            targetMsgObj.audioMessage?.contextInfo ||
            targetMsgObj.documentMessage?.contextInfo || null;
          const isTargetReply = !!targetContextInfo?.quotedMessage;

          if (isTargetReply && orderOwnerPhone) {
            // الرسالة المستهدفة هي رد (تم) → صاحبها هو الكابتن
            captainPhone = orderOwnerPhone; // صاحب رسالة "تم" = الكابتن
            // صاحب الطلب = صاحب الرسالة التي رد عليها الكابتن
            const originalOrderMsgId = targetContextInfo.stanzaId;
            const originalOrderMsg = originalOrderMsgId ? whatsapp.getCachedMessage(originalOrderMsgId) : null;
            if (originalOrderMsg) {
              const originalOwnerJid = whatsapp.getSenderJid(originalOrderMsg);
              const originalOwnerPhone = originalOwnerJid ? originalOwnerJid.split('@')[0].replace(/\D/g, '') : null;
              realProducerPhone = originalOwnerPhone || producerPhone;
            } else {
              // لا يمكن تحديد صاحب الطلب من الكاش — نستخدم واضع الإيموجي
              realProducerPhone = producerPhone;
            }
            // حفظ في tamCache للمرات القادمة
            whatsapp.setCaptainForMessage(quotedMsgId, captainPhone);
            if (realProducerPhone) {
              whatsapp.setOrderForReply(quotedMsgId, realProducerPhone, {
                orderMessageId: originalOrderMsgId || '',
                orderText: whatsapp.extractText(originalOrderMsg) || getQuotedContextText(targetContextInfo),
                tamText: whatsapp.extractText(targetMsg) || '',
              });
            }
            logger.info('📌 حالة 1c: إيموجي على رسالة تم (من messageCache/contextInfo)', {
              captain: captainPhone, producer: realProducerPhone, qty: quantity
            });
          } else {
            // الحالة 2: الإيموجي على رسالة الطلب مباشرة (ليست رد)
            // واضع الإيموجي = الكابتن
            // صاحب الرسالة = المنتج
            captainPhone = producerPhone;
            realProducerPhone = orderOwnerPhone;
            logger.info('📌 حالة 2: إيموجي على رسالة طلب مباشرة', {
              captain: captainPhone, producer: realProducerPhone, qty: quantity
            });
          }
        }
      }

      if (result.type === 'accept') {
        // === فحص هل هذا تعديل (إيموجي جديد على نفس الرسالة المسجلة سابقاً) ===
        const existingTransaction = await sheets.findTransactionByMessageId(quotedMsgId, realProducerPhone || producerPhone);
        
        if (existingTransaction) {
          if (existingTransaction.quantity !== quantity) {
          // هذا تعديل - تغيير الإيموجي
          const producerName = whatsapp.getPushName(msg);
          logger.info('✏️ محاولة تعديل', {
            producer: producerPhone,
            oldQty: existingTransaction.quantity,
            newQty: quantity,
            msgId: quotedMsgId?.substring(0, 8)
          });

          const editResult = await sheets.processEdit({
            messageId: quotedMsgId,
            editorPhone: producerPhone,
            editorName: producerName || '',
            newQuantity: quantity,
            groupPrefix,
          });

          if (editResult.success) {
            logger.info(`✏️ تعديل ناجح: ${editResult.message}`);
          } else {
            logger.warn(`⚠️ فشل التعديل: ${editResult.message} - سيتم تسجيل كعملية جديدة`);
            // إذا فشل التعديل (انتهت المهلة)، لا نسجل عملية جديدة لنفس الرسالة
          }
          return;
          }

          // نفس العملية والكمية مسجلتان بالفعل. لا نعيد تحديث الأرصدة أو نسجل صفاً ثانياً.
          logger.info('⏭️ تفاعل مسترجع مكرر — العملية موجودة بالكمية نفسها', {
            msgId: quotedMsgId?.substring(0, 8),
            quantity,
          });
          return;
        }

        // === انتاج + استلام (عملية جديدة) ===
        // صاحب الطلب = realProducerPhone
        // واضع الإيموجي = producerPhone
        let finalProducerPhone = realProducerPhone || producerPhone;
        
        // حل LID إلى رقم حقيقي قبل التسجيل
        if (finalProducerPhone && finalProducerPhone.includes('@lid')) {
          finalProducerPhone = await resolveLidPhone(finalProducerPhone);
        }
        let resolvedCaptainForSheet = captainPhone;
        if (resolvedCaptainForSheet && resolvedCaptainForSheet.includes('@lid')) {
          resolvedCaptainForSheet = await resolveLidPhone(resolvedCaptainForSheet);
        }
        
        logger.info('🎯 تسجيل انتاج+استلام', {
          producer: finalProducerPhone,
          emojiBy: producerPhone,
          captain: resolvedCaptainForSheet || '❓',
          qty: quantity,
          group: groupInfo ? groupInfo.name : 'Unknown'
        });

        try {
          const producerName = sheets.getRegisteredName(finalProducerPhone) || whatsapp.getPushName(msg);
          await sheets.updateTotalsProduction(finalProducerPhone, quantity, groupPrefix, producerName);
          logger.info(`✅ انتاج: ${finalProducerPhone} +${quantity} [${groupPrefix}]`);
        } catch (error) {
          logger.error('❌ فشل انتاج', { error: error.message });
        }

        if (resolvedCaptainForSheet) {
          try {
            const captainName = sheets.getRegisteredName(resolvedCaptainForSheet) || 'كابتن';
            await sheets.updateTotalsReception(resolvedCaptainForSheet, quantity, groupPrefix, captainName);
            logger.info(`✅ استلام: ${resolvedCaptainForSheet} +${quantity} [${groupPrefix}]`);
          } catch (error) {
            logger.error('❌ فشل استلام', { error: error.message });
          }
        } else {
          logger.warn('⚠️ لم يُعثر على الكابتن!', { msgId: quotedMsgId?.substring(0, 8) });
        }

        // تسجيل في سجل الحركات
        sheets.recordTransaction({
          transactionId: result.transactionId,
          timestamp: result.timestamp,
          producerPhone: finalProducerPhone,
          captainPhone: resolvedCaptainForSheet || '',
          quantity,
          type: 'انتاج',
          emoji: result.text,
          groupPrefix,
          messageId: quotedMsgId || '',
          status: 'نشط',
          notes: 'reaction'
        }).catch(() => {});

        const orderDetail = buildOrderDetail({
          result,
          msg,
          quotedMsgId,
          groupPrefix,
          producerPhone: finalProducerPhone,
          captainPhone: resolvedCaptainForSheet || '',
          reactorPhone: producerPhone,
        });
        sheets.upsertOrderDetails(orderDetail).catch(() => {});
        if (orderDetail.status === 'يحتاج مراجعة') {
          sheets.upsertOperationReview({
            reviewId: `REVIEW_${result.transactionId}`,
            timestamp: result.timestamp,
            groupPrefix,
            alertType: 'تطابق المنتج والكابتن',
            referenceId: quotedMsgId || result.messageId || '',
            reason: orderDetail.notes || 'رقم المنتج والكابتن متطابقان',
            notes: 'لا يتم تعديل أي رصيد عند اختيار نعم أو لا',
          }).catch(() => {});
        }

      } else if (result.type === 'cancel') {
        // === إلغاء ❌ ===
        // القواعد:
        // 1. الجميع يمكنهم وضع ❌ خلال 24 ساعة
        // 2. المشرف يمكنه وضع ❌ خلال أسبوع كامل (168 ساعة)
        // 3. لا يُحذف السجل — يُحدّث نفس الصف فقط
        // 4. لا يُنشأ سجل جديد

        const cancellerPhone = producerPhone; // واضع ❌

        // البحث عن العملية الأصلية
        if (!quotedMsgId) {
          logger.warn('⛔ إلغاء بدون معرف رسالة');
          return;
        }

        const existingTx = await sheets.findTransactionByMessageId(quotedMsgId, null);
        if (!existingTx) {
          const cancellerName = sheets.getRegisteredName(cancellerPhone) || whatsapp.getPushName(msg) || 'غير معروف';
          await sheets.logEdit({
            editorPhone: cancellerPhone,
            editorName: cancellerName,
            producerPhone: result.orderOwnerPhone || '',
            captainPhone: result.quotedPhone || '',
            oldQuantity: 0,
            newQuantity: 0,
            notes: `إلغاء بلا عملية أصلية — لا تأثير على الرصيد | group:${groupPrefix} | targetMsg:${quotedMsgId} | reactionEvent:${result.messageId}`,
          });
          logger.info('📝 تم توثيق إلغاء بلا عملية أصلية', { msgId: quotedMsgId?.substring(0, 8), reactionId: result.messageId?.substring(0, 8) });
          return;
        }

        // التحقق من الصلاحية والوقت
        const txTime = new Date(existingTx.timestamp);
        const now = new Date();
        const diffHours = (now - txTime) / (1000 * 60 * 60);
        const isSuperCancel = await sheets.isSupervisor(cancellerPhone);
        const maxCancelHours = isSuperCancel ? 168 : 24; // مشرف = أسبوع، غيره = 24 ساعة

        if (diffHours > maxCancelHours) {
          const label = isSuperCancel ? 'أسبوع' : '24 ساعة';
          logger.info(`⛔ رفض إلغاء: انتهت المهلة (${label})`, { hours: diffHours.toFixed(1) });
          return;
        }

        const cancelQuantity = existingTx.quantity;
        const cancelProducer = existingTx.producerPhone;
        const cancelCaptain = existingTx.captainPhone;

        logger.info('❌ إلغاء عملية', {
          canceller: cancellerPhone,
          isSuper: isSuperCancel,
          producer: cancelProducer,
          captain: cancelCaptain || '❓',
          qty: cancelQuantity,
          group: groupInfo ? groupInfo.name : 'Unknown'
        });

        // خصم الإنتاج (تصفير)
        try {
          const producerName = sheets.getRegisteredName(cancelProducer) || '';
          await sheets.updateTotalsProduction(cancelProducer, -cancelQuantity, groupPrefix, producerName);
        } catch (error) {
          logger.error('فشل خصم انتاج', { error: error.message });
        }

        // خصم الاستلام (تصفير)
        if (cancelCaptain) {
          try {
            const cancelCaptainName = sheets.getRegisteredName(cancelCaptain) || 'كابتن';
            await sheets.updateTotalsReception(cancelCaptain, -cancelQuantity, groupPrefix, cancelCaptainName);
          } catch (error) {
            logger.error('فشل خصم استلام', { error: error.message });
          }
        }

        // تحديث نفس الصف في سجل الحركات (لا إنشاء سجل جديد)
        // نصفّر الكمية في عمود E ونحفظ الكمية الأصلية في الملاحظات
        await sheets.updateTransactionStatus(existingTx.rowIndex, {
          status: 'ملغى',
          quantity: 0,  // تصفير الكمية في عمود E
          notes: `إلغاء بواسطة ${cancellerPhone} في ${now.toISOString()} | الكمية الأصلية: ${cancelQuantity} | msgId:${quotedMsgId}`
        });

        // تسجيل في Audit Log
        await sheets.logEdit({
          editorPhone: cancellerPhone,
          editorName: isSuperCancel ? 'مشرف' : 'كابتن',
          producerPhone: cancelProducer,
          captainPhone: cancelCaptain,
          oldQuantity: cancelQuantity,
          newQuantity: 0,
        });

      } else if (result.type === 'remove') {
        // === إزالة إيموجي ===
        // حالتان:
        // أ) إزالة إيموجي كمي (👍/2️⃣/3️⃣) = عكس العملية (حذف)
        // ب) إزالة ❌ = استرجاع العملية الملغاة (مشرف فقط + 24 ساعة)

        if (!quotedMsgId) {
          logger.info('🗑️ حذف إيموجي بدون معرف رسالة — تجاهل');
          return;
        }

        // البحث عن العملية (بما فيها الملغاة)
        const existingTx = await sheets.findTransactionByMessageIdIncludingCancelled(quotedMsgId, null);
        if (!existingTx) {
          logger.info('🗑️ حذف إيموجي — لا توجد عملية مسجلة', { msgId: quotedMsgId?.substring(0, 8) });
          return;
        }

        const isCancelled = existingTx.transactionId?.startsWith('CANCELLED_') || 
                             existingTx.notes?.includes('ملغى');
        if (isCancelled) {
          // === حالة ب: استرجاع عملية ملغاة (إزالة ❌) ===
          // الجميع 24 ساعة، المشرف أسبوع كامل
          const restorerPhone = producerPhone;

          const txTime = new Date(existingTx.timestamp);
          const now = new Date();
          const diffHours = (now - txTime) / (1000 * 60 * 60);
          const isSuperRestore = await sheets.isSupervisor(restorerPhone);
          const maxRestoreHours = isSuperRestore ? 168 : 24;

          if (diffHours > maxRestoreHours) {
            const label = isSuperRestore ? 'أسبوع' : '24 ساعة';
            logger.info(`⛔ رفض استرجاع: انتهت المهلة (${label})`, { hours: diffHours.toFixed(1) });
            return;
          }

          // استخراج الكمية الأصلية من الملاحظات
          const notesMatch = existingTx.notes?.match(/الكمية الأصلية:\s*(\d+)/);
          const originalQuantity = notesMatch ? parseInt(notesMatch[1]) : existingTx.quantity;

          const restoreProducer = existingTx.producerPhone;
          const restoreCaptain = existingTx.captainPhone;

          logger.info('🔄 استرجاع عملية ملغاة', {
            restorer: restorerPhone,
            isSuper: isSuperRestore,
            producer: restoreProducer,
            captain: restoreCaptain || '❓',
            qty: originalQuantity
          });

          // إعادة الإنتاج
          try {
            const producerName = sheets.getRegisteredName(restoreProducer) || '';
            await sheets.updateTotalsProduction(restoreProducer, originalQuantity, groupPrefix, producerName);
          } catch (error) {
            logger.error('فشل استرجاع انتاج', { error: error.message });
          }

          // إعادة الاستلام
          if (restoreCaptain) {
            try {
              const captainName = sheets.getRegisteredName(restoreCaptain) || 'كابتن';
              await sheets.updateTotalsReception(restoreCaptain, originalQuantity, groupPrefix, captainName);
            } catch (error) {
              logger.error('فشل استرجاع استلام', { error: error.message });
            }
          }

          // تحديث نفس الصف (إعادة الحالة إلى نشط)
          await sheets.updateTransactionStatus(existingTx.rowIndex, {
            quantity: originalQuantity,
            status: 'نشط',
            notes: `استرجاع بواسطة ${restorerPhone} في ${new Date().toISOString()} | msgId:${quotedMsgId}`
          });

          // تسجيل في Audit Log
          await sheets.logEdit({
            editorPhone: restorerPhone,
            editorName: isSuperRestore ? 'مشرف' : 'كابتن',
            producerPhone: restoreProducer,
            captainPhone: restoreCaptain,
            oldQuantity: 0,
            newQuantity: originalQuantity,
          });

        } else {
          // === حالة أ: حذف إيموجي كمي عادي (عكس العملية) ===
          // الجميع 24 ساعة، المشرف أسبوع كامل
          const removeQuantity = existingTx.quantity || 0;
          const removeProducer = existingTx.producerPhone || realProducerPhone || producerPhone;
          const removeCaptain = existingTx.captainPhone || captainPhone;

          if (removeQuantity <= 0) {
            logger.info('🗑️ حذف إيموجي — كمية صفر، تجاهل');
            return;
          }

          // التحقق من الوقت
          const removeTxTime = new Date(existingTx.timestamp);
          const removeNow = new Date();
          const removeDiffHours = (removeNow - removeTxTime) / (1000 * 60 * 60);
          const isSuperRemove = await sheets.isSupervisor(producerPhone);
          const maxRemoveHours = isSuperRemove ? 168 : 24;

          if (removeDiffHours > maxRemoveHours) {
            const label = isSuperRemove ? 'أسبوع' : '24 ساعة';
            logger.info(`⛔ رفض حذف إيموجي: انتهت المهلة (${label})`, { hours: removeDiffHours.toFixed(1) });
            return;
          }

          logger.info('🗑️ تنفيذ حذف إيموجي (عكس عملية)', {
            producer: removeProducer,
            captain: removeCaptain || '❓',
            qty: removeQuantity,
            group: groupInfo ? groupInfo.name : 'Unknown'
          });

          // خصم الانتاج
          try {
            const producerName = sheets.getRegisteredName(removeProducer) || '';
            await sheets.updateTotalsProduction(removeProducer, -removeQuantity, groupPrefix, producerName);
          } catch (error) {
            logger.error('❌ فشل خصم انتاج', { error: error.message });
          }

          // خصم الاستلام
          if (removeCaptain) {
            try {
              const captainName = sheets.getRegisteredName(removeCaptain) || 'كابتن';
              await sheets.updateTotalsReception(removeCaptain, -removeQuantity, groupPrefix, captainName);
            } catch (error) {
              logger.error('❌ فشل خصم استلام', { error: error.message });
            }
          }

          // تحديث حالة العملية في نفس الصف (تصفير الكمية)
          await sheets.updateTransactionStatus(existingTx.rowIndex, {
            status: 'محذوف',
            quantity: 0,  // تصفير الكمية في عمود E
            notes: `حذف إيموجي بواسطة ${producerPhone} في ${new Date().toISOString()} | الكمية الأصلية: ${removeQuantity} | msgId:${quotedMsgId}`
          });
          // تسجيل في ورقة سجل التعديلات — من حذف + الكمية المحذوفة
          try {
            const deleterName = sheets.getRegisteredName(producerPhone) || producerPhone;
            // البحث عن الإيموجي الجديد إذا كان هذا تغيير إيموجي وليس حذف مباشر
            const _replaceKey = `${producerPhone}_${quotedMsgId}`;
            const _pendingReplace = pendingEmojiReplace.get(_replaceKey);
            const _deleteNotes = _pendingReplace
              ? `تغيير إيموجي: ${result.reactionText || '?'} → ${_pendingReplace.emoji}`
              : `حذف إيموجي مباشر`;
            if (_pendingReplace) pendingEmojiReplace.delete(_replaceKey);
            await sheets.logEdit({
              editorPhone: producerPhone,
              editorName: deleterName,
              producerPhone: removeProducer,
              captainPhone: removeCaptain || '',
              oldQuantity: removeQuantity,
              newQuantity: 0,
              notes: _deleteNotes,
            });
            logger.info('📝 تم تسجيل الحذف في سجل التعديلات', {
              deleter: producerPhone,
              producer: removeProducer,
              captain: removeCaptain || '—',
              qty: removeQuantity,
            });
          } catch (logErr) {
            logger.error('فشل تسجيل حذف الإيموجي في سجل التعديلات', { error: logErr.message });
          }
        }
      }

      return;
    }

    // ====================================================
    // حالة 2: أوامر المشرف (كشف تفصيلي)
    // ====================================================
    const rawText = whatsapp.extractText(msg) || '';
    const trimmedText = rawText.trim();

    // أمر الكشف: "كشف 962797210303" أو "كشف 962797210303 01/08 06/08"
    const reportMatch = trimmedText.match(/^كشف\s+(\d{9,15})(?:\s+(\d{1,2}\/\d{1,2})\s+(\d{1,2}\/\d{1,2}))?$/i);
    if (reportMatch) {
      const senderJid = whatsapp.getSenderJid(msg);
      const senderPhone = parser.cleanPhone(senderJid) || senderJid.split('@')[0].replace(/\D/g, '');

      // فقط المشرف يمكنه طلب الكشف
      const isSuper = await sheets.isSupervisor(senderPhone);
      if (isSuper) {
        const targetPhone = reportMatch[1];
        const remoteJid = msg.key.remoteJid;
        const targetGroups = config.whatsapp.targetGroups || [];
        const groupInfo = targetGroups.find(g => g.id === remoteJid);
        const groupPrefix = groupInfo ? groupInfo.prefix : '';

        // تحديد الفترة (إذا حددها المشرف)
        let fromDate = null;
        let toDate = null;
        if (reportMatch[2] && reportMatch[3]) {
          const year = new Date().getFullYear();
          const [fd, fm] = reportMatch[2].split('/');
          const [td, tm] = reportMatch[3].split('/');
          fromDate = new Date(`${year}-${fm.padStart(2,'0')}-${fd.padStart(2,'0')}T00:00:00Z`);
          toDate = new Date(`${year}-${tm.padStart(2,'0')}-${td.padStart(2,'0')}T23:59:59Z`);
        }

        logger.info('📋 طلب كشف تفصيلي', { supervisor: senderPhone, target: targetPhone, group: groupPrefix });

        try {
          const reportResult = await sheets.getDetailedReport(targetPhone, groupPrefix, fromDate, toDate);
          
          // إرسال الكشف رسالة خاصة للمشرف
          const supervisorJid = senderJid.includes('@') ? senderJid : `${senderPhone}@s.whatsapp.net`;
          await sock.sendMessage(supervisorJid, { text: reportResult.report });
          logger.info('✅ تم إرسال الكشف التفصيلي خاص', { to: senderPhone });
        } catch (error) {
          logger.error('فشل إرسال الكشف', { error: error.message });
        }
        return; // بصمت - لا رد في الجروب
      }
    }

    // ====================================================
    // حالة 2.5: أمر النقطة — مزامنة LID سرية (للمشرف فقط)
    // ====================================================
    if (trimmedText === '.') {
      const senderJid = whatsapp.getSenderJid(msg);
      const senderPhone = parser.cleanPhone(senderJid) || (senderJid || '').split('@')[0].replace(/\D/g, '');
      const isSuper = await sheets.isSupervisor(senderPhone);
      
      if (isSuper) {
        const remoteJid = msg.key.remoteJid;
        logger.info('🔄 أمر مزامنة LID من المشرف', { phone: senderPhone });
        
        try {
          const syncResult = await whatsapp.syncGroupLids(remoteJid);
          logger.info(`✅ مزامنة كاملة: ${syncResult.newLinks} ربط جديد من إجمالي ${syncResult.total}`);
        } catch (err) {
          logger.warn('فشل أمر المزامنة', { error: err.message });
        }
        return; // بصمت تام — لا رد في الجروب
      }
    }

    // ====================================================
    // حالة 3: رسالة نصية (تم / رد)
    // ====================================================
    const result = await parser.processMessage(msg, sock);
    if (!result) return;

    if (result.type === 'accept') {
      let captainPhone = result.phone;
      const tamMessageId = result.messageId;
      // إذا كان captainPhone هو LID غير محلول، نحاول حله الآن
      if (captainPhone && captainPhone.includes('@lid')) {
        // محاولة 1: من lidToPhoneMap
        const resolvedCaptain = whatsapp.resolveLid(captainPhone);
        if (resolvedCaptain && !resolvedCaptain.includes('@lid')) {
          logger.info(`✅ حل LID الكابتن عند تم (lidMap): ${captainPhone.substring(0,15)} → ${resolvedCaptain}`);
          captainPhone = resolvedCaptain;
        } else {
          // محاولة 2: من pushName الرسالة الحالية (الكابتن يكتب "تم" الآن)
          const captainPushName = msg.pushName;
          if (captainPushName && captainPushName !== 'غير معروف') {
            const resolvedByName = whatsapp.resolvePhoneByPushName(captainPushName);
            if (resolvedByName && !resolvedByName.includes('@lid')) {
              logger.info(`✅ حل LID الكابتن عند تم (pushName): ${captainPushName} → ${resolvedByName}`);
              whatsapp.addLidMapping(captainPhone, resolvedByName);
              captainPhone = resolvedByName;
            } else {
              // محاولة 3: resolveLidDirect عبر USyncQuery
              const directResolvedTam = await whatsapp.resolveLidDirect(captainPhone);
              if (directResolvedTam && !directResolvedTam.includes('@lid')) {
                logger.info(`✅ حل LID الكابتن عند تم (USyncQuery): ${captainPhone.substring(0,15)} → ${directResolvedTam}`);
                captainPhone = directResolvedTam;
              } else {
                logger.warn(`⚠️ كابتن LID غير محلول — سيُحفظ بالـ LID مؤقتاً`, { lid: captainPhone.substring(0,15), pushName: captainPushName });
              }
            }
          } else {
            // محاولة 3 (بدون pushName): resolveLidDirect عبر USyncQuery
            const directResolvedTam = await whatsapp.resolveLidDirect(captainPhone);
            if (directResolvedTam && !directResolvedTam.includes('@lid')) {
              logger.info(`✅ حل LID الكابتن عند تم (USyncQuery/noPushName): ${captainPhone.substring(0,15)} → ${directResolvedTam}`);
              captainPhone = directResolvedTam;
            } else {
              logger.warn(`⚠️ كابتن LID بدون pushName`, { lid: captainPhone.substring(0,15) });
            }
          }
        }
      }

      if (captainPhone && tamMessageId) {
        whatsapp.setCaptainForMessage(tamMessageId, captainPhone);
        sheets.saveTamToSheet(tamMessageId, captainPhone).catch(() => {});
        
        // حفظ رقم صاحب الطلب مربوطاً بـ id رسالة الرد
        // حتى يعرف النظام من هو صاحب الطلب عند وضع إيموجي على رسالة الكابتن
        if (result.orderOwnerPhone) {
          // حل LID صاحب الطلب قبل الحفظ في orderCache
          let resolvedOwner = result.orderOwnerPhone;
          if (resolvedOwner && resolvedOwner.includes('@lid')) {
            const fromMap = whatsapp.resolveLid(resolvedOwner);
            if (fromMap && !fromMap.includes('@lid')) {
              resolvedOwner = fromMap.split('@')[0].replace(/\D/g, '');
              logger.info(`✅ حل LID صاحب الطلب عند حفظ تم (lidMap): ${result.orderOwnerPhone.substring(0,15)} → ${resolvedOwner}`);
            } else {
              // محاولة من ورقة المسجلين
              const fromSheet = sheets.resolvePhoneFromRegistered(resolvedOwner);
              if (fromSheet && !fromSheet.includes('@lid')) {
                resolvedOwner = fromSheet.split('@')[0].replace(/\D/g, '');
                logger.info(`✅ حل LID صاحب الطلب عند حفظ تم (Registered): ${result.orderOwnerPhone.substring(0,15)} → ${resolvedOwner}`);
              } else {
                // محاولة USyncQuery
                try {
                  const directResolved = await whatsapp.resolveLidDirect(resolvedOwner);
                  if (directResolved && !directResolved.includes('@lid')) {
                    resolvedOwner = directResolved.split('@')[0].replace(/\D/g, '');
                    logger.info(`✅ حل LID صاحب الطلب عند حفظ تم (USyncQuery): ${result.orderOwnerPhone.substring(0,15)} → ${resolvedOwner}`);
                  } else {
                    // استخدام الجزء الرقمي كمعرف مؤقت
                    resolvedOwner = resolvedOwner.split(':')[0].replace(/\D/g, '');
                    logger.warn(`⚠️ LID صاحب الطلب لم يُحل — سيُحفظ كمعرف مؤقت: ${resolvedOwner}`);
                    whatsapp.queueLidForResolve(result.orderOwnerPhone);
                  }
                } catch (e) {
                  resolvedOwner = resolvedOwner.split(':')[0].replace(/\D/g, '');
                  logger.warn(`⚠️ فشل حل LID صاحب الطلب: ${e.message}`);
                }
              }
            }
          }
          const originalOrderMessage = result.quotedMessageId
            ? whatsapp.getCachedMessage(result.quotedMessageId)
            : null;
          whatsapp.setOrderForReply(tamMessageId, resolvedOwner, {
            orderMessageId: result.quotedMessageId || '',
            orderText: whatsapp.extractText(originalOrderMessage) || result.quotedText || '',
            tamText: whatsapp.extractText(msg) || '',
          });
        }
        
        logger.info('💾 حفظ "تم"', { 
          captain: captainPhone, 
          producer: result.orderOwnerPhone || '?',
          msgId: (tamMessageId || '').substring(0, 8) 
        });

        // ====================================================
        // رد كمي (6️⃣ وما فوق) على رسالة "تم"
        // ====================================================
        // المنطق:
        // - من أرسل 6️⃣ = result.phone = صاحب الطلب (المنتج)
        // - صاحب رسالة "تم" = الكابتن (محفوظ في tamCache)
        //
        // إذا لم يتحدَّد الكابتن وصاحب الطلب بشكل موثوق:
        //   → لا تُسجَّل بأدوار خاطئة
        //   → تُحفظ في سجل الحركات بحالة "⏳ معلّق" للمراجعة اليدوية
        // ====================================================
        if (result.quantity > 0) {
          const targetGroups = config.whatsapp.targetGroups || [];
          const groupInfo = targetGroups.find(g => g.id === result.groupId);
          const groupPrefix = groupInfo ? groupInfo.prefix : '';
          const quotedMsgIdKmi = result.quotedMessageId;

          // الخطوة 1: تحديد الكابتن من tamCache (المصدر الموثوق)
          let realCaptain = null;
          let realProducer = null;
          let rolesConfirmed = false;

          if (quotedMsgIdKmi) {
            const captainFromCache = whatsapp.getCaptainByMessageId(quotedMsgIdKmi);
            const producerFromCache = whatsapp.getOrderByReplyId(quotedMsgIdKmi);
            if (captainFromCache) {
              realCaptain = captainFromCache;
              // صاحب الطلب: من orderCache أو من أرسل 6️⃣
              realProducer = producerFromCache || result.phone;
              rolesConfirmed = true;
              logger.info('✅ أدوار الرد الكمي من tamCache', {
                captain: realCaptain,
                producer: realProducer,
                qty: result.quantity
              });
            }
          }

          // الخطوة 2: إذا لم يُعثر في tamCache — نحاول من result مباشرة
          if (!rolesConfirmed) {
            // result.orderOwnerPhone = صاحب رسالة "تم" = الكابتن
            // result.phone = من أرسل 6️⃣ = صاحب الطلب
            if (result.orderOwnerPhone && result.phone && result.orderOwnerPhone !== result.phone) {
              realCaptain = result.orderOwnerPhone;
              realProducer = result.phone;
              rolesConfirmed = true;
              logger.info('✅ أدوار الرد الكمي من result مباشرة', {
                captain: realCaptain,
                producer: realProducer,
                qty: result.quantity
              });
            }
          }

          // حل LID وتنظيف الأرقام
          if (realCaptain && typeof realCaptain === 'string' && realCaptain.includes('@lid')) {
            const resolved = whatsapp.resolveLid(realCaptain);
            if (resolved && !resolved.includes('@lid')) realCaptain = resolved.split('@')[0].replace(/\D/g, '');
            else realCaptain = realCaptain.split(':')[0].replace(/\D/g, '');
          }
          if (realProducer && typeof realProducer === 'string' && realProducer.includes('@lid')) {
            const resolved = whatsapp.resolveLid(realProducer);
            if (resolved && !resolved.includes('@lid')) realProducer = resolved.split('@')[0].replace(/\D/g, '');
            else realProducer = realProducer.split(':')[0].replace(/\D/g, '');
          }
          if (realCaptain && typeof realCaptain === 'string' && realCaptain.includes('@')) realCaptain = realCaptain.split('@')[0].replace(/\D/g, '');
          if (realProducer && typeof realProducer === 'string' && realProducer.includes('@')) realProducer = realProducer.split('@')[0].replace(/\D/g, '');

          // الخطوة 3: التسجيل أو الحفظ معلّقاً
          if (rolesConfirmed && realCaptain && realProducer && realCaptain !== realProducer) {
            // ✅ الأدوار صحيحة — سجّل مباشرة
            try {
              const captainRegName = sheets.getRegisteredName(realCaptain) || 'كابتن';
              const producerRegName = sheets.getRegisteredName(realProducer) || 'منتج';
              await sheets.updateTotalsProduction(realProducer, result.quantity, groupPrefix, producerRegName);
              await sheets.updateTotalsReception(realCaptain, result.quantity, groupPrefix, captainRegName);
              sheets.recordTransaction({
                transactionId: result.transactionId,
                timestamp: result.timestamp,
                producerPhone: realProducer,
                captainPhone: realCaptain,
                quantity: result.quantity,
                type: 'استلام (رد كمي)',
                emoji: result.text || '⌨️',
                groupPrefix: groupPrefix,
                messageId: tamMessageId || '',
                status: 'نشط',
                notes: 'reply-quantity'
              }).catch(() => {});
              logger.info(`✅ رد كمي مُسجَّل: منتج=${realProducer} +${result.quantity} | كابتن=${realCaptain} [${groupPrefix}]`);
            } catch (error) {
              logger.error('فشل تسجيل رد كمي', { error: error.message });
            }
          } else {
            // ⏳ الأدوار غير مؤكدة — احفظ معلّقاً لا تضيّع العملية
            const pendingInfo = {
              rawPhone: result.phone || '',
              rawOrderOwner: result.orderOwnerPhone || '',
              quotedMsgId: quotedMsgIdKmi || '',
              captainFromMsg: captainPhone || '',
              reason: !rolesConfirmed ? 'لم يُعثر على tamCache' : (realCaptain === realProducer ? 'الكابتن = المنتج' : 'بيانات ناقصة')
            };
            logger.warn('⏳ رد كمي معلّق — حُفظ للمراجعة', {
              qty: result.quantity,
              group: groupPrefix,
              ...pendingInfo
            });
            sheets.recordTransaction({
              transactionId: result.transactionId,
              timestamp: result.timestamp,
              producerPhone: pendingInfo.rawOrderOwner || pendingInfo.rawPhone || '?',
              captainPhone: pendingInfo.captainFromMsg || '?',
              quantity: result.quantity,
              type: 'رد كمي (معلّق)',
              emoji: result.text || '⌨️',
              groupPrefix: groupPrefix,
              messageId: tamMessageId || '',
              status: '⏳ معلّق',
              notes: `يحتاج مراجعة | ${pendingInfo.reason} | quotedMsg=${pendingInfo.quotedMsgId.substring(0,8)}`
            }).catch(() => {});
          }
        }
      }
    }
    // أي شيء آخر (order) → نتجاهله — لا نسجل الطلبات
  });

  // 3. ربط QR
  whatsapp.onQRUpdate(setCurrentQR, clearCurrentQR);

  // 4. الاتصال بواتساب (بدون await لمنع تعليق السيرفر)
  whatsapp.connect().then(() => {
    logger.info('جاري الاتصال بواتساب...');
  }).catch((error) => {
    logger.error('❌ فشل الاتصال الأولي', { error: error.message });
  });

  // 4b. قناة تنفيذ أحادية الاستخدام: تقرأ طلباً محلياً من الـVolume ثم تحذفه بعد الإرسال.
  // لا يوجد مسار HTTP عام ولا يمكنها إعادة الإرسال بعد إنشاء إيصال .sent.
  oneTimeBroadcast = createOneTimeBroadcastProcessor({
    volumePath: config.volumePath,
    targetGroupId: config.whatsapp.targetGroups.find(group => group.prefix === 'السيف').id,
    getSocket: whatsapp.getSocket,
    isConnected: whatsapp.isConnected,
    logger,
  });
  let oneTimeBroadcastInProgress = false;
  setInterval(async () => {
    if (oneTimeBroadcastInProgress) return;
    oneTimeBroadcastInProgress = true;
    try {
      await oneTimeBroadcast.processPendingRequest();
    } finally {
      oneTimeBroadcastInProgress = false;
    }
  }, 2000);

  // 5. تحديث الإعدادات دورياً
  setInterval(async () => {
    try {
      await sheets.loadSettings();
    } catch (error) {
      logger.debug('فشل تحديث الإعدادات');
    }
  }, config.general.settingsRefreshInterval);

  // 6b. تحديث ورقة الرئيسية كل 30 دقيقة
  setInterval(async () => {
    sheets.createDashboardSheet().catch(e => logger.debug('فشل تحديث الرئيسية', { error: e.message }));
  }, 30 * 60 * 1000);

  // 6c. مطابقة الأوراق اليومية كل ساعة (تصحيح أي فروق بسبب إعادة التشغيل أو التعديلات)
  setInterval(async () => {
    try {
      const result = await sheets.reconcileDailySheets();
      if (result.success) {
        logger.info('🔄 مطابقة يومية تلقائية', { results: result.results });
      }
    } catch (e) {
      logger.debug('فشل المطابقة اليومية', { error: e.message });
    }
  }, 60 * 60 * 1000); // كل ساعة
  // 6d. قراءة قرارات المراجعة اليدوية كل دقيقة — لا تغيّر الأرصدة
  let reviewSyncInProgress = false;
  setInterval(async () => {
    if (reviewSyncInProgress) return;
    reviewSyncInProgress = true;
    try {
      const result = await sheets.syncOperationReviewResponses();
      if (result.updated) logger.info('🔎 تمت مزامنة إجابات المراجعات', { updated: result.updated });
    } catch (e) {
      logger.debug('فشل مزامنة إجابات المراجعات', { error: e.message });
    } finally {
      reviewSyncInProgress = false;
    }
  }, 60 * 1000);
  // 6. التحقق من الإغلاق الأسبوعي (الجمعة 11:00 مساءً) عند تفعيله صراحةً فقط.
  if (config.sheets.weeklyReport?.enabled === true) {
    setInterval(async () => {
      const now = new Date();
      // توقيت الأردن GMT+3
      const jordanTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));

      // الجمعة = 5
      // نتحقق من الدقيقة الصفر لضمان التشغيل مرة واحدة فقط في تلك الساعة
      if (jordanTime.getUTCDay() === 5 &&
          jordanTime.getUTCHours() === 23 &&
          jordanTime.getUTCMinutes() === 0) {
        logger.info('🕒 موعد الإغلاق الأسبوعي - توليد التقرير...');
        await sheets.generateWeeklyReport();
      }
    }, 60000); // كل دقيقة
  } else {
    logger.info('📊 تقرير نهاية الأسبوع موقوف مؤقتاً بطلب الإدارة');
  }

  logger.info('✅ النظام جاهز. في انتظار الرسائل...');
}

// === معالجة الأخطاء ===
process.on('uncaughtException', (error) => {
  logger.error('خطأ غير متوقع', { error: error.message });
});
process.on('unhandledRejection', (reason) => {
  logger.error('وعد مرفوض', { reason: String(reason) });
});

start().catch((error) => {
  logger.error('فشل التشغيل', { error: error.message });
  process.exit(1);
});
