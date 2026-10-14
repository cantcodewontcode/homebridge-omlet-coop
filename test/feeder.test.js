// Feeders. Read-only by design: the Omlet app opens and closes a feeder on a
// schedule or a light threshold and offers no "open now", so neither do we.
//
// The shape here comes from a real /api/v1/group payload posted in #6, not from the
// SDK models - see docs/FEEDER-DESIGN.md. A feeder reports two percentages, its
// cells and its feed, and HomeKit shows one battery per accessory.

const { test } = require('node:test');
const assert = require('node:assert');
const { setup, door, hap } = require('./harness');

const TOKENS = '/storage/omlet-coop-tokens.json';
const MINUTE = 60 * 1000;

// Matches the real payload: no door or light section, a feeder section, and
// batteries rather than mains.
function feeder(deviceId, name, opts = {}) {
  const device = door(deviceId, name);
  device.deviceType = 'Feeder';
  delete device.state.door;
  delete device.state.light;
  device.state.feeder = {
    state: opts.state || 'closed',
    lastOpenTime: '2026-10-03T06:00:13+01:00',
    lastCloseTime: '2026-10-02T17:30:13+01:00',
    fault: opts.fault || 'none',
    feedLevel: opts.feedLevel === undefined ? 59 : opts.feedLevel,
    lightLevel: 0,
    mode: 'time'
  };
  device.state.general.batteryLevel = opts.batteryLevel === undefined ? 63 : opts.batteryLevel;
  device.state.general.powerSource = 'battery';
  device.remainingDays = 4;
  return device;
}

function account(devices, config = {}) {
  const w = setup({
    config,
    files: { [TOKENS]: JSON.stringify({ bearerToken: 'goodtoken', deviceId: 'dev1' }) }
  });
  devices.forEach(d => w.cloud.addDevice(d));
  return w;
}

function named(w, name) {
  return w.accessories().find(a => a.displayName === name);
}

test('a feeder is published as a contact sensor, not a garage door', async () => {
  const w = account([feeder('feed1', 'Feeder')]);

  await w.start();
  await w.clock.advance(MINUTE);

  const accessory = named(w, 'Feeder');
  assert.ok(accessory.getService(hap.Service.ContactSensor), 'contact sensor');
  assert.equal(accessory.getService(hap.Service.GarageDoorOpener), undefined,
    'a feeder has no meaningful travel, so no garage door');
  assert.equal(accessory.getService(hap.Service.Lightbulb), undefined);
  w.restore();
});

test('a feeder and a door on one account each get the right services', async () => {
  const w = account([door('dev1', 'Front coop'), feeder('feed1', 'Feeder')]);

  await w.start();
  await w.clock.advance(MINUTE);

  assert.equal(w.accessories().length, 2);
  assert.ok(named(w, 'Front coop').getService(hap.Service.GarageDoorOpener));
  assert.ok(named(w, 'Feeder').getService(hap.Service.ContactSensor));
  assert.equal(named(w, 'Feeder').getService(hap.Service.GarageDoorOpener), undefined);
  w.restore();
});

test('closed is contact detected, open is not', async () => {
  const w = account([feeder('feed1', 'Feeder', { state: 'closed' })]);

  await w.start();
  await w.clock.advance(MINUTE);

  const contact = named(w, 'Feeder').getService(hap.Service.ContactSensor);
  const read = () => contact.getCharacteristic(hap.Characteristic.ContactSensorState).value;

  assert.equal(read(), hap.Characteristic.ContactSensorState.CONTACT_DETECTED, 'shut');

  w.cloud.devices.get('feed1').state.feeder.state = 'open';
  await w.clock.advance(MINUTE);

  assert.equal(read(), hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED, 'open');
  w.restore();
});

test('the battery shows the real battery by default', async () => {
  const w = account([feeder('feed1', 'Feeder', { batteryLevel: 63, feedLevel: 59 })]);

  await w.start();
  await w.clock.advance(MINUTE);

  const battery = named(w, 'Feeder').getService(hap.Service.Battery);
  assert.equal(battery.getCharacteristic(hap.Characteristic.BatteryLevel).value, 63,
    'the cells, not the feed');
  w.restore();
});

test('a per-device override makes the battery show feed level instead', async () => {
  const w = account([feeder('feed1', 'Feeder', { batteryLevel: 63, feedLevel: 59 })],
    { devices: [{ deviceId: 'feed1', feederBatteryShows: 'feed' }] });

  await w.start();
  await w.clock.advance(MINUTE);

  const battery = named(w, 'Feeder').getService(hap.Service.Battery);
  assert.equal(battery.getCharacteristic(hap.Characteristic.BatteryLevel).value, 59,
    'the feed, because the user asked for it');
  w.restore();
});

test('only one battery service exists either way', async () => {
  const w = account([feeder('feed1', 'Feeder')],
    { devices: [{ deviceId: 'feed1', feederBatteryShows: 'feed' }] });

  await w.start();
  await w.clock.advance(MINUTE);

  // HomeKit renders one battery per accessory; a second is invisible. Probed
  // against the Home app on 2026-10-14, see docs/FEEDER-DESIGN.md.
  const batteries = named(w, 'Feeder').services.filter(s => s.type === 'Battery');
  assert.equal(batteries.length, 1);
  w.restore();
});

test('low feed trips the low-battery warning in feed mode', async () => {
  const w = account([feeder('feed1', 'Feeder', { batteryLevel: 90, feedLevel: 8 })],
    { devices: [{ deviceId: 'feed1', feederBatteryShows: 'feed' }] });

  await w.start();
  await w.clock.advance(MINUTE);

  const battery = named(w, 'Feeder').getService(hap.Service.Battery);
  assert.equal(battery.getCharacteristic(hap.Characteristic.StatusLowBattery).value, 1,
    'HomeKit warns under 20% - in feed mode that is the refill alert');
  w.restore();
});

test('healthy cells do not warn just because the feed is low', async () => {
  const w = account([feeder('feed1', 'Feeder', { batteryLevel: 90, feedLevel: 8 })]);

  await w.start();
  await w.clock.advance(MINUTE);

  const battery = named(w, 'Feeder').getService(hap.Service.Battery);
  assert.equal(battery.getCharacteristic(hap.Characteristic.StatusLowBattery).value, 0);
  w.restore();
});

test('a fault is reported through StatusFault', async () => {
  const w = account([feeder('feed1', 'Feeder', { fault: 'blocked' })]);

  await w.start();
  await w.clock.advance(MINUTE);

  const contact = named(w, 'Feeder').getService(hap.Service.ContactSensor);
  assert.equal(contact.getCharacteristic(hap.Characteristic.StatusFault).value,
    hap.Characteristic.StatusFault.GENERAL_FAULT);
  w.restore();
});

test('a fault is logged once, not on every poll', async () => {
  const w = account([feeder('feed1', 'Feeder', { fault: 'blocked' })]);

  await w.start();
  await w.clock.advance(10 * MINUTE);

  assert.equal(w.said(/reports a fault/).length, 1,
    'a feeder checks in hourly; a per-poll warning would drown the log');
  w.restore();
});

test('no command is ever sent to a feeder', async () => {
  const w = account([feeder('feed1', 'Feeder')]);

  await w.start();
  await w.clock.advance(10 * MINUTE);

  assert.equal(w.sentTo('feed1').length, 0,
    'read-only: the app offers no "open now", so neither do we');
  w.restore();
});

test('a feeder does not pull the account onto the fast poll cadence', async () => {
  // openpending on a door means it is moving. On a feeder it can simply mean the
  // device is asleep - it checks in hourly - so it must not trigger fast polling.
  const w = account([feeder('feed1', 'Feeder', { state: 'openpending' })]);

  await w.start();
  await w.clock.advance(MINUTE);

  assert.equal(w.platform.handlers.get('feed1').isTransitioning(), false);
  assert.equal(w.said(/still mid-change/).length, 0);
  w.restore();
});

test('a feeder survives a restart as a feeder', async () => {
  const w = account([feeder('feed1', 'Feeder')]);

  await w.start();
  await w.clock.advance(MINUTE);
  const uuid = named(w, 'Feeder').UUID;

  const cached = w.platform.accessories.slice();
  w.platform.handlers.forEach(h => h.destroy());
  w.platform.handlers.clear();
  w.platform.accessories = [];
  cached.forEach(a => w.platform.configureAccessory(a));

  await w.platform.discoverDevices();
  await w.clock.advance(MINUTE);

  assert.equal(w.accessories().length, 1, 'no duplicate');
  assert.equal(named(w, 'Feeder').UUID, uuid);
  assert.ok(named(w, 'Feeder').getService(hap.Service.ContactSensor));
  w.restore();
});

test('an outage does not turn a feeder into a door', async () => {
  const w = account([feeder('feed1', 'Feeder')]);

  await w.start();
  await w.clock.advance(MINUTE);
  assert.ok(named(w, 'Feeder').getService(hap.Service.ContactSensor));

  // Rebuilt from the cached accessories, which have to remember what kind of
  // device each one was.
  w.cloud.fail = { group: 'timeout' };
  const cached = w.platform.accessories.slice();
  w.platform.handlers.forEach(h => h.destroy());
  w.platform.handlers.clear();
  w.platform.accessories = [];
  cached.forEach(a => w.platform.configureAccessory(a));

  await w.platform.discoverDevices();
  await w.clock.advance(MINUTE);

  assert.equal(named(w, 'Feeder').getService(hap.Service.GarageDoorOpener), undefined,
    'still a feeder');
  w.restore();
});

test('a disabled feeder is not published', async () => {
  const w = account([door('dev1', 'Front'), feeder('feed1', 'Feeder')],
    { devices: [{ deviceId: 'feed1', enabled: false }] });

  await w.start();
  await w.clock.advance(MINUTE);

  assert.equal(w.accessories().length, 1);
  assert.equal(w.accessories()[0].displayName, 'Front');
  w.restore();
});
