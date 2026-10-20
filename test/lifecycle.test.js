// Accessory lifecycle. Polling is account-wide now - one /api/v1/group call serves
// every door - so a handler owns no timer. What has to work is that the platform can
// stop feeding one and take its accessory out of HomeKit.

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

  assert.equal(w.platform.handlers.size, 1);
  assert.ok(w.platform.handlers.get('dev1'), 'keyed by device id');
  w.restore();
});

test('one request serves the account, however many doors', async () => {
  const w = setup({ files: { [TOKENS]: JSON.stringify({ bearerToken: 'goodtoken', deviceId: 'dev1' }) } });
  ['dev1', 'dev2', 'dev3'].forEach((id, i) => w.cloud.addDevice(door(id, 'Door ' + i)));

  await w.start();
  const atStart = w.polls();
  await w.clock.advance(5 * MINUTE);

  assert.equal(w.platform.handlers.size, 3, 'three doors');
  const polls = w.polls() - atStart;
  assert.ok(polls >= 9 && polls <= 11, `~10 polls in five minutes, got ${polls}`);
  assert.equal(w.cloud.requests.filter(r => r.path.includes('/device/')).length, 0,
    'and not one per-device call');
  w.restore();
});

test('every door gets the status from the one call', async () => {
  const w = setup({ files: { [TOKENS]: JSON.stringify({ bearerToken: 'goodtoken', deviceId: 'dev1' }) } });
  w.cloud.addDevice(door('dev1', 'Front', { door: 'open' }));
  w.cloud.addDevice(door('dev2', 'Back', { door: 'closed' }));

  await w.start();
  await w.clock.advance(MINUTE);

  assert.equal(w.platform.handlers.get('dev1').cachedStatus.state.door.state, 'open');
  assert.equal(w.platform.handlers.get('dev2').cachedStatus.state.door.state, 'closed');
  w.restore();
});

test('removeHandler unregisters the accessory and stops feeding it', async () => {
  const w = await running();
  const handler = w.platform.handlers.get('dev1');

  const removed = w.platform.removeHandler('dev1', 'no longer on the account');

  assert.equal(removed, true);
  assert.equal(w.platform.handlers.size, 0, 'handler gone');
  assert.equal(w.api.unregistered.length, 1, 'accessory unregistered from HomeKit');
  assert.equal(w.platform.accessories.length, 0, 'and dropped from the platform list');
  assert.ok(w.said('from HomeKit: no longer on the account').length, 'says what it did and why');

  const at = handler.cachedStatus;
  await w.clock.advance(10 * MINUTE);
  assert.equal(handler.cachedStatus, at, 'a removed handler is no longer updated');
  w.restore();
});

test('removing a device that is not there is harmless', async () => {
  const w = await running();

  assert.equal(w.platform.removeHandler('nosuchdevice'), false);
  assert.equal(w.platform.handlers.size, 1, 'the real one is untouched');
  assert.equal(w.api.unregistered.length, 0);
  w.restore();
});

test('the account poll keeps running after a door is removed', async () => {
  const w = setup({ files: { [TOKENS]: JSON.stringify({ bearerToken: 'goodtoken', deviceId: 'dev1' }) } });
  w.cloud.addDevice(door('dev1', 'Front'));
  w.cloud.addDevice(door('dev2', 'Back'));

  await w.start();
  await w.clock.advance(MINUTE);
  w.platform.removeHandler('dev2', 'test');

  const before = w.polls();
  await w.clock.advance(5 * MINUTE);

  assert.ok(w.polls() > before, 'the remaining door is still being polled');
  w.restore();
});
