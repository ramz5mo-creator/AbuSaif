import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOneTimeBroadcastProcessor } = require('./one-time-broadcast.js');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abusaif-broadcast-'));
let connected = false;
let sends = 0;
const processor = createOneTimeBroadcastProcessor({
  volumePath: tempDir,
  targetGroupId: '120363401940570759@g.us',
  isConnected: () => connected,
  getSocket: () => ({ sendMessage: async () => { sends += 1; return { key: { id: 'TEST_MESSAGE_ID' } }; } }),
  logger: { info() {}, error() {} },
});

fs.writeFileSync(processor.paths.requestPath, JSON.stringify({
  type: 'dreamax-test-message',
  text: 'رسالة اختبار',
}));

assert.equal((await processor.processPendingRequest()).status, 'waiting-for-connection');
assert.equal(sends, 0);
connected = true;
assert.equal((await processor.processPendingRequest()).status, 'sent');
assert.equal(sends, 1);
assert.equal((await processor.processPendingRequest()).status, 'already-sent');
assert.equal(sends, 1);
assert.equal(JSON.parse(fs.readFileSync(processor.paths.sentPath, 'utf8')).messageId, 'TEST_MESSAGE_ID');

fs.rmSync(tempDir, { recursive: true, force: true });
console.log('✅ One-time broadcast test passed');
