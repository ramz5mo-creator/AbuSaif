/**
 * server.js - نقطة تشغيل النظام v4
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
const QRCode = require('qrcode');
const config = require('./config');
const logger = require('./logger');
const whatsapp = require('./whatsapp');
const parser = require('./parser');
const sheets = require('./sheets');

// ====================================================
// خادم ويب لعرض QR + حالة البوت
// ====================================================
let currentQR = null;

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
          <a href="/weekly-report" style="color:#0f0;text-decoration:none;border:1px solid #0f0;padding:10px;border-radius:5px;margin-left:10px;">📊 تقرير نهاية الأسبوع</a>
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
  } else if (req.url === '/weekly-report') {
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

    function showGroups() {
      let html = '<p class="page-title">اختر جروباً لعرض بياناته</p>';
      html += '<div style="margin-bottom:20px;"><a class="back-btn" onclick="showLinkLid();return false;" href="#" style="background:rgba(102,126,234,0.15);border-color:rgba(102,126,234,0.4);">\uD83D\uDD17 ربط LID للأرقام</a></div>';
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
// بدء التشغيل
// ====================================================
async function start() {
  logger.info('═══════════════════════════════════════');
  logger.info('   🚀 نظام AbuSaif v4 — ورقة يومية');
  logger.info('═══════════════════════════════════════');

  // 1. تهيئة Google Sheets
  try {
    await sheets.initialize();
    logger.info('✅ Google Sheets متصل');
        await sheets.loadSettings();
    logger.info('✅ الإعدادات محمّلة');
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
      // ملاحظة: هذا ينطبق فقط عندما يضع شخص إيموجي على رسالته الأصلية
      // وليس عندما يضع شخص إيموجي على رسالة "تم" الخاصة برده على طلب شخص آخر
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
        captainPhone = captainFromTam;
        realProducerPhone = producerFromOrder || orderOwnerPhone;
        logger.info('📌 حالة 1: إيموجي على رسالة تم', {
          captain: captainPhone, producer: realProducerPhone, qty: quantity
        });
      } else {
        // الحالة 2: الإيموجي على رسالة الطلب مباشرة
        // واضع الإيموجي = الكابتن (producerPhone)
        // صاحب الرسالة = المنتج (orderOwnerPhone)
        captainPhone = producerPhone; // واضع الإيموجي هو الكابتن
        realProducerPhone = orderOwnerPhone; // صاحب الرسالة هو المنتج
        // فحص tamCache بطريقة بديلة (Sheet)
        const captainFromSheet = quotedMsgId ? await sheets.getCaptainFromTamSheet(quotedMsgId) : null;
        if (captainFromSheet) {
          captainPhone = captainFromSheet;
          realProducerPhone = producerFromOrder || orderOwnerPhone;
          logger.info('📌 حالة 1b: إيموجي على رسالة تم (من Sheet)', {
            captain: captainPhone, producer: realProducerPhone, qty: quantity
          });
        } else {
          logger.info('📌 حالة 2: إيموجي على رسالة طلب مباشرة', {
            captain: captainPhone, producer: realProducerPhone, qty: quantity
          });
        }
      }

      if (result.type === 'accept') {
        // === فحص هل هذا تعديل (إيموجي جديد على نفس الرسالة المسجلة سابقاً) ===
        const existingTransaction = await sheets.findTransactionByMessageId(quotedMsgId, realProducerPhone || producerPhone);
        
        if (existingTransaction && existingTransaction.quantity !== quantity) {
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

        // === انتاج + استلام (عملية جديدة) ===
        // صاحب الطلب = realProducerPhone (عابدين)
        // واضع الإيموجي = producerPhone (قد يكون عابدين أو شخص آخر)
        const finalProducerPhone = realProducerPhone || producerPhone;
        
        logger.info('🎯 تسجيل انتاج+استلام', {
          producer: finalProducerPhone,
          emojiBy: producerPhone,
          captain: captainPhone || '❓',
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

        if (captainPhone) {
          try {
            // الحصول على اسم الكابتن من ورقة المسجلين
            const captainName = sheets.getRegisteredName(captainPhone) || 'كابتن';
            await sheets.updateTotalsReception(captainPhone, quantity, groupPrefix, captainName);
            logger.info(`✅ استلام: ${captainPhone} +${quantity} [${groupPrefix}]`);
          } catch (error) {
            logger.error('❌ فشل استلام', { error: error.message });
          }
        } else {
          logger.warn('⚠️ لم يُعثر على الكابتن!', { msgId: quotedMsgId?.substring(0, 8) });
        }

        // تسجيل في سجل الحركات (مع حفظ msgId في الملاحظات للتعديل لاحقاً)
        sheets.recordTransaction({
          transactionId: result.transactionId,
          timestamp: result.timestamp,
          producerPhone: finalProducerPhone,
          captainPhone: captainPhone || '',
          quantity,
          type: 'انتاج',
          emoji: result.text,
          groupPrefix,
          status: 'نشط',
          notes: `msgId:${quotedMsgId || ''}`
        }).catch(() => {});

      } else if (result.type === 'cancel') {
        // === إلغاء ===
        // البحث عن العملية الأصلية لمعرفة الكمية الفعلية
        let cancelQuantity = quantity;
        let cancelCaptain = captainPhone;
        let cancelProducer = producerPhone;

        if (quotedMsgId) {
          try {
            const existingTx = await sheets.findTransactionByMessageId(quotedMsgId, producerPhone);
            if (existingTx) {
              cancelQuantity = existingTx.quantity || quantity;
              cancelCaptain = existingTx.captainPhone || captainPhone;
              cancelProducer = existingTx.producerPhone || producerPhone;
              logger.info('❌ إلغاء بناءً على عملية سابقة', { 
                originalQty: cancelQuantity, 
                producer: cancelProducer, 
                captain: cancelCaptain 
              });
            }
          } catch (e) {
            logger.debug('لم يتم العثور على عملية سابقة للإلغاء', { error: e.message });
          }
        }

        logger.info('❌ إلغاء', { 
          producer: cancelProducer, 
          captain: cancelCaptain || '❓',
          qty: cancelQuantity,
          group: groupInfo ? groupInfo.name : 'Unknown'
        });

        try {
          const producerName = whatsapp.getPushName(msg);
          await sheets.updateTotalsProduction(cancelProducer, -cancelQuantity, groupPrefix, producerName);
        } catch (error) {
          logger.error('فشل خصم انتاج', { error: error.message });
        }

        if (cancelCaptain) {
          try {
            const cancelCaptainName = sheets.getRegisteredName(cancelCaptain) || 'كابتن';
            await sheets.updateTotalsReception(cancelCaptain, -cancelQuantity, groupPrefix, cancelCaptainName);
          } catch (error) {
            logger.error('فشل خصم استلام', { error: error.message });
          }
        }

        sheets.recordTransaction({
          transactionId: result.transactionId,
          timestamp: result.timestamp,
          producerPhone: cancelProducer,
          captainPhone: cancelCaptain || '',
          quantity: cancelQuantity,
          type: 'إلغاء',
          emoji: '❌',
          groupPrefix,
          status: 'ملغى',
          notes: `msgId:${quotedMsgId || ''}`
        }).catch(() => {});

      } else if (result.type === 'remove') {
        // === حذف الإيموجي: عكس العملية تماماً ===
        // البحث عن العملية المسجلة لهذه الرسالة
        let removeQuantity = 0;
        let removeProducer = realProducerPhone || producerPhone;
        let removeCaptain = captainPhone;

        if (quotedMsgId) {
          try {
            const existingTx = await sheets.findTransactionByMessageId(quotedMsgId, removeProducer);
            if (existingTx && existingTx.status !== 'ملغى') {
              removeQuantity = existingTx.quantity || 0;
              removeCaptain = existingTx.captainPhone || captainPhone;
              removeProducer = existingTx.producerPhone || removeProducer;
              logger.info('🗑️ حذف إيموجي → عكس عملية', {
                originalQty: removeQuantity,
                producer: removeProducer,
                captain: removeCaptain,
                msgId: quotedMsgId?.substring(0, 8)
              });
            } else {
              logger.info('🗑️ حذف إيموجي — لا توجد عملية مسجلة أو ملغاة بالفعل', { msgId: quotedMsgId?.substring(0, 8) });
              return;
            }
          } catch (e) {
            logger.debug('فشل البحث عن عملية للحذف', { error: e.message });
            return;
          }
        } else {
          return; // لا يمكن عكس بدون معرف الرسالة
        }

        if (removeQuantity <= 0) {
          logger.info('🗑️ حذف إيموجي — كمية صفر، تجاهل');
          return;
        }

        logger.info('🗑️ تنفيذ حذف إيموجي', {
          producer: removeProducer,
          captain: removeCaptain || '❓',
          qty: removeQuantity,
          group: groupInfo ? groupInfo.name : 'Unknown'
        });

        // خصم الانتاج
        try {
          const producerName = sheets.getRegisteredName(removeProducer) || '';
          await sheets.updateTotalsProduction(removeProducer, -removeQuantity, groupPrefix, producerName);
          logger.info(`✅ خصم انتاج بعد حذف إيموجي: ${removeProducer} -${removeQuantity}`);
        } catch (error) {
          logger.error('❌ فشل خصم انتاج', { error: error.message });
        }

        // خصم الاستلام
        if (removeCaptain) {
          try {
            const captainName = sheets.getRegisteredName(removeCaptain) || 'كابتن';
            await sheets.updateTotalsReception(removeCaptain, -removeQuantity, groupPrefix, captainName);
            logger.info(`✅ خصم استلام بعد حذف إيموجي: ${removeCaptain} -${removeQuantity}`);
          } catch (error) {
            logger.error('❌ فشل خصم استلام', { error: error.message });
          }
        }

        // تحديث حالة العملية في سجل الحركات إلى محذوف
        sheets.recordTransaction({
          transactionId: result.transactionId,
          timestamp: result.timestamp,
          producerPhone: removeProducer,
          captainPhone: removeCaptain || '',
          quantity: removeQuantity,
          type: 'حذف إيموجي',
          emoji: '',
          groupPrefix,
          status: 'محذوف',
          notes: `msgId:${quotedMsgId || ''}`
        }).catch(() => {});
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
      const captainPhone = result.phone;
      const tamMessageId = result.messageId;

      if (captainPhone && tamMessageId) {
        whatsapp.setCaptainForMessage(tamMessageId, captainPhone);
        sheets.saveTamToSheet(tamMessageId, captainPhone).catch(() => {});
        
        // حفظ رقم صاحب الطلب مربوطاً بـ id رسالة الرد
        // حتى يعرف النظام من هو صاحب الطلب عند وضع إيموجي على رسالة الكابتن
        if (result.orderOwnerPhone) {
          whatsapp.setOrderForReply(tamMessageId, result.orderOwnerPhone);
        }
        
        logger.info('💾 حفظ "تم"', { 
          captain: captainPhone, 
          producer: result.orderOwnerPhone || '?',
          msgId: tamMessageId.substring(0, 8) 
        });

        // إذا كان الرد يحتوي على إيموجي كمي مباشرة (مثل رد بـ 👍)
        if (result.quantity > 0 && result.orderOwnerPhone) {
          const targetGroups = config.whatsapp.targetGroups || [];
          const groupInfo = targetGroups.find(g => g.id === result.groupId);
          const groupPrefix = groupInfo ? groupInfo.prefix : '';
          
          try {
            const ownerName = whatsapp.getPushName(msg); // pushName للمستلم (الراد)
            const captainRegName = sheets.getRegisteredName(captainPhone) || ownerName;
            const producerRegName = sheets.getRegisteredName(result.orderOwnerPhone) || 'منتج';
            await sheets.updateTotalsProduction(result.orderOwnerPhone, result.quantity, groupPrefix, producerRegName);
            await sheets.updateTotalsReception(captainPhone, result.quantity, groupPrefix, captainRegName);
            
            sheets.recordTransaction({
              transactionId: result.transactionId,
              timestamp: result.timestamp,
              producerPhone: result.orderOwnerPhone,
              captainPhone: captainPhone,
              quantity: result.quantity,
              type: 'استلام (رد)',
              emoji: '⌨️',
              groupPrefix: groupPrefix,
              status: 'نشط',
              notes: `msgId:${tamMessageId}`
            }).catch(() => {});
          } catch (error) {
            logger.error('فشل تسجيل رد كمي', { error: error.message });
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
  // 6. التحقق من الإغلاق الأسبوعي (الجمعة 11:00 مساءً)
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
