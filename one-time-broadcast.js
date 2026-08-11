const fs = require('fs');
const path = require('path');

function createOneTimeBroadcastProcessor({ volumePath, targetGroupId, getSocket, isConnected, logger }) {
  const requestPath = path.join(volumePath, 'one-time-broadcast.json');
  const sendingPath = path.join(volumePath, 'one-time-broadcast.sending.json');
  const sentPath = path.join(volumePath, 'one-time-broadcast.sent.json');

  async function processPendingRequest() {
    if (fs.existsSync(sentPath)) return { status: 'already-sent' };
    if (fs.existsSync(sendingPath)) return { status: 'unknown-after-send-attempt' };
    if (!fs.existsSync(requestPath)) return { status: 'idle' };
    if (!isConnected()) return { status: 'waiting-for-connection' };

    fs.renameSync(requestPath, sendingPath);
    try {
      const request = JSON.parse(fs.readFileSync(sendingPath, 'utf8'));
      const text = typeof request.text === 'string' ? request.text.trim() : '';
      if (request.type !== 'dreamax-test-message' || !text) {
        throw new Error('طلب الإرسال لا يطابق الصيغة المعتمدة');
      }

      const sock = getSocket();
      if (!sock || typeof sock.sendMessage !== 'function') {
        throw new Error('اتصال واتساب غير جاهز للإرسال');
      }

      const result = await sock.sendMessage(targetGroupId, { text });
      const receipt = {
        type: request.type,
        sentAt: new Date().toISOString(),
        groupId: targetGroupId,
        messageId: result?.key?.id || '',
        textLength: text.length,
      };
      fs.writeFileSync(sentPath, JSON.stringify(receipt, null, 2));
      fs.unlinkSync(sendingPath);
      logger.info('📣 تم إرسال الرسالة التجريبية الأحادية إلى السيف', { messageId: receipt.messageId });
      return { status: 'sent', receipt };
    } catch (error) {
      logger.error('فشل إرسال الرسالة التجريبية الأحادية', { error: error.message });
      return { status: 'failed', error: error.message };
    }
  }

  return { processPendingRequest, paths: { requestPath, sendingPath, sentPath } };
}

module.exports = { createOneTimeBroadcastProcessor };
