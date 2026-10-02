// Accessory lifecycle. No user-visible change - the point is that a handler can be
// stopped at all, which nothing could do before: the handler was constructed and
// dropped, kept alive only by its own poll timer.
//
// Single-device tests, because this phase lands before discovery can create more
// than one. The two-door cases are in multidoor.test.js, still todo.

const { test } = require('node:test');
const assert = require('node:assert');
const { setup, door } = require('./harness');

const TOKENS = '/storage/omlet-coop-tokens.json';
const MINUTE = 60 * 1000;

async function running() {
  const w = setup({ files: { [TOKENS]: JSON.stringify({ bearerToken: 'goodtoken', deviceId: 'dev1' }) } });
  w.cloud.addDevice(door('dev1', 'Teresa\'s autodoor'));
  await w.start();
  await w.clock.advance(MINUTE);
  return w;
}

test('a running device has a handler the platform can reach', async () => {
  const w = await running();

  assert.equal(w.platform.handlers.size, 1, 'one handler registered');
  assert.ok(w.platform.handlers.get('dev1'), 'keyed by device id');
  w.restore();
});

test('destroy stops the poll chain', async () => {
  const w = await running();
  const handler = w.platform.handlers.get('dev1');

  const before = w.cloud.requests.length;
  await w.clock.advance(2 * MINUTE);
  assert.ok(w.cloud.requests.length > before, 'polling while alive');

  handler.destroy();
  const atDeath = w.cloud.requests.length;
  await w.clock.advance(30 * MINUTE);

  assert.equal(w.cloud.requests.length, atDeath, 'no requests after destroy');
  assert.equal(w.clock.pending(), 0, 'and no timer left outstanding');
  w.restore();
});

test('a poll already in flight does not reschedule after destroy', async () => {
  const w = await running();
  const handler = w.platform.handlers.get('dev1');

  // Destroy mid-cycle: clearing the timer alone would not stop a poll that is
  // already running from scheduling its successor when it finishes.
  handler.destroy();
  await w.clock.settle();
  const atDeath = w.cloud.requests.length;
  await w.clock.advance(10 * MINUTE);

  assert.equal(w.cloud.requests.length, atDeath, 'the in-flight cycle did not respawn');
  w.restore();
});

test('removeHandler unregisters the accessory and stops it', async () => {
  const w = await running();

  const removed = w.platform.removeHandler('dev1', 'no longer on the account');

  assert.equal(removed, true);
  assert.equal(w.platform.handlers.size, 0, 'handler gone');
  assert.equal(w.api.unregistered.length, 1, 'accessory unregistered from HomeKit');
  assert.equal(w.platform.accessories.length, 0, 'and dropped from the platform list');
  // Not asserting the name: accessories are still created as "Omlet Coop" until
  // phase 4 names them from the device.
  assert.ok(w.said('from HomeKit: no longer on the account').length, 'says what it did and why');

  const atRemoval = w.cloud.requests.length;
  await w.clock.advance(30 * MINUTE);
  assert.equal(w.cloud.requests.length, atRemoval, 'nothing left polling a removed device');
  w.restore();
});

test('removing a device that is not there is harmless', async () => {
  const w = await running();

  assert.equal(w.platform.removeHandler('nosuchdevice'), false);
  assert.equal(w.platform.handlers.size, 1, 'the real one is untouched');
  assert.equal(w.api.unregistered.length, 0);
  w.restore();
});

test('a destroyed handler cannot be restarted by a stray schedule', async () => {
  const w = await running();
  const handler = w.platform.handlers.get('dev1');

  handler.destroy();
  handler.scheduleNextPoll(1000);

  assert.equal(w.clock.pending(), 0, 'scheduleNextPoll is a no-op once destroyed');
  w.restore();
});
