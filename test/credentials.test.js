// Credential handling: where secrets live, when they move, and when they must not.
// Previously only verifiable by hand on a box - the fake fs is what makes it
// testable, and this is the area where a bug costs a user their credentials.

const { test } = require('node:test');
const assert = require('node:assert');
const { setup, door } = require('./harness');

const TOKENS = '/storage/omlet-coop-tokens.json';
const CONFIG = '/storage/config.json';

function configFile(block) {
  return JSON.stringify({
    platforms: [
      { platform: 'config', name: 'Config' },
      Object.assign({ platform: 'OmletCoop', name: 'Omlet Coop' }, block)
    ]
  });
}

function omletBlock(w) {
  return JSON.parse(w.fs.files[CONFIG]).platforms.find(b => b.platform === 'OmletCoop');
}

test('a key supplied in config.json is moved to storage and scrubbed', async () => {
  const w = setup({
    config: { bearerToken: 'goodtoken' },
    files: { [CONFIG]: configFile({ bearerToken: 'goodtoken' }) }
  });
  w.cloud.addDevice(door('dev1'));

  await w.start();
  await w.clock.advance(1000);

  assert.ok(w.fs.files[TOKENS], 'storage file written');
  assert.equal(JSON.parse(w.fs.files[TOKENS]).bearerToken, 'goodtoken');
  assert.equal(omletBlock(w).bearerToken, undefined, 'removed from config.json');
  assert.ok(w.said('Credentials removed from config.json').length);
  w.restore();
});

test('a rejected key is NEVER scrubbed from config.json', async () => {
  const w = setup({
    config: { bearerToken: 'wrongkey' },
    files: { [CONFIG]: configFile({ bearerToken: 'wrongkey' }) }
  });
  w.cloud.addDevice(door('dev1'));

  await w.start();
  await w.clock.advance(5 * 60 * 1000);

  assert.equal(omletBlock(w).bearerToken, 'wrongkey',
    'an unvalidated credential must survive - scrubbing it would lock the user out');
  w.restore();
});

test('email and password are exchanged for a token and then removed', async () => {
  const w = setup({
    config: { email: 'someone@example.com', password: 'goodpassword' },
    files: { [CONFIG]: configFile({ email: 'someone@example.com', password: 'goodpassword' }) }
  });
  w.cloud.addDevice(door('dev1'));

  await w.start();
  await w.clock.advance(1000);

  const block = omletBlock(w);
  assert.equal(block.password, undefined, 'password must never persist');
  assert.equal(block.email, undefined);
  assert.equal(JSON.parse(w.fs.files[TOKENS]).bearerToken, 'goodtoken', 'token stored instead');
  w.restore();
});

test('a wrong password leaves the config alone', async () => {
  const w = setup({
    config: { email: 'someone@example.com', password: 'wrongpassword' },
    files: { [CONFIG]: configFile({ email: 'someone@example.com', password: 'wrongpassword' }) }
  });
  w.cloud.addDevice(door('dev1'));

  await w.start();
  await w.clock.advance(1000);

  assert.equal(omletBlock(w).password, 'wrongpassword', 'nothing validated, nothing removed');
  w.restore();
});

test('a config key takes precedence, but a working stored one rescues a bad config key', async () => {
  const w = setup({
    config: { bearerToken: 'typokey' },
    files: {
      [CONFIG]: configFile({ bearerToken: 'typokey' }),
      [TOKENS]: JSON.stringify({ bearerToken: 'goodtoken', deviceId: 'dev1' })
    }
  });
  w.cloud.addDevice(door('dev1'));

  await w.start();
  await w.clock.advance(2 * 60 * 1000);

  assert.ok(w.said('falling back to the saved credential').length,
    'a typo in config must not jam a working stored credential');
  assert.ok(w.said('Polling every 30s').length);
  w.restore();
});

test('no credential at all is reported and nothing is published', async () => {
  const w = setup({ files: { [CONFIG]: configFile({}) } });

  await w.start();

  assert.ok(w.said('Not configured').length);
  assert.equal(w.api.registered.length, 0, 'no accessory without a credential');
  w.restore();
});

test('a token is never written to the log', async () => {
  const w = setup({
    config: { debug: true, bearerToken: 'goodtoken' },
    files: { [CONFIG]: configFile({ bearerToken: 'goodtoken' }) }
  });
  w.cloud.addDevice(door('dev1'));

  await w.start();
  await w.clock.advance(60 * 1000);

  const leaked = w.logs.filter(l => l.message.includes('goodtoken'));
  assert.equal(leaked.length, 0,
    `token appeared in ${leaked.length} log line(s) with debug on: ${leaked.map(l => l.message)}`);
  w.restore();
});
