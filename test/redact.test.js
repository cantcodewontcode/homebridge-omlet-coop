// The payload redactor. This is what a user hits when they click "Capture device
// payload" and paste the result into a public issue, so its job is to keep the
// structure and the state readable while removing anything that identifies them.
//
// Placeholders are stable per value: the same serial reads as the same placeholder
// everywhere it appears, so the relationships between devices survive.

const { test } = require('node:test');
const assert = require('node:assert');
const { redactPayload, REDACTED_KEYS } = require('../homebridge-ui/redact');

function redact(value) {
  return JSON.parse(redactPayload(JSON.stringify(value)));
}

// The shape of a real /api/v1/group response, trimmed. Two doors and a feeder, as
// posted in #6.
function payload() {
  return [{
    name: 'Back Garden',
    devices: [
      { deviceId: 'nOM7JqzdhAyEvsgv', deviceSerial: '806599a5ef04', deviceType: 'Autodoor',
        name: "Teresa's autodoor",
        state: { general: { batteryLevel: 100, powerSource: 'external',
                            displayLine1: '                ' },
                 connectivity: { wifiStrength: -29, ssid: 'puppynet', connected: true },
                 door: { state: 'open', fault: 'none', lightLevel: 4 } } },
      { deviceId: 'cube000000000001', deviceSerial: 'aabbccddeeff', deviceType: 'Autodoor',
        name: 'Cube',
        state: { door: { state: 'closed', fault: 'none', lightLevel: 0 } } },
      { deviceId: 'feed000000000001', deviceSerial: '112233445566', deviceType: 'Feeder',
        name: 'Feeder', remainingDays: 4,
        state: { general: { batteryLevel: 63, powerSource: 'battery' },
                 feeder: { state: 'open', fault: 'none', feedLevel: 59, mode: 'time' } } }
    ],
    admins: [{ emailAddress: 'someone@example.com', firstName: 'Teresa', lastName: 'Spry',
               siteLink: 'omlet.co.uk' }]
  }];
}

test('identifying values are replaced', async () => {
  const out = redact(payload());
  const flat = JSON.stringify(out);

  for (const secret of ['nOM7JqzdhAyEvsgv', '806599a5ef04', 'puppynet',
                        'someone@example.com', 'Teresa', 'Spry', "Teresa's autodoor"]) {
    assert.equal(flat.includes(secret), false, `${secret} should not survive`);
  }
});

test('every state value survives untouched', async () => {
  const out = redact(payload())[0].devices;

  assert.equal(out[0].state.door.state, 'open');
  assert.equal(out[0].state.door.fault, 'none');
  assert.equal(out[0].state.door.lightLevel, 4);
  assert.equal(out[0].state.general.batteryLevel, 100);
  assert.equal(out[0].state.general.powerSource, 'external');
  assert.equal(out[0].state.connectivity.wifiStrength, -29);
  assert.equal(out[0].state.connectivity.connected, true);

  assert.equal(out[2].state.feeder.feedLevel, 59);
  assert.equal(out[2].state.feeder.mode, 'time');
  assert.equal(out[2].remainingDays, 4);

  // deviceType is the one identifying-adjacent field deliberately kept: without it
  // a reported payload cannot be read at all.
  assert.deepEqual(out.map(d => d.deviceType), ['Autodoor', 'Autodoor', 'Feeder']);
});

test('the same value reads as the same placeholder everywhere', async () => {
  const out = redact([{ devices: [
    { deviceId: 'dev1', deviceSerial: 'aaaa' },
    { deviceId: 'dev1', deviceSerial: 'aaaa' },
    { deviceId: 'dev2', deviceSerial: 'bbbb' }
  ] }])[0].devices;

  assert.equal(out[0].deviceId, out[1].deviceId, 'one device, one placeholder');
  assert.equal(out[0].deviceSerial, out[1].deviceSerial);
  assert.notEqual(out[0].deviceId, out[2].deviceId, 'different devices stay distinct');
});

test('placeholders are numbered per key, in first-seen order', async () => {
  const out = redact([{ devices: [
    { deviceSerial: 'first' }, { deviceSerial: 'second' }, { deviceSerial: 'third' }
  ] }])[0].devices;

  assert.deepEqual(out.map(d => d.deviceSerial),
    ['[DEVICESERIAL_1]', '[DEVICESERIAL_2]', '[DEVICESERIAL_3]']);
});

test('numbering does not collide across different keys', async () => {
  const out = redact([{ deviceId: 'x', deviceSerial: 'y', ssid: 'z' }])[0];

  assert.equal(out.deviceId, '[DEVICEID_1]');
  assert.equal(out.deviceSerial, '[DEVICESERIAL_1]');
  assert.equal(out.ssid, '[SSID_1]');
});

test('key matching ignores case', async () => {
  const out = redact([{ DeviceSerial: 'aaaa', EMAILADDRESS: 'a@b.c', Name: 'Coop' }])[0];

  assert.equal(out.DeviceSerial, '[DEVICESERIAL_1]');
  assert.equal(out.EMAILADDRESS, '[EMAILADDRESS_1]');
  assert.equal(out.Name, '[NAME_1]');
});

test('the structure and key order are preserved', async () => {
  const out = redact(payload());

  assert.equal(Array.isArray(out), true);
  assert.equal(out[0].devices.length, 3);
  assert.deepEqual(Object.keys(out[0]), ['name', 'devices', 'admins']);
  assert.deepEqual(Object.keys(out[0].devices[0]),
    ['deviceId', 'deviceSerial', 'deviceType', 'name', 'state']);
});

test('empty and whitespace values are left alone', async () => {
  // displayLine1 on a real door is sixteen spaces. Replacing it with a placeholder
  // would imply something was there.
  const out = redact([{ name: '', ssid: '   ', displayLine1: '                ' }])[0];

  assert.equal(out.name, '');
  assert.equal(out.ssid, '   ');
  assert.equal(out.displayLine1, '                ');
});

test('non-string values of a redacted key pass through', async () => {
  // Documents the behaviour rather than endorsing it: the redactor only rewrites
  // strings, so a numeric id would survive. No Omlet field is like this today.
  const out = redact([{ deviceId: 12345, name: null, token: true }])[0];

  assert.equal(out.deviceId, 12345);
  assert.equal(out.name, null);
  assert.equal(out.token, true);
});

test('nested arrays of objects are walked', async () => {
  const out = redact([{ metadata: [
    { key: 'feed_type', value: 'pellet', deviceId: 'dev1' },
    { key: 'large_chicken_count', value: '2', deviceId: 'dev1' }
  ] }])[0].metadata;

  assert.equal(out[0].deviceId, '[DEVICEID_1]');
  assert.equal(out[1].deviceId, '[DEVICEID_1]', 'same device, same placeholder');
  assert.equal(out[0].value, 'pellet', 'metadata values are not identifying');
});

test('input that is not JSON comes back unchanged', async () => {
  // A non-200 body, or an Omlet-side error page. Better to hand the user something
  // than to throw inside the capture button.
  assert.equal(redactPayload('<html>502 Bad Gateway</html>'), '<html>502 Bad Gateway</html>');
  assert.equal(redactPayload(''), '');
});

test('a bare array or scalar does not throw', async () => {
  assert.deepEqual(redact([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(redact([]), []);
  assert.deepEqual(JSON.parse(redactPayload('"a string"')), 'a string');
  assert.deepEqual(JSON.parse(redactPayload('null')), null);
});

test('output is valid, re-parsable JSON', async () => {
  const text = redactPayload(JSON.stringify(payload()));

  assert.doesNotThrow(() => JSON.parse(text));
  assert.ok(text.includes('\n  '), 'pretty-printed, because people read it');
});

test('every key in REDACTED_KEYS is actually redacted', async () => {
  // Guards the list itself: adding a key without it taking effect would be silent.
  const source = {};

  REDACTED_KEYS.forEach((key, index) => { source[key] = `secret-${index}`; });

  const out = redact([source])[0];

  REDACTED_KEYS.forEach((key, index) => {
    assert.notEqual(out[key], `secret-${index}`, `${key} was not redacted`);
    assert.match(out[key], /^\[[A-Z0-9_]+\]$/, `${key} produced an odd placeholder`);
  });
});
