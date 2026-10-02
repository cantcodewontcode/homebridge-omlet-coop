// What happens when a door's registration changes or it leaves the account.
//
// Since polling moved to /api/v1/group, identity is settled during discovery rather
// than by a 404 on a per-device poll: a door that is gone is simply absent from the
// list, and a reset one reappears under a new device ID with the same serial.
//
// deviceSerial is the wifi MAC - confirmed against a DHCP reservation that survived a
// real reset - so it identifies the same physical door exactly.

const { test } = require('node:test');
const assert = require('node:assert');
const { setup, door } = require('./harness');

const TOKENS = '/storage/omlet-coop-tokens.json';
const MINUTE = 60 * 1000;

function world(devices, config = {}) {
  const w = setup({
    config,
    files: { [TOKENS]: JSON.stringify({ bearerToken: 'goodtoken', deviceId: 'dev1' }) }
  });
  devices.forEach(d => w.cloud.addDevice(d));
  return w;
}

function withSerial(deviceId, name, serial) {
  const d = door(deviceId, name);
  d.deviceSerial = serial;
  return d;
}

test('the serial is recorded on the accessory', async () => {
  const w = world([withSerial('dev1', 'Front', 'aa11bb22cc33')]);

  await w.start();
  await w.clock.advance(MINUTE);

  assert.equal(w.accessory().context.deviceSerial, 'aa11bb22cc33');
  assert.equal(w.accessory().context.deviceId, 'dev1');
  w.restore();
});

test('a reset door is re-identified by serial on the next poll', async () => {
  const w = world([withSerial('dev1', 'Front', 'aa11bb22cc33')]);

  await w.start();
  await w.clock.advance(MINUTE);
  const uuid = w.accessory().UUID;

  // The reset: same hardware, new registration.
  w.cloud.devices.delete('dev1');
  w.cloud.addDevice(withSerial('dev9', 'Front', 'aa11bb22cc33'));
  await w.clock.advance(2 * MINUTE);

  assert.equal(w.platform.accessories.length, 1, 'still one accessory');
  assert.equal(w.accessory().UUID, uuid, 'the same one - rooms and automations survive');
  assert.equal(w.accessory().context.deviceId, 'dev9', 'now pointed at the new registration');
  assert.ok(w.platform.handlers.get('dev9'), 'and polled under the new id');
  w.restore();
});

test('replacement hardware gets its own accessory, never the old one', async () => {
  const w = world([withSerial('dev1', 'Front', 'aa11bb22cc33')], { removeAfterHours: 0 });

  await w.start();
  await w.clock.advance(MINUTE);

  // A genuinely new unit: new registration, new MAC.
  w.cloud.devices.delete('dev1');
  w.cloud.addDevice(withSerial('dev9', 'Replacement', '998877665544'));
  await w.clock.advance(2 * MINUTE);

  const serials = w.platform.accessories.map(a => a.context.deviceSerial).sort();
  assert.deepEqual(serials, ['998877665544', 'aa11bb22cc33'],
    'the old accessory is not silently repointed at different hardware');
  w.restore();
});

test('a door that leaves the account is reported once, then removed', async () => {
  const w = world([withSerial('dev1', 'Front', 'aa11bb22cc33'),
                   withSerial('dev2', 'Back', 'bb22cc33dd44')], { removeAfterHours: 1 });

  await w.start();
  await w.clock.advance(MINUTE);
  w.cloud.devices.delete('dev2');
  w.logs.length = 0;

  await w.clock.advance(50 * MINUTE);
  assert.equal(w.said('is no longer on your account').length, 1,
    'said once, not on every poll');
  assert.equal(w.api.unregistered.length, 0, 'and not removed during the grace period');

  await w.clock.advance(20 * MINUTE);
  assert.equal(w.api.unregistered.length, 1, 'removed once the window passes');
  assert.ok(w.said('from HomeKit: not seen for').length, 'and says why');
  w.restore();
});

test('removal can be turned off entirely', async () => {
  const w = world([withSerial('dev1', 'Front', 'aa11bb22cc33'),
                   withSerial('dev2', 'Back', 'bb22cc33dd44')], { removeAfterHours: 0 });

  await w.start();
  await w.clock.advance(MINUTE);
  w.cloud.devices.delete('dev2');
  await w.clock.advance(48 * 60 * MINUTE);

  assert.equal(w.api.unregistered.length, 0, 'kept indefinitely when the window is 0');
  assert.equal(w.platform.accessories.length, 2);
  w.restore();
});

test('an empty account never removes anything', async () => {
  const w = world([withSerial('dev1', 'Front', 'aa11bb22cc33')], { removeAfterHours: 1 });

  await w.start();
  await w.clock.advance(MINUTE);
  w.cloud.devices.clear();
  await w.clock.advance(5 * 60 * MINUTE);

  assert.equal(w.api.unregistered.length, 0,
    'an empty list is indistinguishable from an Omlet glitch, so it is never grounds for removal');
  w.restore();
});
