import test from 'node:test';
import assert from 'node:assert/strict';
import { Cdp, loopbackEndpoint } from '../src/cdp.mjs';

class Socket extends EventTarget {
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  reply(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { this.dispatchEvent(new Event('close')); }
}
test('CDP correlates concurrent replies and keeps flattened session events', async () => {
  const socket = new Socket(), cdp = new Cdp(socket);
  const first = cdp.send('Runtime.enable', {}, 'page-one');
  const second = cdp.send('Target.getTargets');
  socket.reply({ id: socket.sent[1].id, result: { targetInfos: [] } });
  socket.reply({ id: socket.sent[0].id, result: {} });
  assert.deepEqual(await second, { targetInfos: [] }); await first;
  assert.equal(socket.sent[0].sessionId, 'page-one');
  let observed;
  cdp.on('Runtime.bindingCalled', (event, session) => { observed = { event, session }; });
  socket.reply({ method: 'Runtime.bindingCalled', params: { payload: 'hello' }, sessionId: 'page-one' });
  assert.deepEqual(observed, { event: { payload: 'hello' }, session: 'page-one' });
});
test('CDP reports errors, bounded timeouts and pending work on disconnect', async () => {
  const socket = new Socket(), cdp = new Cdp(socket);
  const failed = cdp.send('bad');
  socket.reply({ id: socket.sent[0].id, error: { message: 'unsupported' } });
  await assert.rejects(failed, /unsupported/);
  await assert.rejects(cdp.send('slow', {}, undefined, 5), /timeout/);
  const disconnected = cdp.send('pending'); socket.close();
  await assert.rejects(disconnected, /closed/);
});
test('only loopback HTTP origins with an explicit port are accepted', () => {
  assert.equal(loopbackEndpoint('http://127.0.0.1:9222/'), 'http://127.0.0.1:9222');
  for (const value of ['https://127.0.0.1:9222', 'http://example.com:9222', 'http://localhost', 'http://u:p@localhost:9222', 'http://localhost:9222/proxy']) assert.throws(() => loopbackEndpoint(value));
});
