// Pure input validation. No network, no clock - these are the rules that decide
// whether a user's config is usable, and they outlive any refactor.

const { test } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./harness');

function platform(config) {
  const w = setup({ config });
  w.restore();
  return w;
}

test('tokens: console keys contain underscores and must pass', () => {
  const { platform: p } = platform();

  assert.equal(p.validateToken('abc123'), 'abc123');
  assert.equal(p.validateToken('key_with_underscores'), 'key_with_underscores',
    'console keys are not alphanumeric-only - this rule has been got wrong before');
  assert.equal(p.validateToken('key-with-hyphens'), 'key-with-hyphens');
  assert.equal(p.validateToken('a'.repeat(128)), 'a'.repeat(128));

  assert.equal(p.validateToken('has space'), undefined);
  assert.equal(p.validateToken('has!punct'), undefined);
  assert.equal(p.validateToken('a'.repeat(129)), undefined);
  assert.equal(p.validateToken(''), undefined);
});

test('poll interval is clamped to 30-300 seconds', () => {
  const { platform: p } = platform();

  assert.equal(p.validatePollInterval(60), 60000);
  assert.equal(p.validatePollInterval(10), 30000, 'below the floor');
  assert.equal(p.validatePollInterval(9999), 300000, 'above the ceiling');
  assert.equal(p.validatePollInterval('nonsense'), 30000);
  assert.equal(p.validatePollInterval(undefined), 30000);
  assert.equal(p.validatePollInterval(''), 30000, 'an empty field must not be stored');
});

test('country codes: UK is translated to GB, not rejected', () => {
  const { platform: p } = platform();

  assert.equal(p.validateCountryCode('US'), 'US');
  assert.equal(p.validateCountryCode('GB'), 'GB');
  assert.equal(p.validateCountryCode('UK'), 'GB',
    'we shipped UK up to 0.9.7; existing configs must keep working');
  assert.equal(p.validateCountryCode('ES'), 'ES');
  assert.equal(p.validateCountryCode('NO'), 'NO');
  assert.equal(p.validateCountryCode('PL'), 'PL');
  // Only the shape is checked, not membership of the supported list - a well-formed
  // but unsupported code is passed through for the API to reject.
  assert.equal(p.validateCountryCode('ZZ'), 'ZZ');
  assert.equal(p.validateCountryCode('usa'), 'US', 'wrong shape falls back');
  assert.equal(p.validateCountryCode('U1'), 'US');
});

test('tri-state reads the config vocabulary into auto/true/false', () => {
  const { platform: p } = platform();

  // config.json stores 'auto' | 'on' | 'off'; the runtime wants 'auto' | true | false.
  assert.equal(p.normalizeTriState('auto', 'enableLight'), 'auto');
  assert.equal(p.normalizeTriState('on', 'enableLight'), true);
  assert.equal(p.normalizeTriState('off', 'enableLight'), false);

  // Legacy booleans and their spellings, from before the tri-state existed.
  [true, 'true', 'yes'].forEach(v => assert.equal(p.normalizeTriState(v, 'enableLight'), true));
  [false, 'false', 'no'].forEach(v => assert.equal(p.normalizeTriState(v, 'enableLight'), false));

  assert.equal(p.normalizeTriState('nonsense', 'enableLight'), 'auto');
  assert.equal(p.normalizeTriState(undefined, 'enableLight'), 'auto');
  assert.equal(p.normalizeTriState('', 'enableLight'), 'auto');
});

test('device IDs and hostnames', () => {
  const { platform: p } = platform();

  assert.equal(p.validateDeviceId('nOM7abc123'), 'nOM7abc123');
  assert.equal(p.validateDeviceId('has-hyphen'), undefined);
  assert.equal(p.validateDeviceId('a'.repeat(40)), undefined);

  assert.equal(p.validateHostname('x107.omlet.co.uk'), 'x107.omlet.co.uk');
  assert.equal(p.validateHostname('bad host'), undefined);
  assert.equal(p.validateHostname('http://x107.omlet.co.uk'), undefined, 'scheme is not a hostname');
});

test('email is validated when supplied', () => {
  const { platform: p } = platform();

  assert.equal(p.validateEmail('someone@example.com'), 'someone@example.com');
  assert.equal(p.validateEmail('not-an-email'), undefined);
});

test('a bad poll interval is reported, not swallowed', () => {
  const w = platform({ pollInterval: 5 });
  assert.ok(w.said('too low').length, 'the user is told why their setting changed');
});
