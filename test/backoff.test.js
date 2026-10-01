// The failure back-off. Verified on hardware over 44 hours (auth) and 82 hours
// (transport) before 0.9.9 shipped; these pin that behavior so it survives the
// multi-door work.

const { test } = require('node:test');
const assert = require('node:assert');
const { setup, door } = require('./harness');

const TOKENS = '/storage/omlet-coop-tokens.json';
const MINUTE = 60 * 1000;

function withToken(token) {
  return { files: { [TOKENS]: JSON.stringify({ bearerToken: token, deviceId: 'dev1' }) } };
}

test('a dead key backs off after three failures, then decays to hourly', async () => {
  const w = setup(withToken('deadkey'));
  w.cloud.addDevice(door('dev1'));

  await w.start();
  await w.clock.advance(2 * MINUTE);

  assert.ok(w.saidOnce('Could not authenticate with Omlet after 3 attempts'),
    'entry line exactly once');

  await w.clock.advance(30 * MINUTE);
  const fiveMinuteLines = w.said('Authentication still failing').length;
  assert.ok(fiveMinuteLines >= 4 && fiveMinuteLines <= 7,
    `five-minute phase should report every 5 min, got ${fiveMinuteLines}`);

  await w.clock.advance(35 * MINUTE);
  assert.ok(w.saidOnce('Retrying hourly'), 'hands over to hourly exactly once');

  await w.clock.advance(3 * 60 * MINUTE);
  assert.ok(w.said('has been failing for').length >= 2, 'keeps reporting hourly');
  w.restore();
});

test('polling never stops, however long the key stays dead', async () => {
  const w = setup(withToken('deadkey'));
  w.cloud.addDevice(door('dev1'));

  await w.start();
  await w.clock.advance(6 * 60 * MINUTE);

  const before = w.cloud.requests.length;
  await w.clock.advance(3 * 60 * MINUTE);

  assert.ok(w.cloud.requests.length > before,
    'still polling after nine hours - this is the regression #4 was about');
  assert.ok(w.clock.pending() > 0, 'a timer is always outstanding');
  w.restore();
});

test('a credential saved by the settings UI is picked up without a restart', async () => {
  const w = setup(withToken('deadkey'));
  w.cloud.addDevice(door('dev1'));

  await w.start();
  await w.clock.advance(2 * MINUTE);
  assert.ok(w.said('Could not authenticate').length, 'backing off');

  // What /persist-token does: rewrites storage, touches nothing else.
  w.fs.files[TOKENS] = JSON.stringify({ bearerToken: 'goodtoken', deviceId: 'dev1' });
  await w.clock.advance(6 * MINUTE);

  assert.ok(w.said('newly saved credential').length, 'notices the new token');
  assert.ok(w.said('Authentication recovered').length, 'and recovers');
  w.restore();
});

test('an unreachable Omlet reports twice, then goes quiet', async () => {
  const w = setup(withToken('goodtoken'));
  w.cloud.addDevice(door('dev1'));

  await w.start();
  w.cloud.offline = true;
  await w.clock.advance(3 * MINUTE);

  assert.ok(w.saidOnce('Lost contact with Omlet'), 'entry line once');
  const noisy = w.said('Network error').length;
  assert.ok(noisy <= 2, `at most two raw errors before going quiet, got ${noisy}`);

  w.cloud.offline = false;
  await w.clock.advance(2 * MINUTE);
  assert.ok(w.said('Contact with Omlet recovered').length, 'announces recovery');
  w.restore();
});

test('auth outranks transport: a timeout cannot reset an hour of auth back-off', async () => {
  const w = setup(withToken('deadkey'));
  w.cloud.addDevice(door('dev1'));

  await w.start();
  await w.clock.advance(70 * MINUTE);
  assert.ok(w.said('Retrying hourly').length, 'in the hourly phase');

  w.cloud.offline = true;
  await w.clock.advance(5 * MINUTE);

  assert.equal(w.said('Lost contact with Omlet').length, 0,
    'transport must not take over from auth');
  w.restore();
});
