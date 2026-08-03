/**
 * start-qr.js - تشغيل واتساب وحفظ QR كصورة
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const AUTH_PATH = './auth';
const QR_IMAGE_PATH = '/home/ubuntu/AbuSaif/qr-code.png';

async function start() {
  console.log('جاري الاتصال بواتساب...');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('تم إنشاء رمز QR - جاري حفظه كصورة...');
      await QRCode.toFile(QR_IMAGE_PATH, qr, {
        width: 400,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' }
      });
      console.log('QR_SAVED:' + QR_IMAGE_PATH);
    }

    if (connection === 'open') {
      console.log('CONNECTION_SUCCESS');
      
      // جلب قائمة الجروبات
      const groups = await sock.groupFetchAllParticipating();
      const groupList = Object.values(groups).map(g => ({
        id: g.id,
        name: g.subject,
        participants: g.participants?.length || 0
      }));

      console.log('\n═══════════════════════════════════════');
      console.log('   قائمة الجروبات المتاحة:');
      console.log('═══════════════════════════════════════');
      groupList.forEach((g, i) => {
        console.log(`${i + 1}. ${g.name} (${g.participants} عضو)`);
        console.log(`   المعرف: ${g.id}`);
      });
      console.log('═══════════════════════════════════════');
      
      // حفظ القائمة في ملف
      fs.writeFileSync('/home/ubuntu/AbuSaif/groups.json', JSON.stringify(groupList, null, 2));
      console.log('GROUPS_SAVED');
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log('انقطع الاتصال، جاري إعادة المحاولة...');
      } else {
        console.log('تم تسجيل الخروج');
      }
    }
  });
}

start().catch(console.error);
