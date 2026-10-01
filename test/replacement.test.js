// What happens when the stored deviceId stops resolving - a coop factory reset,
// replaced, or removed from the account.
//
// deviceSerial is the wifi MAC (confirmed against DHCP reservations that survived a
// real reset), so it identifies the same physical door exactly. deviceId does not:
// a reset reissues it.

const { test } = require('node:test');
const assert = require('node:assert');
const { setup, door } = require('./harness');

const TOKENS = '/storage/omlet-coop-tokens.json';
const MINUTE = 60 * 1000;

function withDevice(deviceId) {
  return { files: { [TOKENS]: JSON.stringify({ bearerToken: 'goodtoken', deviceId }) } };
}

// Give the accessory a poll or two so the serial gets recorded, the way it would be
// in the field before anything went wrong.
async function running(serial = 'aa11bb22cc33') {
  const w = setup(withDevice('dev1'));
  const device = door('dev1', 'Teresa\'s autodoor');
  device.deviceSerial = serial;
  w.cloud.addDevice(device);

  await w.start();
  await w.clock.advance(MINUTE);

  assert.equal(w.accessory().context.deviceSerial, serial, 'serial recorded on first poll');
  return w;
}

test('the serial is recorded and survives into the accessory context', async () => {
  const w = await running();
  assert.equal(w.accessory().context.deviceId, 'dev1');
  assert.ok(w.api.updated.length, 'persisted, not just held in memory');
  w.restore();
});

test('a reset coop is identified by its serial, even with other doors present', async () => {
  const w = await running('aa11bb22cc33');

  // The reset: same hardware, new cloud registration. Two other doors on the account
  // to prove the match is exact rather than a lucky count of one.
  w.cloud.devices.delete('dev1');
  const reborn = door('dev9', 'Teresa\'s autodoor');
  reborn.deviceSerial = 'aa11bb22cc33';
  w.cloud.addDevice(reborn);
  w.cloud.addDevice(Object.assign(door('dev2', 'Other door'), { deviceSerial: 'ff00ff00ff00' }));
  w.cloud.addDevice(Object.assign(door('dev3', 'Third door'), { deviceSerial: 'ee00ee00ee00' }));

  await w.clock.advance(2 * MINUTE);

  assert.ok(w.said('hardware serial matches').length, 'adopted on the serial');
  assert.equal(w.platform.deviceId, 'dev9', 'now polling the new registration');
  assert.equal(w.api.registered.length, 1, 'same accessory - no new HomeKit tile');
  w.restore();
});

test('different hardware is refused, however few candidates there are', async () => {
  const w = await running('aa11bb22cc33');

  // A genuine replacement: new unit, new MAC. Exactly one candidate, so the old
  // count rule would have adopted it.
  w.cloud.devices.delete('dev1');
  w.cloud.addDevice(Object.assign(door('dev9', 'New door'), { deviceSerial: '998877665544' }));

  await w.clock.advance(2 * MINUTE);

  assert.equal(w.said('hardware serial matches').length, 0, 'must not adopt other hardware');
  assert.ok(w.said('no device on it has the same hardware serial').length, 'and says why');
  assert.notEqual(w.platform.deviceId, 'dev9');
  w.restore();
});

test('without a recorded serial it falls back to the single-candidate rule', async () => {
  // An accessory from before serials were recorded: the device never reports one.
  const w = setup(withDevice('dev1'));
  const device = door('dev1');
  delete device.deviceSerial;
  w.cloud.addDevice(device);

  await w.start();
  await w.clock.advance(MINUTE);
  assert.equal(w.accessory().context.deviceSerial, undefined, 'nothing to record');

  w.cloud.devices.delete('dev1');
  const replacement = door('dev9', 'Replacement');
  delete replacement.deviceSerial;
  w.cloud.addDevice(replacement);

  await w.clock.advance(2 * MINUTE);

  assert.ok(w.said('Now using').length, 'one unambiguous candidate is still adopted');
  assert.equal(w.platform.deviceId, 'dev9');
  w.restore();
});

test('without a serial AND with two candidates, it refuses rather than guesses', async () => {
  const w = setup(withDevice('dev1'));
  const device = door('dev1');
  delete device.deviceSerial;
  w.cloud.addDevice(device);

  await w.start();
  await w.clock.advance(MINUTE);

  w.cloud.devices.delete('dev1');
  ['dev8', 'dev9'].forEach((id) => {
    const d = door(id, 'Door ' + id);
    delete d.deviceSerial;
    w.cloud.addDevice(d);
  });

  await w.clock.advance(2 * MINUTE);

  assert.ok(w.said('More than one coop door').length, 'asks instead of picking');
  assert.ok(['dev8', 'dev9'].indexOf(w.platform.deviceId) === -1, 'adopted neither');
  w.restore();
});

test('an empty account is reported, and nothing is adopted', async () => {
  const w = await running();
  w.cloud.devices.clear();

  await w.clock.advance(2 * MINUTE);

  assert.ok(w.said('no longer on the account').length || w.said('no device on it has the same hardware serial').length,
    'tells the user the coop is gone');
  w.restore();
});

test('an unresolvable coop is explained once, not every poll', async () => {
  const w = await running('aa11bb22cc33');

  w.cloud.devices.delete('dev1');
  w.cloud.addDevice(Object.assign(door('dev8', 'Door eight'), { deviceSerial: '111111111111' }));
  w.cloud.addDevice(Object.assign(door('dev9', 'Door nine'), { deviceSerial: '222222222222' }));
  w.logs.length = 0;

  await w.clock.advance(10 * MINUTE);

  const explained = w.said('no device on it has the same hardware serial').length;
  assert.equal(explained, 1,
    `explained ${explained} times over ten minutes of polling - it must say it once`);

  const raw404 = w.said('HTTP Error 404').length;
  assert.equal(raw404, 0, 'the raw 404 is reported in context, not repeated per poll');
  w.restore();
});

test('a changed situation speaks up again', async () => {
  const w = await running('aa11bb22cc33');

  w.cloud.devices.delete('dev1');
  w.logs.length = 0;
  await w.clock.advance(3 * MINUTE);
  assert.equal(w.said('no device on it has the same hardware serial').length, 1);

  // The coop comes back under a new registration - same hardware.
  const reborn = door('dev9', 'Teresa\'s autodoor');
  reborn.deviceSerial = 'aa11bb22cc33';
  w.cloud.addDevice(reborn);
  await w.clock.advance(2 * MINUTE);

  assert.ok(w.said('hardware serial matches').length, 'recovers once the hardware reappears');
  w.restore();
});
