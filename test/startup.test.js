// Fidelity tests: these assert behavior that 0.9.9 was verified to have on real
// hardware. They exist first to prove the harness drives the plugin faithfully,
// before anything new is trusted to it.

const { test } = require('node:test');
const assert = require('node:assert');
const { setup, door, hap } = require('./harness');

const TOKENS = '/storage/omlet-coop-tokens.json';

function stored(deviceId = 'dev1', token = 'goodtoken') {
  return { [TOKENS]: JSON.stringify({ bearerToken: token, deviceId, lastVersion: '0.9.9' }) };
}

test('starts from a stored token and polls', async () => {
  const w = setup({ files: stored() });
  w.cloud.addDevice(door('dev1'));

  await w.start();

  assert.ok(w.said('Using saved API key').length, 'should use the stored key');
  assert.ok(w.said('Polling every 30s').length, 'should start polling');
  assert.equal(w.api.registered.length, 1, 'one accessory registered');
  w.restore();
});

test('publishes a garage door, and a light when one is fitted', async () => {
  const w = setup({ files: stored() });
  w.cloud.addDevice(door('dev1'));

  await w.start();
  await w.clock.advance(1000);

  const accessory = w.accessory();
  assert.ok(accessory.getService(hap.Service.GarageDoorOpener), 'garage door service');
  assert.ok(accessory.getService(hap.Service.Lightbulb), 'light service');
  w.restore();
});

test('no battery service on a mains-powered door', async () => {
  const w = setup({ files: stored() });
  w.cloud.addDevice(door('dev1', 'Coop', { powerSource: 'external' }));

  await w.start();
  await w.clock.advance(1000);

  assert.equal(w.accessory().getService(hap.Service.Battery), undefined,
    'mains door must not show a battery');
  w.restore();
});

test('door state reaches HomeKit', async () => {
  const w = setup({ files: stored() });
  w.cloud.addDevice(door('dev1', 'Coop', { door: 'open' }));

  await w.start();
  await w.clock.advance(1000);

  const service = w.accessory().getService(hap.Service.GarageDoorOpener);
  assert.equal(service.value(hap.Characteristic.CurrentDoorState),
    hap.Characteristic.CurrentDoorState.OPEN);
  w.restore();
});

test('records the device ID on the accessory, and stays quiet about it', async () => {
  const w = setup({ files: stored() });
  w.cloud.addDevice(door('dev1'));

  await w.start();

  assert.equal(w.accessory().context.deviceId, 'dev1', 'device id recorded');
  assert.equal(w.said('Device ID changed').length, 0, 'must not claim a change on first run');
  w.restore();
});
