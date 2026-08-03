/**
 * qr-web.js - عرض QR في صفحة ويب مع تجديد تلقائي
 */
const http = require('http');
const QRCode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

let currentQR = '';
let status = 'waiting';
let groups = [];

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }) });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update) => {
    if (update.qr) {
      currentQR = await QRCode.toDataURL(update.qr, { width: 300, margin: 2 });
      status = 'qr_ready';
      console.log('QR جديد جاهز - افتح الصفحة لمسحه');
    }
    if (update.connection === 'open') {
      status = 'connected';
      console.log('CONNECTED_SUCCESS');
      const g = await sock.groupFetchAllParticipating();
      groups = Object.values(g).map(gr => ({ id: gr.id, name: gr.subject, participants: gr.participants?.length || 0 }));
      fs.writeFileSync('/home/ubuntu/AbuSaif/groups.json', JSON.stringify(groups, null, 2));
      groups.forEach((gr, i) => console.log((i+1) + '. ' + gr.name + ' | ' + gr.id));
    }
    if (update.connection === 'close') {
      status = 'disconnected';
      setTimeout(startWhatsApp, 3000);
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ status, groups }));
    return;
  }
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
  res.end(`<!DOCTYPE html>
<html dir="rtl">
<head><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR واتساب</title>
<style>body{font-family:Arial;text-align:center;padding:20px;background:#f0f0f0}
.qr{background:white;padding:20px;border-radius:10px;display:inline-block;margin:20px}
img{max-width:280px}h1{color:#25D366;font-size:1.5em}
.status{padding:10px;border-radius:5px;margin:10px;font-weight:bold}
.connected{background:#d4edda;color:#155724}
.waiting{background:#fff3cd;color:#856404}</style></head>
<body>
<h1>🔗 ربط واتساب</h1>
${status === 'connected' ? 
  '<div class="status connected">✅ متصل بنجاح!</div><p>تم الربط - يمكنك إغلاق هذه الصفحة</p>' :
  status === 'qr_ready' ? 
    '<p>امسح هذا الرمز من واتساب:</p><div class="qr"><img src="'+currentQR+'"/></div><p>واتساب → الإعدادات → الأجهزة المرتبطة → ربط جهاز</p><script>setTimeout(()=>location.reload(),20000)</script>' :
    '<div class="status waiting">⏳ جاري التحميل...</div><script>setTimeout(()=>location.reload(),3000)</script>'
}
</body></html>`);
});

server.listen(8080, '0.0.0.0', () => {
  console.log('صفحة QR جاهزة على المنفذ 8080');
});

startWhatsApp();
