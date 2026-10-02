// Multi-door: the specification, written before the code.
//
// Every test here is marked `todo`, so it runs, reports as outstanding, and does not
// fail the suite or CI. Drop the `{ todo: ... }` as each phase lands - a todo that
// starts passing is reported too, which is the signal that a phase is done.
//
// These exist because none of this is testable on the hardware we own: one door. The
// cases that make multi-door dangerous - two doors swapped at once, a replacement
// landing on the wrong accessory - can only be reached here.
//
// Phases referenced below are docs/ROADMAP.md, "Port plan / Order of work".

const { test } = require('node:test');
const assert = require('node:assert');
const { setup, door, hap } = require('./harness');

const TOKENS = '/storage/omlet-coop-tokens.json';
const MINUTE = 60 * 1000;

function feeder(deviceId, name) {
  const device = door(deviceId, name);
  device.deviceType = 'Feeder';
  delete device.state.door;
  delete device.state.light;
  device.state.feeder = { state: 'closed', fault: 'none', feedLevel: 80, lightLevel: 40, mode: 'time' };
  return device;
}

function account(devices, stored = {}, config = {}) {
  const w = setup({
    config,
    files: { [TOKENS]: JSON.stringify(Object.assign({ bearerToken: 'goodtoken' }, stored)) }
  });
  devices.forEach(d => w.cloud.addDevice(d));
  return w;
}

// ---------- phase 4: discovery

test('two doors on one account become two accessories', async () => {
  const w = account([door('dev1', 'Front coop'), door('dev2', 'Back coop')], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);

  assert.equal(w.accessories().length, 2, 'one accessory per door');
  const names = w.accessories().map(a => a.displayName).sort();
  assert.deepEqual(names, ['Back coop', 'Front coop'], 'named from the Omlet app, not hardcoded');
  w.restore();
});

test('one account-wide poll feeds every door', async () => {
  const w = account([door('dev1', 'Front'), door('dev2', 'Back')], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);

  assert.ok(w.platform.handlers.get('dev1').cachedStatus, 'dev1 has status');
  assert.ok(w.platform.handlers.get('dev2').cachedStatus, 'dev2 has status');
  assert.equal(w.cloud.requests.filter(r => r.path.includes('/device/')).length, 0,
    'no per-device polling - /api/v1/group returns them all');
  w.restore();
});

test('a feeder on the account is not published as a garage door', async () => {
  const w = account([door('dev1'), feeder('feed1', 'Feeder')], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);

  const doors = w.accessories().filter(a => a.getService(hap.Service.GarageDoorOpener));
  assert.equal(doors.length, 1, 'only the Autodoor gets a garage door service');
  w.restore();
});

test('a single-door user keeps their existing accessory and UUID', async () => {
  const w = account([door('dev1', 'Teresa\'s autodoor')], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);
  const before = w.accessory().UUID;

  // A second door appears later. The first must not be re-keyed or recreated.
  w.cloud.addDevice(door('dev2', 'New coop'));
  await w.clock.advance(70 * MINUTE);

  const kept = w.accessories().find(a => a.context.deviceId === 'dev1');
  assert.ok(kept, 'original accessory still present');
  assert.equal(kept.UUID, before, 'same UUID - rooms and automations survive');
  w.restore();
});

// ---------- phase 4: commands

test('a command reaches the door it was sent to', async () => {
  const w = account([door('dev1', 'Front', { door: 'closed' }),
                     door('dev2', 'Back', { door: 'closed' })], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);

  const back = w.accessories().find(a => a.displayName === 'Back');
  const target = back.getService(hap.Service.GarageDoorOpener)
    .getCharacteristic(hap.Characteristic.TargetDoorState);
  await target.write(hap.Characteristic.TargetDoorState.OPEN);
  await w.clock.advance(1000);

  const opened = w.cloud.requests.filter(r => r.method === 'POST' && r.path.includes('open'));
  assert.equal(opened.length, 1, 'exactly one door opened');
  assert.ok(opened[0].path.includes('dev2'), 'and it was the back one');
  w.restore();
});

// ---------- phase 2: lifecycle

test('a door removed from the account loses its accessory', async () => {
  const w = account([door('dev1'), door('dev2')], { deviceId: 'dev1' }, { removeAfterHours: 1 });

  await w.start();
  await w.clock.advance(MINUTE);
  w.cloud.devices.delete('dev2');

  // The first poll after it vanishes starts the clock; it is not removed yet.
  await w.clock.advance(50 * MINUTE);
  assert.equal(w.api.unregistered.length, 0, 'given a grace period, not removed at once');
  assert.ok(w.said('is no longer on your account').length, 'and says so');

  await w.clock.advance(20 * MINUTE);
  assert.equal(w.api.unregistered.length, 1, 'removed once the window passes');
  assert.equal(w.accessories().length, 1);
  w.restore();
});

test('a door that comes back is not removed', async () => {
  const w = account([door('dev1'), door('dev2')], { deviceId: 'dev1' }, { removeAfterHours: 1 });

  await w.start();
  await w.clock.advance(MINUTE);
  const gone = w.cloud.devices.get('dev2');
  w.cloud.devices.delete('dev2');
  await w.clock.advance(30 * MINUTE);

  w.cloud.addDevice(gone);
  await w.clock.advance(130 * MINUTE);

  assert.equal(w.api.unregistered.length, 0, 'the clock resets when it reappears');
  assert.equal(w.accessories().length, 2);
  w.restore();
});

test('a torn-down door stops polling', async () => {
  const w = account([door('dev1'), door('dev2')], { deviceId: 'dev1' }, { removeAfterHours: 1 });

  await w.start();
  await w.clock.advance(MINUTE);
  w.cloud.devices.delete('dev2');
  await w.clock.advance(130 * MINUTE);

  assert.equal(w.platform.handlers.get('dev2'), undefined, 'handler gone');
  assert.equal(w.platform.accessories.length, 1, 'and its accessory with it');
  w.restore();
});

test('restart restores accessories from cache without duplicating them', async () => {
  const w = account([door('dev1'), door('dev2')], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);
  const uuids = w.accessories().map(a => a.UUID).sort();

  // A real restart: nothing in memory, then Homebridge hands back the cached
  // accessories one at a time, then discovery runs.
  const cached = w.platform.accessories.slice();
  w.platform.handlers.forEach(handler => handler.destroy());
  w.platform.handlers.clear();
  w.platform.accessories = [];
  cached.forEach(a => w.platform.configureAccessory(a));

  await w.platform.discoverDevices();
  await w.clock.advance(MINUTE);

  assert.deepEqual(w.accessories().map(a => a.UUID).sort(), uuids, 'same accessories, no extras');
  w.restore();
});

// ---------- phase 5: replacement

test('one door reset: identified by serial, the other untouched', async () => {
  const a = door('dev1', 'Front'); a.deviceSerial = 'aaaaaaaaaaaa';
  const b = door('dev2', 'Back');  b.deviceSerial = 'bbbbbbbbbbbb';
  const w = account([a, b], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);

  w.cloud.devices.delete('dev1');
  const reborn = door('dev9', 'Front'); reborn.deviceSerial = 'aaaaaaaaaaaa';
  w.cloud.addDevice(reborn);
  await w.clock.advance(5 * MINUTE);

  const front = w.accessories().find(x => x.context.deviceSerial === 'aaaaaaaaaaaa');
  assert.equal(front.context.deviceId, 'dev9', 'front door re-pointed at its new registration');
  const back = w.accessories().find(x => x.context.deviceSerial === 'bbbbbbbbbbbb');
  assert.equal(back.context.deviceId, 'dev2', 'back door untouched');
  w.restore();
});

test('two doors swapped at once: no guessing', async () => {
  const a = door('dev1', 'Front'); a.deviceSerial = 'aaaaaaaaaaaa';
  const b = door('dev2', 'Back');  b.deviceSerial = 'bbbbbbbbbbbb';
  const w = account([a, b], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);

  // Both replaced with new hardware - no serial matches either accessory.
  w.cloud.devices.clear();
  const x = door('dev8', 'Front'); x.deviceSerial = 'cccccccccccc';
  const y = door('dev9', 'Back');  y.deviceSerial = 'dddddddddddd';
  w.cloud.addDevice(x); w.cloud.addDevice(y);
  await w.clock.advance(5 * MINUTE);

  // New hardware does get accessories - that is correct. What must not happen is the
  // existing two being silently repointed at doors they have never met.
  const bySerial = {};
  w.accessories().forEach(z => { bySerial[z.context.deviceSerial] = z.context.deviceId; });

  assert.equal(bySerial['aaaaaaaaaaaa'], 'dev1', 'the original front door is untouched');
  assert.equal(bySerial['bbbbbbbbbbbb'], 'dev2', 'and so is the back one');
  assert.equal(bySerial['cccccccccccc'], 'dev8', 'the new hardware is its own accessory');
  assert.equal(bySerial['dddddddddddd'], 'dev9');
  w.restore();
});

test('an old device ID returning is not treated as a new door', async () => {
  const a = door('dev1', 'Front'); a.deviceSerial = 'aaaaaaaaaaaa';
  const w = account([a], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);
  const uuid = w.accessory().UUID;

  w.cloud.devices.delete('dev1');
  const reborn = door('dev9', 'Front'); reborn.deviceSerial = 'aaaaaaaaaaaa';
  w.cloud.addDevice(reborn);
  await w.clock.advance(5 * MINUTE);

  // The original registration comes back - same hardware, two registrations.
  w.cloud.addDevice(a);
  await w.clock.advance(70 * MINUTE);

  const mine = w.accessories().filter(z => z.context.deviceSerial === 'aaaaaaaaaaaa');
  assert.equal(mine.length, 1, 'one accessory for one piece of hardware');
  assert.equal(mine[0].UUID, uuid, 'and it is the original');
  w.restore();
});

// ---------- phase 6: per-device settings and exclusion

test('a disabled device is not published', async () => {
  const w = account([door('dev1', 'Front'), door('dev2', 'Back')], { deviceId: 'dev1' },
    { devices: [{ deviceId: 'dev2', enabled: false }] });

  await w.start();
  await w.clock.advance(MINUTE);

  assert.equal(w.accessories().length, 1);
  assert.equal(w.accessories()[0].displayName, 'Front');
  w.restore();
});

test('disabling a device unregisters it, rather than leaving a stale tile', async () => {
  const w = account([door('dev1', 'Front'), door('dev2', 'Back')], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);
  assert.equal(w.accessories().length, 2);

  // What editing the settings and restarting the bridge does.
  w.platform.deviceOverrides = w.platform.indexDeviceOverrides([{ deviceId: 'dev2', enabled: false }]);
  await w.clock.advance(MINUTE);

  assert.equal(w.accessories().length, 1, 'gone from HomeKit, not merely unpolled');
  assert.equal(w.platform.handlers.has('dev2'), false, 'and no handler left running');
  w.restore();
});

test('a disabled device is not reported as missing', async () => {
  const w = account([door('dev1', 'Front'), door('dev2', 'Back')], { deviceId: 'dev1' },
    { removeAfterHours: 1, devices: [{ deviceId: 'dev2', enabled: false }] });

  await w.start();
  await w.clock.advance(MINUTE);

  assert.equal(w.said(/no longer on your account/).length, 0,
    'it has not gone anywhere - the user asked for it to go');
  w.restore();
});

test('the disabled notice is not repeated on every poll', async () => {
  const w = account([door('dev1', 'Front'), door('dev2', 'Back')], { deviceId: 'dev1' },
    { devices: [{ deviceId: 'dev2', enabled: false }] });

  await w.start();
  await w.clock.advance(10 * MINUTE);

  assert.ok(w.said(/disabled in the plugin settings/).length <= 1,
    'discovery runs every poll; the removal must not');
  w.restore();
});

test('a device is matched on serial, so it stays disabled across a factory reset', async () => {
  const a = door('dev1', 'Front');
  const b = door('dev2', 'Back');
  b.deviceSerial = 'bbbbbbbbbbbb';
  const w = account([a, b], { deviceId: 'dev1' },
    { devices: [{ serial: 'BB:BB:BB:BB:BB:BB', enabled: false }] });

  await w.start();
  await w.clock.advance(MINUTE);

  assert.equal(w.accessories().length, 1, 'separators and case are not part of a MAC');
  assert.equal(w.accessories()[0].displayName, 'Front');
  w.restore();
});

test('per-device settings beat the plugin-level ones', async () => {
  const w = account([door('dev1', 'Front', { lightLevel: 50 }), door('dev2', 'Back', { lightLevel: 50 })],
    { deviceId: 'dev1' },
    { enableLightSensor: true, devices: [{ deviceId: 'dev2', enableLightSensor: false }] });

  await w.start();
  await w.clock.advance(MINUTE);

  const byName = {};
  w.accessories().forEach(a => { byName[a.displayName] = a; });

  assert.ok(byName.Front.getService(hap.Service.LightSensor), 'plugin-level setting applies');
  assert.equal(byName.Back.getService(hap.Service.LightSensor), undefined, 'per-device override wins');
  w.restore();
});

test('a plugin-level setting still applies to a device with no entry of its own', async () => {
  const w = account([door('dev1', 'Front'), door('dev2', 'Back')], { deviceId: 'dev1' },
    { enableLight: 'off', devices: [{ deviceId: 'dev2', enabled: true }] });

  await w.start();
  await w.clock.advance(MINUTE);

  w.accessories().forEach((accessory) => {
    assert.equal(accessory.getService(hap.Service.Lightbulb), undefined,
      `${accessory.displayName} keeps the upgrading user's choice`);
  });
  w.restore();
});

// ---------- phase 6: enablement on upgrade

test('upgrading a single-door install does not fill HomeKit unasked', async () => {
  const w = account([door('dev1', 'Front'), door('dev2', 'Back')], { deviceId: 'dev1' });

  // One accessory in the cache, with no serial: what a pre-0.9.10 install restarts
  // with.
  w.cache('dev1', 'Front');
  await w.start();
  await w.clock.advance(MINUTE);

  assert.equal(w.accessories().length, 1, 'only the door that was already set up');
  assert.equal(w.accessories()[0].displayName, 'Front');
  assert.ok(w.said(/start disabled/).length, 'and the user is told where to enable the rest');
  w.restore();
});

test('a fresh install publishes every door it finds', async () => {
  const w = account([door('dev1', 'Front'), door('dev2', 'Back')], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);

  assert.equal(w.accessories().length, 2, 'nothing to protect, so nothing is held back');
  w.restore();
});

test('a door added later arrives enabled', async () => {
  const w = account([door('dev1', 'Front')], { deviceId: 'dev1' });

  w.cache('dev1', 'Front');
  await w.start();
  await w.clock.advance(MINUTE);
  assert.equal(w.accessories().length, 1);

  // The upgrade rule is decided on the first discovery. A door that turns up
  // afterwards is new, and new doors are published.
  w.cloud.addDevice(door('dev2', 'Back'));
  await w.clock.advance(MINUTE);

  assert.equal(w.accessories().length, 2, 'picked up on the next poll, no restart needed');
  w.restore();
});

test('a door added later appears without a restart', async () => {
  const w = account([door('dev1', 'Front')], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);
  assert.equal(w.accessories().length, 1);

  w.cloud.addDevice(door('dev2', 'Back'));
  await w.clock.advance(MINUTE);

  assert.equal(w.accessories().length, 2, 'every poll is a discovery');
  w.restore();
});

test('a serial mismatch is never overridden by a matching device ID', async () => {
  const a = door('dev1', 'Front'); a.deviceSerial = 'aaaaaaaaaaaa';
  const w = account([a], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);
  assert.equal(w.accessory().context.deviceSerial, 'aaaaaaaaaaaa');

  // Same device ID, different hardware behind it. The UUID still matches, and must
  // not be allowed to win: a MAC cannot be reissued, so this is a different door.
  w.cloud.devices.get('dev1').deviceSerial = 'ffffffffffff';
  w.platform.handlers.forEach(h => h.destroy());
  w.platform.handlers.clear();
  await w.platform.discoverDevices();
  await w.clock.advance(MINUTE);

  const serials = w.accessories().map(x => x.context.deviceSerial).sort();
  assert.deepEqual(serials, ['aaaaaaaaaaaa', 'ffffffffffff'],
    'a second accessory, not the first one silently repointed');
  w.restore();
});
