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

function account(devices, stored = {}) {
  const w = setup({
    files: { [TOKENS]: JSON.stringify(Object.assign({ bearerToken: 'goodtoken' }, stored)) }
  });
  devices.forEach(d => w.cloud.addDevice(d));
  return w;
}

// ---------- phase 4: discovery

test('two doors on one account become two accessories', { todo: 'phase 4' }, async () => {
  const w = account([door('dev1', 'Front coop'), door('dev2', 'Back coop')], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);

  assert.equal(w.accessories().length, 2, 'one accessory per door');
  const names = w.accessories().map(a => a.displayName).sort();
  assert.deepEqual(names, ['Back coop', 'Front coop'], 'named from the Omlet app, not hardcoded');
  w.restore();
});

test('each door keeps its own poll cycle, staggered', { todo: 'phase 4' }, async () => {
  const w = account([door('dev1'), door('dev2')], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);

  assert.ok(w.sentTo('dev1').length, 'dev1 polled');
  assert.ok(w.sentTo('dev2').length, 'dev2 polled');
  w.restore();
});

test('a feeder on the account is not published as a garage door', { todo: 'phase 4' }, async () => {
  const w = account([door('dev1'), feeder('feed1', 'Feeder')], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);

  const doors = w.accessories().filter(a => a.getService(hap.Service.GarageDoorOpener));
  assert.equal(doors.length, 1, 'only the Autodoor gets a garage door service');
  w.restore();
});

test('a single-door user keeps their existing accessory and UUID', { todo: 'phase 4' }, async () => {
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

test('a command reaches the door it was sent to', { todo: 'phase 4' }, async () => {
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

test('a door removed from the account loses its accessory', { todo: 'phase 2' }, async () => {
  const w = account([door('dev1'), door('dev2')], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);
  w.cloud.devices.delete('dev2');
  await w.clock.advance(70 * MINUTE);

  assert.equal(w.api.unregistered.length, 1, 'the departed door is unregistered');
  assert.equal(w.accessories().length, 1);
  w.restore();
});

test('a torn-down door stops polling', { todo: 'phase 2' }, async () => {
  const w = account([door('dev1'), door('dev2')], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);
  w.cloud.devices.delete('dev2');
  await w.clock.advance(70 * MINUTE);

  const before = w.sentTo('dev2').length;
  await w.clock.advance(10 * MINUTE);
  assert.equal(w.sentTo('dev2').length, before,
    'no orphaned timer still polling a device that is gone');
  w.restore();
});

test('restart restores accessories from cache without duplicating them', { todo: 'phase 2' }, async () => {
  const w = account([door('dev1'), door('dev2')], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);
  const uuids = w.accessories().map(a => a.UUID).sort();

  w.platform.accessories.forEach(a => w.platform.configureAccessory(a));
  await w.start();
  await w.clock.advance(MINUTE);

  assert.deepEqual(w.accessories().map(a => a.UUID).sort(), uuids, 'same accessories, no extras');
  w.restore();
});

// ---------- phase 5: replacement

test('one door reset: identified by serial, the other untouched', { todo: 'phase 5' }, async () => {
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

test('two doors swapped at once: no guessing', { todo: 'phase 5' }, async () => {
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

  const adopted = w.accessories().filter(z => ['dev8', 'dev9'].includes(z.context.deviceId));
  assert.equal(adopted.length, 0, 'neither accessory adopts unknown hardware');
  w.restore();
});

test('an old device ID returning is not treated as a new door', { todo: 'phase 5' }, async () => {
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

// ---------- phases 6 and 7

test('an excluded device is not published', { todo: 'phase 6' }, async () => {
  const w = setup({
    config: { excludeDevices: ['dev2'] },
    files: { [TOKENS]: JSON.stringify({ bearerToken: 'goodtoken', deviceId: 'dev1' }) }
  });
  w.cloud.addDevice(door('dev1', 'Front'));
  w.cloud.addDevice(door('dev2', 'Back'));

  await w.start();
  await w.clock.advance(MINUTE);

  assert.equal(w.accessories().length, 1);
  assert.equal(w.accessories()[0].displayName, 'Front');
  w.restore();
});

test('a door added later appears without a restart', { todo: 'phase 7' }, async () => {
  const w = account([door('dev1', 'Front')], { deviceId: 'dev1' });

  await w.start();
  await w.clock.advance(MINUTE);
  assert.equal(w.accessories().length, 1);

  w.cloud.addDevice(door('dev2', 'Back'));
  await w.clock.advance(70 * MINUTE);

  assert.equal(w.accessories().length, 2, 'picked up by periodic rediscovery');
  w.restore();
});
