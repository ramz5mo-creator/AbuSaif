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

      // === قاعدة: إذا وضع شخص إيموجي على رسالته هو نفسه → تجاهل ===
      if (orderOwnerPhone && producerPhone) {
        const cleanProducer = producerPhone.replace(/\D/g, '');
        const cleanOwner = orderOwnerPhone.replace(/\D/g, '');
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

      // الكابتن: من tamCache أو من بيانات الرسالة
      const captainPhone = await findCaptainPhone(
        quotedMsgId,
        orderOwnerPhone
      );
      
      // صاحب الطلب الحقيقي: من orderCache أولاً (الأدق)، ثم من بيانات الرسالة
      // عندما يضع شخص إيموجي على رسالة الكابتن التي رد فيها بـ"تم"
      const realProducerPhone = whatsapp.getOrderByReplyId(quotedMsgId) || orderOwnerPhone;

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
