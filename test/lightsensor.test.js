// The light level sensor. Strictly opt-in, because what it publishes under
// CurrentAmbientLightLevel - a characteristic HomeKit defines in lux - is Omlet's own
// 0-100 scale. See docs/ROADMAP.md for the sampled data behind that decision.

const { test } = require('node:test');
const assert = require('node:assert');
const { setup, door, hap } = require('./harness');

const TOKENS = '/storage/omlet-coop-tokens.json';

function world(config, lightLevel) {
  const w = setup({
    config,
    files: { [TOKENS]: JSON.stringify({ bearerToken: 'goodtoken', deviceId: 'dev1' }) }
  });
  w.cloud.addDevice(door('dev1', 'Coop', { lightLevel }));
  return w;
}

test('off by default - nothing is published without opting in', async () => {
  const w = world({}, 66);

  await w.start();
  await w.clock.advance(60 * 1000);

  assert.equal(w.accessory().getService(hap.Service.LightSensor), undefined,
    'a user who has not asked for it must not get it');
  w.restore();
});

test('a value of false is still off', async () => {
  const w = world({ enableLightSensor: false }, 66);

  await w.start();
  await w.clock.advance(60 * 1000);

  assert.equal(w.accessory().getService(hap.Service.LightSensor), undefined);
  w.restore();
});

test('opting in publishes the reading', async () => {
  const w = world({ enableLightSensor: true }, 66);

  await w.start();
  await w.clock.advance(60 * 1000);

  const service = w.accessory().getService(hap.Service.LightSensor);
  assert.ok(service, 'sensor published');
  assert.equal(service.value(hap.Characteristic.CurrentAmbientLightLevel), 66,
    'the raw 0-100 reading, not a conversion');
  assert.ok(w.saidOnce('Light level sensor enabled'), 'logged once, not every poll');
  w.restore();
});

test('a dark reading is floored to HomeKit minimum rather than zero', async () => {
  const w = world({ enableLightSensor: true }, 0);

  await w.start();
  await w.clock.advance(60 * 1000);

  const service = w.accessory().getService(hap.Service.LightSensor);
  assert.equal(service.value(hap.Characteristic.CurrentAmbientLightLevel), 0.0001,
    'CurrentAmbientLightLevel has a floor of 0.0001; 0 is out of range');
  w.restore();
});

test('the reading follows the door', async () => {
  const w = world({ enableLightSensor: true }, 12);

  await w.start();
  await w.clock.advance(60 * 1000);

  const service = w.accessory().getService(hap.Service.LightSensor);
  assert.equal(service.value(hap.Characteristic.CurrentAmbientLightLevel), 12);

  w.cloud.devices.get('dev1').state.door.lightLevel = 94;
  await w.clock.advance(60 * 1000);

  assert.equal(service.value(hap.Characteristic.CurrentAmbientLightLevel), 94, 'updated on poll');
  w.restore();
});

test('a door that reports no light level gets no sensor, even opted in', async () => {
  const w = setup({
    config: { enableLightSensor: true },
    files: { [TOKENS]: JSON.stringify({ bearerToken: 'goodtoken', deviceId: 'dev1' }) }
  });
  const device = door('dev1');
  delete device.state.door.lightLevel;
  w.cloud.addDevice(device);

  await w.start();
  await w.clock.advance(60 * 1000);

  assert.equal(w.accessory().getService(hap.Service.LightSensor), undefined,
    'no reading, no sensor');
  w.restore();
});

test('turning it off removes the service', async () => {
  const w = world({ enableLightSensor: true }, 66);
  await w.start();
  await w.clock.advance(60 * 1000);
  assert.ok(w.accessory().getService(hap.Service.LightSensor), 'present while enabled');

  // What a restart after unticking the box looks like.
  w.platform.enableLightSensor = false;
  await w.clock.advance(3 * 60 * 1000);

  assert.equal(w.accessory().getService(hap.Service.LightSensor), undefined, 'removed');
  w.restore();
});
