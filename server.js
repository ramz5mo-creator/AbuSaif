const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { google } = require('googleapis');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// إعدادات الشيت والمعرفات
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '15gDbpqB0e8WxG8S9QqCeUPg8WLZPPYuKSF1mHplp0';

// تهيئة اتصال Google Sheets باستخدام حساب الخدمة من متغير البيئة
function getGoogleSheetsClient() {
    try {
        const credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
        if (!credentialsJson) {
            console.log("⚠️ تحذير: Google Sheets غير متاحة (لم يُعثر على GOOGLE_SERVICE_ACCOUNT_JSON)");
            return null;
        }
        const credentials = JSON.parse(credentialsJson);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        return google.sheets({ version: 'v4', auth });
    } catch (error) {
        console.error("❌ خطأ في تهيئة حساب الخدمة لجوجل شيت:", error.message);
        return null;
    }
}

// دالة جلب اسم المندوب يدوياً من ورقة Members في الشيت
async function getDriverNameFromMembers(identifier) {
    try {
        const sheets = getGoogleSheetsClient();
        if (!sheets) return identifier; // إذا لم يتصل الشيت، يعيد المعرف نفسه

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Members!A:B', // العمود الأول: رقم/LID، العمود الثاني: الاسم
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) return identifier;

        for (const row of rows) {
            if (row[0] && row[0].toString().trim() === identifier.toString().trim()) {
                return row[1] || identifier; // إرجاع الاسم المسجل يدوياً
            }
        }
        return identifier; // إذا لم يوجد، يعيد المعرف الأصلي مؤقتاً
    } catch (error) {
        console.log("⚠️ ملاحظة أثناء البحث عن الاسم في Members:", error.message);
        return identifier;
    }
}

let sock;
let qrCodeData = '';
let connectionStatus = 'disconnected';

async function connectToWhatsApp() {
    const authFolder = path.join(__dirname, 'auth');
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
    });

    sock.usereCreds = saveCreds;

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrCodeData = qr;
            connectionStatus = 'qr';
            console.log('📌 QR Code جديد جاهز للمسح.');
        }
        if (connection === 'open') {
            connectionStatus = 'connected';
            console.log('✅ Your service is live 🚀 - البوت متصل بواتساب بنجاح!');
        } else if (connection === 'close') {
            connectionStatus = 'disconnected';
            console.log('🔄 انقطع الاتصال، جاري إعادة المحاولة...');
            setTimeout(connectToWhatsApp, 5000);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // مراقبة التفاعلات (Emojis) وتخطي قيود الـ LID عبر جلب الاسم من الشيت
    sock.ev.on('messages.reaction', async (reactions) => {
        try {
            for (const reaction of reactions) {
                if (!reaction.text) continue; // إذا تم إزالة التفاعل
                
                const senderIdentifier = reaction.author || reaction.sender || 'مندوب مجهول';
                const cleanIdentifier = senderIdentifier.split('@')[0];
                
                // جلب الاسم الحقيقي يدوياً من ورقة Members
                const driverName = await getDriverNameFromMembers(cleanIdentifier);
                
                console.log(`📥 تفاعل جديد من: ${driverName} (${cleanIdentifier}) | الإيموجي: ${reaction.text}`);
                
                // هنا يتم تسجيل التفاعل في جدول تفاصيل الطلبات مباشرة دون توقف
                const sheets = getGoogleSheetsClient();
                if (sheets) {
                    await sheets.spreadsheets.values.append({
                        spreadsheetId: SPREADSHEET_ID,
                        range: 'تفاصيل الطلبات!A:D',
                        valueInputOption: 'USER_ENTERED',
                        requestBody: {
                            values: [[new Date().toISOString(), driverName, reaction.text, 'تم التسجيل بنجاح']]
                        }
                    });
                }
            }
        } catch (err) {
            console.error('❌ خطأ أثناء معالجة التفاعل:', err.message);
        }
    });
}

// مسار فحص حالة البوت وعرض الـ QR
app.get('/', (req, res) => {
    if (connectionStatus === 'connected') {
        res.send(`<html><body style="background:#111;color:#fff;text-align:center;padding-top:50px;">
            <h1 style="color:#0f0;">✅ البوت متصل بواتساب</h1>
            <p>نظام التسجيل: مُفعّل (بدون قيود على الكميات وباعتماد الأسماء اليدوية)</p>
        </body></html>`);
    } else {
        res.send(`<html><body style="background:#111;color:#fff;text-align:center;padding-top:50px;">
            <h1>⏳ جاري الاتصال أو بانتظار مسح QR...</h1>
            <p>حالة الاتصال الحالي: ${connectionStatus}</p>
        </body></html>`);
    }
});

// بدء تشغيل الخير
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`خادم يعمل على البورت ${PORT}`);
    connectToWhatsApp();
});
