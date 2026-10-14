const https = require('https');
const fs = require('fs');

// Homebridge exposes api.serverVersion (its own version), never the plugin's, and
// has no notion of "what version of this plugin ran last time". Recording it here
// is the only way a future release can tell what it is upgrading from.
//
// Prefer shape detection where the data is self-describing - the tri-state
// migration keys off boolean-vs-string and needs no version at all. This is for
// future migrations where the shape cannot discriminate.
const PLUGIN_VERSION = (() => {
  try {
    return require('./package.json').version || null;
  } catch (error) {
    return null;
  }
})();

let hap;

// Door state vocabulary, confirmed against a live Autodoor (firmware 1.0.53).
// While moving, the API reports `openpending` / `closepending` - taken from each
// action's pendingValue - NOT `opening` / `closing`. The latter are kept in case
// other firmware reports them; an unknown value falls back to STOPPED.
const DOOR_OPENING_STATES = ['openpending', 'opening'];
const DOOR_CLOSING_STATES = ['closepending', 'closing'];
// Confirmed by obstructing a live door: a blocked close sets door.fault to
// "blocked". Other fault values are presumed to exist (motor, calibration) but are
// unknown, and they would not mean "something is in the doorway" - so only "blocked"
// drives ObstructionDetected, and anything else is logged so we learn the vocabulary.
const DOOR_FAULT_NONE = 'none';
const DOOR_FAULT_BLOCKED = 'blocked';

const DOOR_TRANSITION_STATES = DOOR_OPENING_STATES.concat(DOOR_CLOSING_STATES, ['stopping']);
const LIGHT_TRANSITION_STATES = ['onpending', 'offpending'];
const LIGHT_ON_STATES = ['on', 'onpending'];
const LIGHT_OFF_STATES = ['off', 'offpending'];

// Only the "*pending" states mean "command accepted but not acted on" - the state a
// dropped command leaves behind. `opening` / `closing` are the door genuinely in
// motion, and a door still moving after 90s is a mechanical problem, not a lost
// command: forcing the opposite there would be wrong and potentially unsafe.
const STUCK_RECOVERY = {
  door: {
    label: 'Door',
    section: 'door',
    stuckStates: ['openpending', 'closepending'],
    intentOf: (state) => (state === 'openpending' ? 'open' : 'close'),
    oppositeOf: (state) => (state === 'openpending' ? 'close' : 'open'),
    settledMatches: (action, state) => (action === 'open' ? state === 'open' : state === 'closed')
  },
  light: {
    label: 'Light',
    section: 'light',
    stuckStates: LIGHT_TRANSITION_STATES,
    intentOf: (state) => (state === 'onpending' ? 'on' : 'off'),
    oppositeOf: (state) => (state === 'onpending' ? 'off' : 'on'),
    settledMatches: (action, state) => (action === 'on' ? state === 'on' : state === 'off')
  }
};
const FAST_POLL_MS = 5000;
const MAX_FAST_POLLS = 18; // ~90s at 5s, well past the ~16s a healthy door takes

// One back-off, three causes. A dropped network, an Omlet outage and a revoked key
// last nothing like each other, and the cost of guessing wrong is how long we stay
// broken after the cause clears - so each gets its own ceiling rather than a shared
// compromise. Nothing in Omlet's response distinguishes a revoked credential from a
// transient 401 (see docs/OMLET-API.md), so auth never gives up; it just gets cheap.
//
// Each plan runs `fast` for `window`, then `slow` forever. `severity` decides which
// cause wins when one arrives while another is already backing off.
const BACKOFF_PLANS = {
  transport: {
    severity: 1,
    threshold: 3,
    onEnter: n => `Lost contact with Omlet after ${n} failed attempts. Still trying, every 30 seconds.`,
    onRecover: d => `Contact with Omlet recovered after ${d}. Resuming normal polling.`,
    tiers: [
      // Same cadence as normal polling: a brief blip should recover the moment the
      // network does, so only the logging goes quiet.
      { until: 5 * 60 * 1000, every: 30 * 1000, status: null },
      { until: 30 * 60 * 1000, every: 2 * 60 * 1000,
        announce: 'Still no contact with Omlet after 5 minutes. Reducing checks to every 2 minutes.',
        status: d => `Still cannot reach Omlet (${d}).` },
      { every: 15 * 60 * 1000,
        announce: 'Still no contact with Omlet after 30 minutes. Reducing checks to every 15 minutes.',
        status: d => `Still cannot reach Omlet (${d}).` }
    ]
  },
  server: {
    severity: 2,
    threshold: 3,
    onEnter: n => `Omlet returned a server error ${n} times. Retrying every minute.`,
    onRecover: d => `Omlet recovered after ${d}. Resuming normal polling.`,
    tiers: [
      { until: 15 * 60 * 1000, every: 60 * 1000,
        status: d => `Omlet has been returning server errors for ${d}.` },
      { every: 15 * 60 * 1000,
        announce: 'Omlet is still returning server errors after 15 minutes. Reducing checks to every 15 minutes.',
        status: d => `Omlet has been returning server errors for ${d}.` }
    ]
  },
  auth: {
    severity: 3,
    threshold: 3,
    onEnter: n => `Could not authenticate with Omlet after ${n} attempts. Retrying every 5 minutes. If needed, open the plugin settings to sign in again.`,
    onRecover: d => `Authentication recovered after ${d}. Resuming normal polling.`,
    tiers: [
      { until: 60 * 60 * 1000, every: 5 * 60 * 1000,
        status: d => `Authentication still failing (${d}).` },
      { every: 60 * 60 * 1000,
        announce: 'Could not authenticate with Omlet after 1 hour. Retrying hourly. If needed, open the plugin settings to sign in again.',
        status: d => `Omlet authentication has been failing for ${d}. If needed, open the plugin settings to sign in again.` }
    ]
  }
};

function describeDuration(ms) {
  const minutes = Math.round(ms / 60000);
  
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const spoken = `${hours} hour${hours === 1 ? '' : 's'}`;
  
  return rest ? `${spoken} ${rest} minute${rest === 1 ? '' : 's'}` : spoken;
}

const SERVICE_LABELS = { light: 'Coop light', battery: 'Battery', lightSensor: 'Light level sensor' };

// HomeKit's CurrentAmbientLightLevel is defined in lux and bottoms out at 0.0001.
// Omlet reports its own 0-100 scale, so what we publish is that number, not lux - the
// option is off by default and says so in the settings. See docs/ROADMAP.md.
const MIN_AMBIENT_LIGHT = 0.0001;

const DOOR_OPEN_STATES = ['open'].concat(DOOR_OPENING_STATES);
const DOOR_CLOSED_STATES = ['closed'].concat(DOOR_CLOSING_STATES);

// HomeKit's own way of saying "not reachable". Throwing a plain Error instead makes
// Homebridge log "This plugin threw an error from the characteristic ..." for every
// characteristic it reads, which is noise, not information.
function unavailable() {
  if (hap.HapStatusError && hap.HAPStatus) {
    return new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
  return new Error('Device unavailable');
}

function mapDoorState(state) {
  if (state === 'open') {
    return hap.Characteristic.CurrentDoorState.OPEN;
  }
  if (state === 'closed') {
    return hap.Characteristic.CurrentDoorState.CLOSED;
  }
  if (DOOR_OPENING_STATES.includes(state)) {
    return hap.Characteristic.CurrentDoorState.OPENING;
  }
  if (DOOR_CLOSING_STATES.includes(state)) {
    return hap.Characteristic.CurrentDoorState.CLOSING;
  }
  return hap.Characteristic.CurrentDoorState.STOPPED;
}

module.exports = (api) => {
  hap = api.hap;
  api.registerPlatform('homebridge-omlet', 'OmletCoop', OmletCoopPlatform);
};

class OmletCoopPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    
    this.email = this.validateEmail(config.email);
    this.password = config.password || undefined;
    this.countryCode = this.validateCountryCode(config.countryCode);
    this.bearerToken = this.validateToken(config.bearerToken, 'bearerToken');
    this.deviceId = this.validateDeviceId(config.deviceId, 'deviceId');
    this.baseUrl = this.validateHostname(config.apiServer) || 'x107.omlet.co.uk';
    this.pollInterval = this.validatePollInterval(config.pollInterval);
    // "auto" (the default, and what an absent setting means) lets the device decide.
    // An explicit true/false is an override and is always obeyed.
    this.rawEnableLight = config.enableLight;
    this.rawEnableBattery = config.enableBattery;
    this.enableLight = this.normalizeTriState(config.enableLight, 'enableLight');
    
    // Forcing the light on is not offered, and is not honoured if hand-edited in:
    // publishing a Lightbulb for a module that is not fitted produces an accessory
    // whose every command fails. Auto-discovery is the only sane "show it" option.
    if (this.enableLight === true) {
      // Only complain about a deliberate "on". A legacy boolean is just the old
      // default and is handled silently by migrateTriState - warning about it
      // would alarm every upgrading user who had the light switched on.
      if (typeof config.enableLight === 'string') {
        this.log.warn('enableLight "on" is not supported - the coop light is auto-discovered. Using "auto".');
      }
      
      this.enableLight = 'auto';
    }
    this.enableBattery = this.normalizeTriState(config.enableBattery, 'enableBattery');
    
    // Strictly opt-in, and a plain boolean rather than a tri-state: there is no
    // sensible "auto" for a reading whose units we cannot honour. See
    // applyLightSensorService for why.
    this.enableLightSensor = config.enableLightSensor === true;
    
    // Per-device overrides, keyed on the hardware serial where there is one and the
    // device ID otherwise. Anything absent falls through to the plugin-level setting
    // above, which is what an upgrade relies on: a single-door user who switched the
    // light accessory off keeps it off, with no migration step and no config rewrite.
    this.deviceOverrides = this.indexDeviceOverrides(config.devices);
    
    // 0 disables removal entirely. 720 hours is 30 days.
    this.removeAfterMs = this.validateHours(config.removeAfterHours) * 60 * 60 * 1000;
    
    // Rediscovery cadence. Devices are not added or removed often, and the cloud
    // only refreshes every ~600s, so hourly is plenty.
    this.pollTimer = null;
    this.pollGeneration = 0;
    this.fastPollCount = 0;
    
    // How long each accessory has been observed missing, keyed by accessory UUID.
    // Deliberately in memory only: a restart re-arms the clock, so a Homebridge that
    // was switched off for a week does not purge everything on its first poll.
    this.missingSince = new Map();
    this.triStateMigrated = false;
    this.credentialsSettled = false;
    this.credentialVerified = false;
    this.authFailedDiscovery = false;
    this.wasDisconnected = false;
    this.previousVersion = null;
    this.storedToken = null;
    this.debug = config.debug || false;
    
    this.currentToken = null;
    this.authMode = null;
    this.storage = this.api.user.storagePath() + '/omlet-coop-tokens.json';
    this.failures = { transport: 0, server: 0, auth: 0 };
    this.backoff = null;
    
    this.accessories = [];
    
    // Running accessory handlers, keyed by deviceId. Until now a handler was
    // constructed and dropped, kept alive only by its own poll timer - so there was
    // no way to stop one. Nothing can be torn down without this.
    this.handlers = new Map();
    
    this.log.info('Omlet Coop platform loaded');
    if (this.debug) {
      this.log.info('Debug mode enabled');
    }
    
    this.api.on('didFinishLaunching', async () => {
      await this.loadStoredCredentials();
      await this.initialize();
    });
  }
  
  // input validation
  
  validatePollInterval(value) {
    // Convert to integer, handling strings and other types
    const interval = parseInt(value);
    
    // If NaN or invalid, use default
    if (isNaN(interval)) {
      if (value !== undefined && value !== null) {
        this.log.warn(`Invalid pollInterval "${value}", using default 30 seconds`);
      }
      return 30 * 1000;
    }
    
    // Enforce min 30 seconds
    if (interval < 30) {
      this.log.warn(`pollInterval ${interval} is too low, enforcing minimum of 30 seconds`);
      return 30 * 1000;
    }
    
    // Enforce max 300 seconds (5 minutes)
    if (interval > 300) {
      this.log.warn(`pollInterval ${interval} is too high, enforcing maximum of 300 seconds`);
      return 300 * 1000;
    }
    
    return interval * 1000;
  }
  
  validateEmail(email) {
    if (!email) {
      return undefined;
    }
    
    // Basic email validation: has @ and . in the right places
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    if (!emailRegex.test(email)) {
      this.log.error(`Invalid email format: "${email}"`);
      return undefined;
    }
    
    return email;
  }
  
  validateCountryCode(code) {
    if (!code) {
      return 'US';
    }
    
    // Omlet's own sign-in form uses GB for the United Kingdom. Older configs of
    // ours used UK, which is not a code Omlet issues - translate rather than reject.
    if (code === 'UK') {
      return 'GB';
    }
    
    // Must be exactly 2 uppercase letters
    const codeRegex = /^[A-Z]{2}$/;
    
    if (!codeRegex.test(code)) {
      this.log.warn(`Invalid country code "${code}", using default "US"`);
      return 'US';
    }
    
    return code;
  }
  
  validateToken(token, fieldName = 'token') {
    if (!token) {
      return undefined;
    }
    
    // A developer console key and a login-issued token are the same credential and
    // go in the same field. Console keys are not strictly alphanumeric - Omlet's own
    // published examples contain underscores - so allow underscore and hyphen too.
    const tokenRegex = /^[A-Za-z0-9_\-]{1,128}$/;
    
    if (!tokenRegex.test(token)) {
      this.log.error(`Invalid ${fieldName}: please check and correct`);
      return undefined;
    }
    
    return token;
  }
  
  normalizeTriState(value, fieldName) {
    if (value === undefined || value === null || value === '' || value === 'auto') {
      return 'auto';
    }
    
    if (value === true || value === 'true' || value === 'on' || value === 'yes') {
      return true;
    }
    
    if (value === false || value === 'false' || value === 'off' || value === 'no') {
      return false;
    }
    
    this.log.warn(`Invalid ${fieldName} "${value}", using "auto"`);
    return 'auto';
  }
  
  validateDeviceId(deviceId, fieldName = 'deviceId') {
    if (!deviceId) {
      return undefined;
    }
    
    // Must be alphanumeric, max 32 characters
    const deviceIdRegex = /^[a-zA-Z0-9]{1,32}$/;
    
    if (!deviceIdRegex.test(deviceId)) {
      this.log.error(`Invalid ${fieldName}: must be alphanumeric and less than 32 characters`);
      return undefined;
    }
    
    return deviceId;
  }
  
  validateHours(value) {
    if (value === undefined || value === null || value === '') {
      return 24;
    }
    
    const hours = Number(value);
    
    if (!Number.isFinite(hours) || hours < 0 || hours > 720) {
      this.log.warn(`Invalid removeAfterHours "${value}", using 24`);
      return 24;
    }
    
    return Math.round(hours);
  }
  
  validateHostname(hostname) {
    if (!hostname) {
      return undefined;
    }
    
    // Basic hostname validation: letters, digits, dots, hyphens
    const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    
    if (!hostnameRegex.test(hostname)) {
      this.log.error(`Invalid API server hostname: "${hostname}"`);
      return undefined;
    }
    
    return hostname;
  }
  
  // credential storage
  
  async loadStoredCredentials() {
    try {
      if (fs.existsSync(this.storage)) {
        const data = JSON.parse(fs.readFileSync(this.storage, 'utf8'));
        
        // Set by the Disconnect button in the settings page.
        if (data.disconnected) {
          this.wasDisconnected = true;
          return;
        }
        
        // Storage holds the working credential. A token in config.json is something
        // the user handed us that we have not consumed yet, so it is tried first -
        // but it is always kept separately, so a bad one cannot lock us out of a
        // good stored credential.
        if (data.bearerToken) {
          const validToken = this.validateToken(data.bearerToken, 'stored bearerToken');
          
          if (validToken) {
            this.storedToken = validToken;
            
            if (!this.bearerToken) {
              this.bearerToken = validToken;
            }
            
            if (this.debug) {
              this.log.info('Loaded stored API token');
            }
          } else {
            this.log.warn('Stored API token is invalid, ignoring');
          }
        }
        
        // Whatever ran last time. null on a fresh install, and on any install that
        // predates this field - both mean "older than the first version to record it".
        this.previousVersion = data.lastVersion || null;
        
        if (data.deviceId && !this.deviceId) {
          const validDeviceId = this.validateDeviceId(data.deviceId, 'stored deviceId');
          if (validDeviceId) {
            this.deviceId = validDeviceId;
            if (this.debug) {
              this.log.info('Loaded stored device ID');
            }
          } else {
            this.log.warn('Stored device ID is invalid, ignoring');
          }
        }
      }
    } catch (error) {
      this.log.error('Failed to load stored credentials:', error.message);
    }
  }
  
  async saveStoredCredentials() {
    try {
      // Merge rather than overwrite. Writing this object wholesale meant a run
      // with no usable token could erase a perfectly good stored one, leaving no
      // way back: the bad credential then became the only copy.
      let existing = {};
      
      try {
        if (fs.existsSync(this.storage)) {
          existing = JSON.parse(fs.readFileSync(this.storage, 'utf8')) || {};
        }
      } catch (error) {
        existing = {};
      }
      
      const data = Object.assign({}, existing, {
        lastVersion: PLUGIN_VERSION,
        lastUpdated: new Date().toISOString()
      });
      
      if (this.deviceId) {
        data.deviceId = this.deviceId;
      }
      
      // Only a credential that has actually worked may be written here.
      if (this.credentialVerified && this.bearerToken) {
        data.bearerToken = this.bearerToken;
      }
      
      if (!data.bearerToken) {
        delete data.bearerToken;
      }
      
      fs.writeFileSync(this.storage, JSON.stringify(data, null, 2));
      if (this.debug) {
        this.log.info('Saved credentials to storage');
      }
      
      return true;
    } catch (error) {
      this.log.error('Failed to save API token and device ID:', error.message);
      return false;
    }
  }
  
  // config.json is a way to hand us credentials, not a place to keep them. Once a
  // credential has actually worked and is safely in the storage directory, take it
  // out of config along with any email and password.
  //
  // Order is deliberate: storage write first, purge only if it succeeded. Purging
  // first and then failing to save would leave no working credential anywhere.
  async settleCredentials() {
    // Nothing may be persisted or purged until an API call has actually succeeded
    // with this credential. Do not latch the flag before that, or the real chance
    // to clean up later is lost.
    if (this.credentialsSettled || !this.credentialVerified) {
      return;
    }
    
    this.credentialsSettled = true;
    
    const saved = await this.saveStoredCredentials();
    
    if (!saved) {
      this.log.warn('Could not save credentials to storage, leaving config.json untouched');
      return;
    }
    
    const removed = this.updateConfigBlocks((block) => {
      let touched = false;
      
      ['password', 'email', 'bearerToken'].forEach((field) => {
        if (block[field] !== undefined) {
          delete block[field];
          touched = true;
        }
      });
      
      return touched;
    });
    
    if (removed) {
      this.password = undefined;
      this.email = undefined;
      this.log.info('Credentials removed from config.json successfully');
    }
  }
  
  // Removes a saved password from config.json once we hold a working token.
  // API keys and bearer tokens are deliberately left untouched - only the password
  // goes, because it is the one credential we no longer need to keep.
  // Applies a mutation to our own platform block(s) in config.json and writes it
  // back atomically. Returns true if anything changed.
  updateConfigBlocks(mutate) {
    let configPath;
    
    try {
      configPath = this.api.user.configPath();
    } catch (error) {
      return false;
    }
    
    try {
      if (!configPath || !fs.existsSync(configPath)) {
        return false;
      }
      
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      if (!Array.isArray(config.platforms)) {
        return false;
      }
      
      let changed = false;
      
      config.platforms.forEach((block) => {
        if (block && block.platform === 'OmletCoop' && mutate(block)) {
          changed = true;
        }
      });
      
      if (!changed) {
        return false;
      }
      
      const tmpPath = configPath + '.omlet-tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 4));
      fs.renameSync(tmpPath, configPath);
      
      return true;
    } catch (error) {
      this.log.warn('Could not update config.json:', error.message);
      return false;
    }
  }
  
  // "auto" is new. Convert the old booleans once, the first time we have real device
  // data to compare against. A boolean means not yet migrated; a string means done.
  migrateTriState(status) {
    if (this.triStateMigrated) {
      return;
    }
    
    this.triStateMigrated = true;
    
    const lightWasBoolean = typeof this.rawEnableLight === 'boolean';
    const batteryWasBoolean = typeof this.rawEnableBattery === 'boolean';
    
    if (!lightWasBoolean && !batteryWasBoolean) {
      return;
    }
    
    const equipped = status?.configuration?.light?.equipped;
    const lightPresent = (equipped !== undefined && equipped !== null)
      ? Number(equipped) > 0
      : (status?.state?.light !== undefined && status?.state?.light !== null);
    
    const source = status?.state?.general?.powerSource;
    const onMains = (typeof source === 'string' && source.toLowerCase() === 'external');
    
    const next = {};
    
    if (lightWasBoolean) {
      // Only an explicit "off" on a door that HAS a light is a real decision that
      // auto would contradict. "on" was the old default, so it carries no intent.
      next.enableLight = (this.rawEnableLight === false && lightPresent) ? 'off' : 'auto';
    }
    
    if (batteryWasBoolean) {
      // Mirror image: "off" was the old default here, so only an explicit "on" on a
      // mains-powered door is a decision worth preserving.
      next.enableBattery = (this.rawEnableBattery === true && onMains) ? 'on' : 'auto';
    }
    
    const wrote = this.updateConfigBlocks((block) => {
      let touched = false;
      Object.keys(next).forEach((key) => {
        if (block[key] !== next[key]) {
          block[key] = next[key];
          touched = true;
        }
      });
      return touched;
    });
    
    Object.keys(next).forEach((key) => {
      this[key] = this.normalizeTriState(next[key], key);
    });
    
    if (wrote) {
      this.log.info('Migrated settings to new syntax');
    }
  }
  
  async initialize() {
    try {
      // One credential, two ways of getting it: generated in the developer console,
      // or issued by logging in. Either way it lands in bearerToken.
      if (this.bearerToken) {
        this.log.info('Using saved API key');
        this.authMode = 'token';
        this.currentToken = this.bearerToken;
      } else if (this.email && this.password) {
        this.log.info('Logging into Omlet API');
        this.authMode = 'password';
        await this.login();
      } else {
        // An explicit disconnect should take the accessories with it. Anything
        // else - a credential that has gone missing for another reason - leaves
        // them in place, so a user does not lose their rooms and automations to a
        // transient problem.
        if (this.wasDisconnected) {
          this.removeAllAccessories();
        }
        
        this.log.error('Not configured. Open the Omlet Coop plugin settings and log in.');
        return;
      }
      
      if (this.debug && this.previousVersion !== PLUGIN_VERSION) {
        this.log.info(`Upgraded from ${this.previousVersion || 'an earlier version'} to ${PLUGIN_VERSION}`);
      }
      
      // Every door on the account is set up, so there is no single device ID to
      // find any more. discoverDevices lists them and creates one accessory each.
      await this.discoverDevices();
      
      // Discovery succeeding is proof the credential works, so clean config.json now
      // rather than after the first poll - the settings UI cannot reliably delete a
      // key, so this is the mechanism users actually depend on.
      if (this.credentialVerified) {
        await this.settleCredentials();
      }
      
    } catch (error) {
      this.log.error('Initialization failed:', error.message);
    }
  }
  
  async login() {
    try {
      const apiKey = await this.performLogin();
      
      this.currentToken = apiKey;
      this.bearerToken = apiKey; // keep in sync with stored value
      await this.saveStoredCredentials();
      
      this.log.info('Login successful');
      
      return apiKey;
      
    } catch (error) {
      if (error.statusCode === 401 || error.statusCode === 403) {
        this.log.error('Login failed. Please check credentials and try again.');
      } else {
        this.log.error('Login failed:', error.message);
      }
      
      throw error;
    }
  }
  
  performLogin() {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        emailAddress: this.email,
        password: this.password,
        cc: this.countryCode
      });
      
      const options = {
        hostname: this.baseUrl,
        port: 443,
        path: '/api/v1/login',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Accept': 'application/json'
        },
        timeout: 10000
      };
      
      if (this.debug) {
        this.log.info('[Auth] POST /api/v1/login');
      }
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (this.debug) {
            this.log.info('[Auth] Response status:', res.statusCode);
          }
          
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              if (json.apiKey) {
                if (this.debug) {
                  this.log.info('[Auth] Bearer token received (' + json.apiKey.length + ' chars)');
                }
                resolve(json.apiKey);
              } else {
                reject(new Error('No apiKey in response'));
              }
            } catch (error) {
              reject(new Error('Failed to parse login response'));
            }
          } else {
            const error = new Error(`HTTP ${res.statusCode}`);
            error.statusCode = res.statusCode;
            error.response = data;
            reject(error);
          }
        });
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Login request timeout'));
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      req.write(postData);
      req.end();
    });
  }
  
  discoverAllDevices() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.baseUrl,
        port: 443,
        path: '/api/v1/group',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.currentToken}`,
          'Accept': 'application/json'
        },
        timeout: 10000
      };
      
      if (this.debug) {
        this.log.info('[Discovery] GET /api/v1/group');
      }
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (this.debug) {
            this.log.info('[Discovery] Response status:', res.statusCode);
          }
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              const devices = [];
              
              // The API returns an array of groups directly
              const groups = Array.isArray(json) ? json : (json.groups || []);
              
              groups.forEach(group => {
                if (group.devices && Array.isArray(group.devices)) {
                  group.devices.forEach(device => {
                    devices.push({
                      deviceId: device.deviceId,
                      serial: device.deviceSerial || null,
                      name: device.name || 'Omlet Device',
                      type: device.deviceType || 'unknown',
                      isDoor: !!(device.state && device.state.door),
                      isFeeder: !!(device.state && device.state.feeder),
                      // The whole device object, which /api/v1/group returns in full -
                      // identical to what the per-device endpoint gives. This is what
                      // makes one call able to serve every handler.
                      status: device
                    });
                  });
                }
              });
              
              if (this.debug) {
                this.log.info('[Discovery] Found', devices.length, 'device(s):', devices.map(d => `${d.name} (${d.deviceId})`).join(', '));
              }
              
              resolve(devices);
            } catch (error) {
              reject(new Error('Failed to parse device list'));
            }
          } else {
            if (res.statusCode !== 401 && res.statusCode !== 403) {
              this.noteFailure('server', 'Poll', `HTTP ${res.statusCode}`);
            }
            
            const error = new Error(`HTTP ${res.statusCode}`);
            error.statusCode = res.statusCode;
            reject(error);
          }
        });
      });
      
      let timedOut = false;
      
      // This is the poll now, not just discovery, so its failures feed the same
      // classification as any other request: transport here, server on a bad status.
      req.on('timeout', () => {
        timedOut = true;
        req.destroy();
        this.noteFailure('transport', 'Poll', 'Request timeout after 10 seconds');
        reject(new Error('Request timeout'));
      });
      
      req.on('error', (error) => {
        if (timedOut) {
          return;
        }
        
        this.noteFailure('transport', 'Poll', `Network error: ${error.message}`);
        reject(error);
      });
      
      req.end();
    });
  }
  
  // The settings page writes a new token straight to the storage file and never
  // touches config.json, so Homebridge does not restart the bridge and we would keep
  // presenting the dead credential. Re-read it whenever auth fails, or someone who
  // signs in again while we are backing off waits an hour to find out it worked.
  refreshStoredToken() {
    try {
      if (!fs.existsSync(this.storage)) {
        return;
      }
      
      const data = JSON.parse(fs.readFileSync(this.storage, 'utf8'));
      
      // Unchanged, or nothing to read - skip validation so a persistently bad token
      // does not log on every single retry.
      if (!data.bearerToken || data.bearerToken === this.storedToken) {
        return;
      }
      
      const validToken = this.validateToken(data.bearerToken, 'stored bearerToken');
      
      if (validToken) {
        this.storedToken = validToken;
      }
    } catch (error) {
      if (this.debug) {
        this.log.warn('Could not re-read stored credentials:', error.message);
      }
    }
  }
  
  backoffActive() {
    return this.backoff !== null;
  }
  
  // A deeper cause takes over a shallower one - an outage that turns out to be a
  // rejected credential must not keep retrying on the network's schedule - but never
  // the reverse, or a single timeout would reset an hour of auth back-off.
  enterBackoff(reason) {
    const plan = BACKOFF_PLANS[reason];
    
    if (this.backoff && BACKOFF_PLANS[this.backoff.reason].severity >= plan.severity) {
      return;
    }
    
    this.backoff = { reason, since: Date.now(), tier: 0, polls: 0 };
    this.log.warn(plan.onEnter(plan.threshold));
  }
  
  // Everything below the threshold is reported as it happens, so a one-off failure is
  // still visible. Past the threshold the back-off's own lines take over.
  noteFailure(reason, context, message) {
    this.failures[reason]++;
    
    if (this.failures[reason] >= BACKOFF_PLANS[reason].threshold) {
      this.enterBackoff(reason);
      return;
    }
    
    // Something equally or more serious is already backing off, and its lines are the
    // narrative - a second cause reporting underneath it is just noise.
    if (this.backoff && BACKOFF_PLANS[this.backoff.reason].severity >= BACKOFF_PLANS[reason].severity) {
      return;
    }
    
    if (message) {
      this.log.error(context ? `[${context}] ${message}` : message);
    }
  }
  
  // Called by the poll loop while backing off: returns how long to wait, and reports
  // where we are. A cadence change is announced once; every other poll carries the
  // elapsed time, so a repeated line is a status report rather than the same sentence
  // forever.
  noteBackoffPoll() {
    const plan = BACKOFF_PLANS[this.backoff.reason];
    const elapsed = Date.now() - this.backoff.since;
    const index = plan.tiers.findIndex(t => t.until === undefined || elapsed < t.until);
    const tier = plan.tiers[index];
    
    if (index !== this.backoff.tier) {
      this.backoff.tier = index;
      
      if (tier.announce) {
        this.log.warn(tier.announce);
      }
    } else if (this.backoff.polls > 0 && tier.status) {
      this.log.warn(tier.status(describeDuration(elapsed)));
    }
    
    this.backoff.polls++;
    
    return tier.every;
  }
  
  noteSuccess() {
    this.authFailedDiscovery = false;
    this.failures.transport = 0;
    this.failures.server = 0;
    this.failures.auth = 0;
    
    if (!this.backoff) {
      return;
    }
    
    const plan = BACKOFF_PLANS[this.backoff.reason];
    this.log.info(plan.onRecover(describeDuration(Date.now() - this.backoff.since)));
    
    this.backoff = null;
  }
  
  async handleAuthError() {
    this.refreshStoredToken();
    
    // A credential from config.json that does not work must never block a working
    // one in storage - otherwise a typo'd key jams the plugin permanently, because
    // config is only cleaned up after a successful poll. The re-read above means this
    // also catches a token the user has just saved from the settings page.
    if (this.storedToken && this.currentToken !== this.storedToken) {
      if (this.backoffActive()) {
        this.log.info('A newly saved credential is available; retrying with it');
      } else {
        this.log.warn('The API key in config.json was rejected; falling back to the saved credential');
      }
      
      this.bearerToken = this.storedToken;
      this.currentToken = this.storedToken;
      this.failures.auth = 0;
      return true;
    }
    
    // No password is persisted, so a dead key cannot be refreshed automatically.
    // It may have been revoked in the developer console, or the login session behind
    // it may have ended - the plugin cannot tell which, so cover both. A couple of
    // failures could still be a server blip, so give it a few tries before backing off.
    if (!this.email || !this.password) {
      this.failures.auth++;
      
      if (this.failures.auth < BACKOFF_PLANS.auth.threshold) {
        if (this.debug) {
          this.log.warn(`Authentication failed (${this.failures.auth}/${BACKOFF_PLANS.auth.threshold}), will retry`);
        }
        return false;
      }
      
      this.enterBackoff('auth');
      return false;
    }
    
    // Once backing off, this runs one attempt per back-off poll: the cadence limits
    // how often we try, not whether we try. The per-attempt lines are suppressed there
    // because the back-off status lines already say what is happening.
    const quiet = this.backoffActive();
    
    this.failures.auth++;
    
    if (!quiet) {
      this.log.warn(`Authentication error detected, attempting to re-login (attempt ${this.failures.auth}/${BACKOFF_PLANS.auth.threshold})...`);
    }
    
    try {
      await this.login();
      this.log.info('Re-login successful');
      this.noteSuccess();
      
      return true;
    } catch (error) {
      if (!quiet) {
        this.log.error('Failed to re-login:', error.message);
      }
      
      if (this.failures.auth >= BACKOFF_PLANS.auth.threshold) {
        this.enterBackoff('auth');
      } else {
        const remaining = BACKOFF_PLANS.auth.threshold - this.failures.auth;
        this.log.warn(`Will retry on next operation (${remaining} attempt${remaining === 1 ? '' : 's'} remaining)`);
      }
      
      return false;
    }
  }
  
  removeAllAccessories() {
    if (this.accessories.length > 0) {
      this.log.info(`Configuration cleared: removing ${this.accessories.length} accessory(s) from Homebridge.`);
      this.api.unregisterPlatformAccessories('homebridge-omlet', 'OmletCoop', this.accessories);
      this.accessories = [];
    }
    
    // Clear the marker so this happens once.
    try {
      if (fs.existsSync(this.storage)) {
        fs.unlinkSync(this.storage);
      }
    } catch (error) {
      this.log.warn('Could not clear the disconnect marker:', error.message);
    }
    
    this.wasDisconnected = false;
  }
  
  // Discovery is the first call after sign-in, so it is where a rejected credential
  // shows up. One retry, because handleAuthError may have swapped in a working one.
  async discoverWithAuthRetry(isRetry = false) {
    try {
      const devices = await this.discoverAllDevices();
      this.credentialVerified = true;
      return devices;
    } catch (error) {
      if (!isRetry && (error.statusCode === 401 || error.statusCode === 403)) {
        if (await this.handleAuthError()) {
          return this.discoverWithAuthRetry(true);
        }
        
        // Discovery now runs on every poll, so this would repeat for ever. The
        // back-off messages already report the auth state; say this once.
        if (!this.authFailedDiscovery) {
          this.authFailedDiscovery = true;
          this.log.error('Could not sign in to Omlet. Open the Omlet Coop plugin settings and log in again.');
        }
        
        return [];
      }
      
      throw error;
    }
  }
  
  // Which accessory, if any, already represents this device. Serial first: it is the
  // wifi MAC and survives a factory reset, where the device ID does not.
  findAccessoryFor(device, claimed) {
    const free = this.accessories.filter(item => !claimed.has(item));
    
    if (device.serial) {
      const bySerial = free.find(item => item.context.deviceSerial === device.serial);
      if (bySerial) {
        return bySerial;
      }
    }
    
    // Serial is authoritative wherever both sides have one: a device ID can be
    // reissued, a MAC cannot, so two different serials are two different doors and
    // no amount of UUID agreement makes them the same. Only accessories with no
    // serial recorded are eligible for the weaker matches - which on upgrade is all
    // of them, since the serial is written on the first poll.
    const eligible = device.serial
      ? free.filter(item => !item.context.deviceSerial)
      : free;
    
    const uuid = this.api.hap.uuid.generate('omlet-coop-' + device.deviceId);
    return eligible.find(item => item.UUID === uuid)
      || eligible.find(item => item.context.deviceId === device.deviceId);
  }
  
  // Returns the doors on the account, and whether the answer can be trusted. An
  // untrusted answer still sets accessories up, but must never cause a removal.
  async listDoors() {
    let devices;
    
    try {
      devices = await this.discoverWithAuthRetry();
    } catch (error) {
      // noteFailure has already classified and reported this; repeating it here
      // would print on every poll.
      if (this.debug) {
        this.log.warn('Could not list the devices on your account:', error.message);
      }
      
      return { doors: [], authoritative: false };
    }
    
    // Dispatch on the state sections a device reports, not on deviceType: the SDK
    // types that as a bare string with no enumeration, so the shape is the reliable
    // signal and the type string is only a hint.
    const doors = devices.filter(device => device.deviceId && device.isDoor);
    const skipped = devices.length - doors.length;
    
    if (skipped > 0 && !this.skippedLogged) {
      this.skippedLogged = true;
      this.log.info(`Ignoring ${skipped} device(s) that are not coop doors`);
    }
    
    // An empty list is indistinguishable from an Omlet-side glitch, so it is never
    // grounds for removing anything.
    return { doors, authoritative: doors.length > 0 };
  }
  
  async discoverDevices() {
    this.log.info('Setting up Homebridge accessories...');
    
    const { doors, authoritative } = await this.listDoors();
    let devices = doors;
    
    // Discovery failing must not take the user's accessories with it. A dead
    // credential or an Omlet outage at startup would otherwise empty HomeKit, when
    // the right behavior is to bring back what we had, show it as unreachable, and
    // let the back-off keep trying. Rebuilt from what each accessory remembers.
    if (!authoritative && this.accessories.length > 0) {
      this.log.warn('Could not reach Omlet - keeping the existing accessories and retrying');
      
      devices = this.accessories
        .filter(item => item.context.deviceId)
        .map(item => ({
          deviceId: item.context.deviceId,
          serial: item.context.deviceSerial || null,
          name: item.displayName,
          type: 'Autodoor',
          isDoor: true
        }));
    }
    
    // Nothing cached either, but a device ID in storage says a door was set up
    // before. Publish it and let the poll loop report the real problem, rather than
    // starting up with no accessories at all.
    if (devices.length === 0 && this.deviceId) {
      devices = [{ deviceId: this.deviceId, serial: null, name: 'Omlet Coop',
                   type: 'Autodoor', isDoor: true }];
    }
    
    if (devices.length === 0) {
      this.log.error('No coop door found on this account. Check the Omlet app, then restart Homebridge.');
      return;
    }
    
    this.applyDiscovery(devices, authoritative);
    
    // Discovery just fetched /api/v1/group, and that response carries each device's
    // full state - so apply it rather than scheduling an immediate poll that asks
    // for the very same thing. Startup used to make two identical requests a second
    // apart.
    this.log.info(`Polling every ${this.pollInterval / 1000}s`);
    
    for (const device of devices) {
      const handler = this.handlers.get(device.deviceId);
      
      if (handler && device.status) {
        await handler.acceptStatus(device);
      }
    }
    
    // Unless something is already mid-change, in which case fall straight into the
    // fast cadence rather than letting a moving door sit until the next full poll.
    const moving = [...this.handlers.values()].some(handler => handler.isTransitioning());
    
    this.schedulePoll(moving ? FAST_POLL_MS : this.pollInterval);
  }
  
  // Serials arrive as a MAC and people retype them with whatever separators and
  // case they please. Match on the digits.
  overrideKey(value) {
    if (typeof value !== 'string') {
      return null;
    }
    
    const key = value.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    return key || null;
  }
  
  indexDeviceOverrides(devices) {
    const index = new Map();
    
    if (!Array.isArray(devices)) {
      return index;
    }
    
    devices.forEach((entry) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      
      // Indexed under both keys so an entry written before the device had ever been
      // polled - device ID only - still matches once the serial is known.
      const serial = this.overrideKey(entry.serial || entry.deviceSerial);
      const deviceId = this.overrideKey(entry.deviceId);
      
      if (serial) {
        index.set('serial:' + serial, entry);
      }
      
      if (deviceId) {
        index.set('device:' + deviceId, entry);
      }
    });
    
    return index;
  }
  
  // Serial first: it survives a factory reset, and the device ID does not.
  lookupOverride(device) {
    const serial = this.overrideKey(device.serial);
    
    if (serial && this.deviceOverrides.has('serial:' + serial)) {
      return this.deviceOverrides.get('serial:' + serial);
    }
    
    const deviceId = this.overrideKey(device.deviceId);
    
    if (deviceId && this.deviceOverrides.has('device:' + deviceId)) {
      return this.deviceOverrides.get('device:' + deviceId);
    }
    
    return null;
  }
  
  // What this one device should publish. Every field falls back to the plugin-level
  // setting, so a config with no devices array behaves exactly as it did before.
  deviceSettings(device) {
    const entry = this.lookupOverride(device) || {};
    const light = entry.enableLight === undefined
      ? this.enableLight
      : this.normalizeTriState(entry.enableLight, 'enableLight');
    
    return {
      // Forcing the light on is not offered here either; see the constructor.
      enableLight: light === true ? 'auto' : light,
      enableBattery: entry.enableBattery === undefined
        ? this.enableBattery
        : this.normalizeTriState(entry.enableBattery, 'enableBattery'),
      enableLightSensor: entry.enableLightSensor === undefined
        ? this.enableLightSensor
        : entry.enableLightSensor === true
    };
  }
  
  // A disabled device is unregistered from HomeKit, not merely left unpolled: a
  // registered accessory that never updates looks broken, and the user asked for it
  // to go. It stays in the device list the settings page shows, so it can come back.
  isExcluded(device) {
    const entry = this.lookupOverride(device);
    
    if (entry && entry.enabled !== undefined) {
      return entry.enabled === false;
    }
    
    return !!this.startupDisabled && this.startupDisabled.has(device.deviceId);
  }
  
  // Which devices to publish when the config says nothing at all. A pre-0.9.10
  // install could only ever publish one door, so meeting a multi-door account for
  // the first time must not silently fill HomeKit with tiles the user never asked
  // for. Decided once, on the first discovery: a door that turns up later is new,
  // not pre-existing, and arrives enabled.
  planEnablement(devices) {
    if (this.startupDisabled || this.deviceOverrides.size > 0) {
      return;
    }
    
    this.startupDisabled = new Set();
    
    // One cached accessory and more than one device is the upgrade case exactly.
    // None means a fresh install, and two or more means this install already
    // publishes several doors, so it is not an upgrade at all.
    if (devices.length < 2 || this.accessories.length !== 1) {
      return;
    }
    
    const incumbent = this.findIncumbent(devices);
    
    if (!incumbent) {
      return;
    }
    
    devices.forEach((device) => {
      if (device !== incumbent) {
        this.startupDisabled.add(device.deviceId);
      }
    });
    
    this.log.warn(`Found ${devices.length} devices on your account, and only "${incumbent.name}" was set up before. The others start disabled so they do not appear in HomeKit unasked - open the plugin settings to enable them.`);
  }
  
  // Which device the one existing accessory stands for. Accessories created before
  // 0.9.10 carry no serial, so the stored device ID is often the only link.
  findIncumbent(devices) {
    const accessory = this.accessories[0];
    const serial = this.overrideKey(accessory.context.deviceSerial);
    
    if (serial) {
      const match = devices.find(device => this.overrideKey(device.serial) === serial);
      
      if (match) {
        return match;
      }
    }
    
    const ids = new Set([accessory.context.deviceId, this.deviceId]
      .map(value => this.overrideKey(value))
      .filter(Boolean));
    const byId = devices.find(device => ids.has(this.overrideKey(device.deviceId)));
    
    if (byId) {
      return byId;
    }
    
    // Nothing matched - a factory reset while the plugin was off, most likely.
    // Publishing nothing would leave the plugin silently doing nothing at all, which
    // is worse than publishing a door the user can switch off.
    this.log.warn('None of the devices on your account match the one already in HomeKit. Publishing all of them.');
    
    return null;
  }
  
  applyDiscovery(devices, authoritative) {
    const claimed = new Set();
    const seenSerials = new Set();
    
    this.planEnablement(devices);
    
    devices.forEach((device) => {
      // Disabled devices are unregistered and then simply not tracked. They are not
      // left to the missing-device timer: there is nothing of theirs left in HomeKit
      // to clean up, and the device has not gone anywhere.
      if (this.isExcluded(device)) {
        this.excludeDevice(device);
        return;
      }
      
      const existing = this.handlers.get(device.deviceId);
      
      if (existing) {
        claimed.add(existing.accessory);
        if (device.serial) {
          seenSerials.add(device.serial);
        }
        existing.noteSeen(device);
        return;
      }
      
      // One accessory per piece of hardware. A reset can leave the old registration
      // on the account alongside the new one, both reporting the same MAC - that is
      // one door, however many device IDs it answers to.
      if (device.serial && seenSerials.has(device.serial)) {
        if (this.debug) {
          this.log.warn(`Ignoring "${device.name}" (${device.deviceId}): another device already reports serial ${device.serial}`);
        }
        return;
      }
      
      if (device.serial) {
        seenSerials.add(device.serial);
      }
      
      let accessory = this.findAccessoryFor(device, claimed);
      
      // An upgrade from a single-door version: one door, one accessory, and nothing
      // matched because it predates both the serial and the stored device ID. It can
      // only be this one, so adopt rather than stranding the user's rooms and
      // automations on a dead tile.
      //
      // Only for an accessory with no serial recorded. One that has a serial and did
      // not match is different hardware, and adopting it would undo that check.
      if (!accessory && devices.length === 1 && this.accessories.length === 1
          && claimed.size === 0 && !this.accessories[0].context.deviceSerial) {
        accessory = this.accessories[0];
        this.log.info(`Adopting the existing HomeKit accessory for "${device.name}"`);
      }
      
      if (!accessory) {
        this.log.info(`Adding new accessory: ${device.name}`);
        accessory = new this.api.platformAccessory(device.name, this.api.hap.uuid.generate('omlet-coop-' + device.deviceId));
        accessory.context.deviceId = device.deviceId;
        accessory.context.deviceSerial = device.serial || undefined;
        this.api.registerPlatformAccessories('homebridge-omlet', 'OmletCoop', [accessory]);
        
        // configureAccessory only runs for accessories restored from cache, so
        // without this the platform does not know about one it just created.
        this.accessories.push(accessory);
      } else if (accessory.context.deviceId !== device.deviceId) {
        if (accessory.context.deviceId) {
          this.log.info(`Device ID changed for "${device.name}"; keeping the existing HomeKit accessory`);
        }
        
        accessory.context.deviceId = device.deviceId;
        accessory.context.deviceSerial = device.serial || accessory.context.deviceSerial;
        this.api.updatePlatformAccessories([accessory]);
      }
      
      claimed.add(accessory);
      this.missingSince.delete(accessory.UUID);
      this.handlers.set(device.deviceId, new OmletCoopAccessory(this, accessory, device));
    });
    
    if (authoritative) {
      this.reapMissing(claimed);
    }
  }
  
  // Accessories with no device behind them any more. The clock only runs while we
  // are actually looking and getting answers - it is not wall-clock time since the
  // device was last seen.
  reapMissing(claimed) {
    if (this.removeAfterMs === 0) {
      return;
    }
    
    const now = Date.now();
    
    this.accessories.slice().forEach((accessory) => {
      if (claimed.has(accessory)) {
        return;
      }
      
      const since = this.missingSince.get(accessory.UUID);
      
      if (since === undefined) {
        this.missingSince.set(accessory.UUID, now);
        this.log.warn(`"${accessory.displayName}" is no longer on your account. Removing it in ${Math.round(this.removeAfterMs / 3600000)} hours if it does not come back.`);
        return;
      }
      
      if (now - since >= this.removeAfterMs) {
        this.missingSince.delete(accessory.UUID);
        this.removeHandler(accessory.context.deviceId, 'not seen for ' + describeDuration(now - since));
      }
    });
  }
  
  // One request serves the whole account: /api/v1/group returns the same object the
  // per-device endpoint does, for every device. Polling it instead means the request
  // count stops scaling with the number of doors, and every poll is also a
  // discovery - a new coop appears within one interval rather than on a timer of
  // its own.
  schedulePoll(delayMs) {
    this.pollGeneration++;
    
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    
    const generation = this.pollGeneration;
    this.pollTimer = setTimeout(() => this.runPoll(generation), delayMs);
  }
  
  stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
  
  async runPoll(generation) {
    let authoritative = false;
    
    try {
      const result = await this.listDoors();
      authoritative = result.authoritative;
      
      if (authoritative) {
        this.applyDiscovery(result.doors, true);
        
        result.doors.forEach((device) => {
          const handler = this.handlers.get(device.deviceId);
          
          if (handler) {
            handler.acceptStatus(device);
          }
        });
      }
    } catch (error) {
      if (this.debug) {
        this.log.warn('[Poll] Poll cycle failed:', error.message);
      }
    }
    
    if (generation !== this.pollGeneration) {
      return;
    }
    
    if (this.backoffActive()) {
      this.schedulePoll(this.noteBackoffPoll());
      return;
    }
    
    // Any door mid-change pulls the whole account onto the fast cadence. One request
    // covers them all, so watching one door closely costs nothing for the others.
    const moving = [...this.handlers.values()].some(handler => handler.isTransitioning());
    
    if (moving) {
      this.fastPollCount++;
      
      if (this.fastPollCount <= MAX_FAST_POLLS) {
        this.schedulePoll(FAST_POLL_MS);
        return;
      }
      
      let recovered = false;
      
      for (const handler of this.handlers.values()) {
        if (handler.isTransitioning()) {
          handler.reportStuck();
          recovered = (await handler.recoverStuck('door')) || (await handler.recoverStuck('light')) || recovered;
        }
      }
      
      this.fastPollCount = 0;
      
      if (recovered) {
        this.schedulePoll(FAST_POLL_MS);
        return;
      }
    }
    
    this.fastPollCount = 0;
    this.schedulePoll(this.pollInterval);
  }
  
  // Stop a handler and take its accessory out of HomeKit. Separate from deciding
  // *when* to do that - this is the mechanism, the policy lives with discovery.
  removeHandler(deviceId, reason) {
    const handler = this.handlers.get(deviceId);
    
    if (handler) {
      handler.destroy();
      this.handlers.delete(deviceId);
    }
    
    const accessory = this.accessories.find(item => item.context.deviceId === deviceId);
    
    if (!accessory) {
      return false;
    }
    
    return this.removeAccessory(accessory, reason);
  }
  
  removeAccessory(accessory, reason) {
    this.log.info(`Removing "${accessory.displayName}" from HomeKit${reason ? ': ' + reason : ''}`);
    this.api.unregisterPlatformAccessories('homebridge-omlet', 'OmletCoop', [accessory]);
    this.accessories = this.accessories.filter(item => item !== accessory);
    this.missingSince.delete(accessory.UUID);
    
    return true;
  }
  
  // Take a disabled device back out of HomeKit. Silent once there is nothing left to
  // remove, which matters when discovery runs on every poll.
  excludeDevice(device) {
    const handler = this.handlers.get(device.deviceId);
    
    if (handler) {
      handler.destroy();
      this.handlers.delete(device.deviceId);
    }
    
    const serial = this.overrideKey(device.serial);
    const accessory = this.accessories.find(item =>
      (serial && this.overrideKey(item.context.deviceSerial) === serial)
      || item.context.deviceId === device.deviceId);
    
    if (!accessory) {
      return false;
    }
    
    return this.removeAccessory(accessory, 'disabled in the plugin settings');
  }
  
  configureAccessory(accessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }
  
  getCurrentToken() {
    return this.currentToken;
  }
}

// Combined accessory with linked services
class OmletCoopAccessory {
  constructor(platform, accessory, device) {
    this.platform = platform;
    this.accessory = accessory;
    this.log = platform.log;
    
    this.device = device || { deviceId: platform.deviceId, name: accessory.displayName };
    this.deviceId = this.device.deviceId;
    this.name = this.device.name || accessory.displayName;
    this.baseUrl = platform.baseUrl;
    
    // Resolved per device, falling back to the plugin-level settings. Re-read on
    // retarget, because a serial learned later can bring overrides with it.
    this.settings = platform.deviceSettings(this.device);
    this.pollInterval = platform.pollInterval;

    this.debug = platform.debug;
    
    this.accessoryInfoUpdated = false;
    this.cachedStatus = null;
    this.pollTimer = null;
    this.pollGeneration = 0;
    this.fastPollCount = 0;
    this.pendingServiceChange = { light: null, battery: null, lightSensor: null };
    this.firstReconcileDone = false;
    this.lastFault = null;
    this.destroyed = false;
    this.recoveryAttempted = { door: false, light: false };
    this.intents = { door: null, light: null };
    this.reapply = { door: null, light: null };
    this.batteryOverrideRefused = false;
    
    // serial and firmware get updated after the first successful poll
    this.accessory.getService(hap.Service.AccessoryInformation)
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Omlet')
      .setCharacteristic(hap.Characteristic.Model, 'Smart Autodoor')
      .setCharacteristic(hap.Characteristic.SerialNumber, this.deviceId)
      .setCharacteristic(hap.Characteristic.FirmwareRevision, '0.0.0');
    
    this.doorService = this.accessory.getService(hap.Service.GarageDoorOpener) 
      || this.accessory.addService(hap.Service.GarageDoorOpener);
    
    this.doorService.setCharacteristic(hap.Characteristic.Name, 'Coop Door');
    this.doorService.setPrimaryService(true);
    
    this.doorService
      .getCharacteristic(hap.Characteristic.CurrentDoorState)
      .onGet(this.getCurrentDoorState.bind(this));
    
    this.doorService
      .getCharacteristic(hap.Characteristic.TargetDoorState)
      .onGet(this.getTargetDoorState.bind(this))
      .onSet(this.setTargetDoorState.bind(this));
    
    this.doorService
      .getCharacteristic(hap.Characteristic.ObstructionDetected)
      .onGet(this.getObstructionDetected.bind(this));
    
    // An explicit true/false is applied immediately. Under "auto" we keep whatever
    // the cached accessory already had and let the first poll decide, so the service
    // does not flicker away and back on every restart.
    this.applyLightService(this.settings.enableLight === 'auto' ? this.hasLightService() : this.settings.enableLight);
    this.applyBatteryService(this.settings.enableBattery === 'auto' ? this.hasBatteryService() : this.settings.enableBattery);
    
    this.log.info(`Coop accessory initialized (light: ${this.describePref(this.settings.enableLight)}, battery: ${this.describePref(this.settings.enableBattery)})`);
    

  }
  
  // Read-only status: HomeKit cannot use this to block the door control, and we
  // would not want it to. It self-clears - the fault drops back to "none" within a
  // few seconds of the next close attempt, including the door's own dusk close.
  getObstructionDetected() {
    return this.cachedStatus?.state?.door?.fault === DOOR_FAULT_BLOCKED;
  }
  
  // Faults we do not recognize are surfaced once each, rather than silently ignored
  // or wrongly reported as an obstruction.
  noteDoorFault(fault) {
    if (!fault || fault === DOOR_FAULT_NONE) {
      this.lastFault = fault;
      return;
    }
    
    if (fault === this.lastFault) {
      return;
    }
    
    this.lastFault = fault;
    
    if (fault === DOOR_FAULT_BLOCKED) {
      this.log.warn('[Door] Door reported blocked - something is in the doorway. It will clear on the next close attempt.');
      return;
    }
    
    this.log.warn(`[Door] Door reported an unrecognized fault: "${fault}". Please report this at https://github.com/cantcodewontcode/homebridge-omlet-coop/issues`);
  }
  
  // One line per failure while something is clearly wrong, then silence until it
  // recovers - and one line to say it did.
  // After a command, HomeKit immediately re-reads the characteristic. The getters
  // read the cache, and the cache still holds the pre-command state until the next
  // poll - so the control visibly snaps back before correcting itself seconds later.
  // Record the expected pending state so reads agree with what was just asked for.
  setCachedState(section, value) {
    if (!this.cachedStatus || !this.cachedStatus.state || !this.cachedStatus.state[section]) {
      return;
    }
    
    // A null clears it, so the next poll's real value is used rather than a guess.
    if (value === null) {
      delete this.cachedStatus.state[section].state;
      return;
    }
    
    this.cachedStatus.state[section].state = value;
  }
  
  describePref(pref) {
    return pref === 'auto' ? 'auto' : (pref ? 'on' : 'off');
  }
  
  hasLightService() {
    return !!this.accessory.getService(hap.Service.Lightbulb);
  }
  
  hasBatteryService() {
    return !!this.accessory.getService(hap.Service.Battery);
  }
  
  applyLightService(enabled) {
    const existing = this.accessory.getService(hap.Service.Lightbulb);
    
    if (!enabled) {
      if (existing) {
        this.doorService.removeLinkedService(existing);
        this.accessory.removeService(existing);
      }
      this.lightService = null;
      return;
    }
    
    const service = existing || this.accessory.addService(hap.Service.Lightbulb);
    service.setCharacteristic(hap.Characteristic.Name, 'Coop Light');
    service
      .getCharacteristic(hap.Characteristic.On)
      .onGet(this.getLightOn.bind(this))
      .onSet(this.setLightOn.bind(this));
    this.doorService.addLinkedService(service);
    this.lightService = service;
  }
  
  applyBatteryService(enabled) {
    const existing = this.accessory.getService(hap.Service.Battery);
    
    if (!enabled) {
      if (existing) {
        this.doorService.removeLinkedService(existing);
        this.accessory.removeService(existing);
      }
      this.batteryService = null;
      return;
    }
    
    const service = existing || this.accessory.addService(hap.Service.Battery);
    service.setCharacteristic(hap.Characteristic.Name, 'Battery');
    service
      .getCharacteristic(hap.Characteristic.BatteryLevel)
      .onGet(this.getBatteryLevel.bind(this));
    service
      .getCharacteristic(hap.Characteristic.ChargingState)
      .setValue(2); // NOT_CHARGEABLE - the autodoor uses non-rechargeable AA cells
    service
      .getCharacteristic(hap.Characteristic.StatusLowBattery)
      .onGet(this.getStatusLowBattery.bind(this));
    this.doorService.addLinkedService(service);
    this.batteryService = service;
  }
  
  // Under "auto" the hardware decides, and it is re-evaluated on every poll rather
  // than latched at discovery. Moving a coop from mains to batteries, or fitting a
  // light module, is picked up without anyone touching the config.
  desiredLight(status) {
    if (this.settings.enableLight !== 'auto') {
      return this.settings.enableLight;
    }
    
    const equipped = status?.configuration?.light?.equipped;
    if (equipped !== undefined && equipped !== null) {
      return Number(equipped) > 0;
    }
    
    const lightState = status?.state?.light;
    return lightState !== undefined && lightState !== null;
  }
  
  desiredBattery(status) {
    const count = status?.batteryCount;
    const source = status?.state?.general?.powerSource;
    const onMains = (typeof source === 'string' && source.toLowerCase() === 'external');
    
    // If the device states it is on mains with no cells fitted, there is no battery,
    // and "Always on" cannot conjure one. A 0% tile on a mains-powered door is worse
    // than no tile: it is wrong, and HomeKit will eventually warn about it.
    if (onMains && count === 0) {
      if (this.settings.enableBattery === true && !this.batteryOverrideRefused) {
        this.batteryOverrideRefused = true;
        this.log.warn('Battery Status is set to "Always on", but this door reports hardwired power with no batteries fitted, so no battery accessory is shown.');
      }
      return false;
    }
    
    if (this.settings.enableBattery !== 'auto') {
      return this.settings.enableBattery;
    }
    
    if (typeof count === 'number' && count > 0) {
      return true;
    }
    
    if (typeof source === 'string' && source.length > 0) {
      return !onMains;
    }
    
    return false;
  }
  
  // Require two consecutive polls to agree before adding or removing a service, so a
  // single odd reading cannot make an accessory appear and disappear in the Home app.
  reconcileService(kind, desired, has, apply) {
    if (desired === has()) {
      this.pendingServiceChange[kind] = null;
      return;
    }
    
    const pending = this.pendingServiceChange[kind];
    
    // On the very first reading there is nothing to debounce against - apply it now
    // rather than making a fresh install wait a poll cycle for its accessories.
    if (!this.firstReconcileDone) {
      this.pendingServiceChange[kind] = null;
      this.log.info(`${SERVICE_LABELS[kind]} ${desired ? 'detected, adding accessory' : 'not present, no accessory added'}`);
      apply(desired);
      return;
    }
    
    if (!pending || pending.desired !== desired) {
      this.pendingServiceChange[kind] = { desired: desired, count: 1 };
      return;
    }
    
    pending.count++;
    
    if (pending.count >= 2) {
      this.pendingServiceChange[kind] = null;
      this.log.info(`${SERVICE_LABELS[kind]} ${desired ? 'detected, adding accessory' : 'no longer present, removing accessory'}`);
      apply(desired);
    }
  }
  
  reconcileServices(status) {
    const signature = () => `${this.hasLightService()}|${this.hasBatteryService()}|${this.hasLightSensorService()}`;
    const before = signature();
    
    this.reconcileService('light', this.desiredLight(status),
      () => this.hasLightService(), (v) => this.applyLightService(v));
    this.reconcileService('battery', this.desiredBattery(status),
      () => this.hasBatteryService(), (v) => this.applyBatteryService(v));
    this.reconcileService('lightSensor', this.desiredLightSensor(status),
      () => this.hasLightSensorService(), (v) => this.applyLightSensorService(v));
    
    this.firstReconcileDone = true;
    
    if (before !== signature()) {
      // Without this the added or removed service is not published, and the tile
      // only appears (or disappears) after the next Homebridge restart.
      this.platform.api.updatePlatformAccessories([this.accessory]);
    }
  }
  
  // light level sensor
  
  lightLevel(status = this.cachedStatus) {
    const raw = status?.state?.door?.lightLevel;
    
    if (raw === undefined || raw === null || raw === '') {
      return null;
    }
    
    const level = Number(raw);
    return Number.isFinite(level) ? Math.max(0, level) : null;
  }
  
  hasLightSensorService() {
    return !!this.accessory.getService(hap.Service.LightSensor);
  }
  
  // Opt-in only, and only when the door actually reports a reading.
  desiredLightSensor(status) {
    return this.settings.enableLightSensor && this.lightLevel(status) !== null;
  }
  
  // What is published is Omlet's own 0-100 scale, under a characteristic HomeKit
  // defines in lux. That mismatch is deliberate and the option is off by default:
  // the value saturates at 100 for most of the day and carries real information only
  // around dawn and dusk, so it is useful for watching the light change rather than
  // for reading an illuminance. docs/ROADMAP.md has the sampled data behind that.
  applyLightSensorService(enabled) {
    const existing = this.accessory.getService(hap.Service.LightSensor);
    
    if (!enabled) {
      if (existing) {
        this.doorService.removeLinkedService(existing);
        this.accessory.removeService(existing);
      }
      this.lightSensorService = null;
      return;
    }
    
    const service = existing || this.accessory.addService(hap.Service.LightSensor);
    service.setCharacteristic(hap.Characteristic.Name, 'Coop Light Level');
    service
      .getCharacteristic(hap.Characteristic.CurrentAmbientLightLevel)
      .onGet(this.getAmbientLight.bind(this));
    this.doorService.addLinkedService(service);
    this.lightSensorService = service;
    
    this.log.info('Light level sensor enabled');
  }
  
  async getAmbientLight() {
    const level = this.lightLevel();
    
    if (level === null) {
      throw unavailable();
    }
    
    return Math.max(MIN_AMBIENT_LIGHT, level);
  }
  
  pushLightLevelToHomeKit(status) {
    const level = this.lightLevel(status);
    
    if (this.lightSensorService && level !== null) {
      this.lightSensorService
        .getCharacteristic(hap.Characteristic.CurrentAmbientLightLevel)
        .updateValue(Math.max(MIN_AMBIENT_LIGHT, level));
    }
  }
  
  // light
  
  async getLightOn() {
    const lightState = this.cachedStatus?.state?.light?.state;
    
    if (!lightState) {
      throw unavailable();
    }
    
    return (lightState === 'on' || lightState === 'onpending');
  }
  
  // A command the coop cannot service is accepted by the API - the state flips to
  // "*pending" - and then dropped by the device. The pending state does not resolve;
  // Omlet's own service can take an hour to clear it.
  //
  // The fix is the OPPOSITE command, never a retry. A dropped "on" means the light
  // never came on, so "off" makes the reported state true again, and clears the jam
  // in about three seconds. Re-sending the same command would itself be a redundant
  // command, which is the thing that causes this in the first place.
  async recoverStuck(kind) {
    const spec = STUCK_RECOVERY[kind];
    const state = this.cachedStatus?.state?.[spec.section]?.state;
    
    if (!spec.stuckStates.includes(state)) {
      this.recoveryAttempted[kind] = false;
      return false;
    }
    
    // One attempt per stuck episode - never a loop.
    if (this.recoveryAttempted[kind]) {
      return false;
    }
    
    this.recoveryAttempted[kind] = true;
    
    const action = spec.oppositeOf(state);
    const original = spec.intentOf(state);
    const intent = this.intents[kind];
    
    // Only re-apply our own command, and only once. Re-applying a pending state we
    // did not cause would act on somebody else's intention.
    const shouldReapply = intent && intent.action === original && !intent.reapplied;
    
    this.log.warn(`[${spec.label}] ${spec.label} stuck in ${state} state, forcing a ${kind} ${action} command to resolve`);
    
    try {
      await this.sendAction(action, spec.label);
      
      if (shouldReapply) {
        intent.reapplied = true;
        this.reapply[kind] = original;
      }
      
      this.setCachedState(spec.section, null);
      this.platform.schedulePoll(FAST_POLL_MS);
      return true;
    } catch (error) {
      this.log.error(`[${spec.label}] Could not settle the stuck state:`, error.message);
      return false;
    }
  }
  
  // Sends the original command again once the stuck state has cleared.
  async maybeReapply(kind) {
    const spec = STUCK_RECOVERY[kind];
    
    if (!this.reapply[kind]) {
      return;
    }
    
    const state = this.cachedStatus?.state?.[spec.section]?.state;
    
    // Wait for the forced command to finish before acting again.
    if (spec.stuckStates.includes(state) || DOOR_TRANSITION_STATES.includes(state)) {
      return;
    }
    
    const action = this.reapply[kind];
    this.reapply[kind] = null;
    
    // It may already be where the user wanted it.
    if (spec.settledMatches(action, state)) {
      return;
    }
    
    this.log.info(`[${spec.label}] Re-applying ${action} now the ${kind} has unstuck`);
    
    try {
      await this.sendAction(action, spec.label);
      this.platform.schedulePoll(FAST_POLL_MS);
    } catch (error) {
      this.log.error(`[${spec.label}] Could not re-apply the command:`, error.message);
    }
  }
  
  async setLightOn(value) {
    const action = value ? 'on' : 'off';
    
    // Same guard as the door: a command putting the light into the state it is
    // already in can leave the coop stuck in "*pending". Read fresh rather than
    // trusting the cache, which can be a poll interval out of date.
    let lightState = null;
    
    try {
      const status = await this.pollDeviceState();
      lightState = status?.state?.light?.state ?? null;
    } catch (error) {
      lightState = this.cachedStatus?.state?.light?.state ?? null;
      
      if (this.debug) {
        this.log.warn(`[Light] Could not refresh state before ${action}, using last known state: ${lightState ?? 'unknown'}`);
      }
    }
    
    const alreadyThere = value
      ? LIGHT_ON_STATES.includes(lightState)
      : LIGHT_OFF_STATES.includes(lightState);
    
    if (alreadyThere) {
      this.log.info(`[Light] Received request to turn the light ${value ? 'on' : 'off'}, but it is already ${value ? 'on' : 'off'}`);
      
      if (this.lightService) {
        this.lightService.getCharacteristic(hap.Characteristic.On).updateValue(value);
      }
      
      return;
    }
    
    try {
      await this.sendAction(action, 'Light');
      this.log.info('[Light]', action === 'on' ? 'Turning on light' : 'Turning off light');
      
      this.intents.light = { action: action, reapplied: false };
      this.setCachedState('light', value ? 'onpending' : 'offpending');
      
      if (this.lightService) {
        this.lightService.getCharacteristic(hap.Characteristic.On).updateValue(value);
      }
      
      // Drop to the fast cadence so the change is reflected promptly.
      this.platform.schedulePoll(FAST_POLL_MS);
      
    } catch (error) {
      this.log.error('[Light] Failed to set light state:', error.message);
      
      if (error.statusCode === 401 || error.statusCode === 403) {
        const refreshed = await this.platform.handleAuthError();
        if (refreshed) {
          try {
            await this.sendAction(action, 'Light');
            this.log.info('[Light]', action === 'on' ? 'Turning on light' : 'Turning off light', '(after token refresh)');
            return;
          } catch (retryError) {
            this.log.error('[Light] Retry after token refresh also failed');
          }
        }
      }
      
      throw new Error('Failed to set light state');
    }
  }
  
  // battery
  
  async getBatteryLevel() {
    const batteryLevel = this.cachedStatus?.state?.general?.batteryLevel;
    
    if (batteryLevel === undefined || batteryLevel === null) {
      throw unavailable();
    }
    
    return batteryLevel;
  }
  
  async getStatusLowBattery() {
    const batteryLevel = this.cachedStatus?.state?.general?.batteryLevel;
    
    if (batteryLevel === undefined || batteryLevel === null) {
      throw unavailable();
    }
    
    return (batteryLevel < 20) ? 1 : 0;
  }
  
  sendAction(action, context = 'Action') {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({});
      const token = this.platform.getCurrentToken();
      
      if (!token) {
        reject(new Error('No auth token available'));
        return;
      }
      
      const options = {
        hostname: this.baseUrl,
        port: 443,
        path: `/api/v1/device/${this.deviceId}/action/${action}`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Accept': 'application/json'
        },
        timeout: 10000
      };
      
      if (this.debug) {
        this.log.info(`[${context}] POST`, options.path);
      }
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (this.debug) {
            this.log.info(`[${context}] Response status:`, res.statusCode);
            if (data) {
              this.log.info(`[${context}] Response body:`, data);
            }
          }
          
          if (res.statusCode === 200 || res.statusCode === 204) {
            resolve();
          } else {
            this.log.error(`[${context}] HTTP Error`, res.statusCode, data || '');
            
            // A command is user-initiated, so its failure is always reported - but a
            // server fault still counts towards the shared back-off.
            if (![401, 403, 404].includes(res.statusCode)) {
              this.platform.noteFailure('server', context, null);
            }
            
            const error = new Error(`HTTP ${res.statusCode}`);
            error.statusCode = res.statusCode;
            error.response = data;
            reject(error);
          }
        });
      });
      
      let timedOut = false;
      
      req.on('timeout', () => {
        timedOut = true;
        req.destroy();
        this.platform.noteFailure('transport', context, 'Request timeout after 10 seconds');
        reject(new Error('Request timeout'));
      });
      
      req.on('error', (error) => {
        // destroy() from the timeout above also emits 'error'. Reporting both turned
        // a single failed request into two error lines.
        if (timedOut) {
          return;
        }
        
        this.platform.noteFailure('transport', context, `Network error: ${error.message}`);
        reject(error);
      });
      
      req.write(postData);
      req.end();
    });
  }
  
  getDeviceStatus(context = 'Status') {
    return new Promise((resolve, reject) => {
      const token = this.platform.getCurrentToken();
      
      if (!token) {
        reject(new Error('No auth token available'));
        return;
      }
      
      const options = {
        hostname: this.baseUrl,
        port: 443,
        path: `/api/v1/device/${this.deviceId}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        },
        timeout: 10000
      };
      
      if (this.debug) {
        this.log.info(`[${context}] GET`, options.path);
      }

      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (this.debug) {
            this.log.info(`[${context}] Response status:`, res.statusCode);
          }
          
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              if (this.debug) {
                this.log.info(`[${context}] Full response:`, JSON.stringify(json, null, 2));
              }
              resolve(json);
            } catch (error) {
              this.log.error(`[${context}] Failed to parse JSON:`, error.message);
              this.log.error(`[${context}] Response was:`, data);
              reject(new Error('Failed to parse JSON response'));
            }
          } else {
            // 401/403 are reported by handleAuthError and 404 by handleDeviceNotFound,
            // both of which have their own handling - neither is a server fault.
            // Anything else is, and backs off rather than repeating every poll.
            if (res.statusCode === 401 || res.statusCode === 403) {
              if (this.debug) {
                this.log.error(`[${context}] HTTP Error`, res.statusCode, data || '');
              }
            } else if (res.statusCode === 404) {
              if (this.debug) {
                this.log.error(`[${context}] HTTP Error`, res.statusCode, data || '');
              }
            } else {
              this.platform.noteFailure('server', context, `HTTP ${res.statusCode} ${data || ''}`.trim());
            }
            const error = new Error(`HTTP ${res.statusCode}`);
            error.statusCode = res.statusCode;
            error.response = data;
            reject(error);
          }
        });
      });
      
      let timedOut = false;
      
      req.on('timeout', () => {
        timedOut = true;
        req.destroy();
        this.platform.noteFailure('transport', context, 'Request timeout after 10 seconds');
        reject(new Error('Request timeout'));
      });
      
      req.on('error', (error) => {
        // destroy() from the timeout above also emits 'error'. Reporting both turned
        // a single failed request into two error lines.
        if (timedOut) {
          return;
        }
        
        this.platform.noteFailure('transport', context, `Network error: ${error.message}`);
        reject(error);
      });
      
      req.end();
    });
  }
  
  // door
  
  async getCurrentDoorState() {
    const doorState = this.cachedStatus?.state?.door?.state;
    
    if (!doorState) {
      throw unavailable();
    }
    
    return mapDoorState(doorState);
  }
  
  async getTargetDoorState() {
    const doorState = this.cachedStatus?.state?.door?.state;
    
    if (!doorState) {
      throw unavailable();
    }
    
    return DOOR_OPEN_STATES.includes(doorState)
      ? hap.Characteristic.TargetDoorState.OPEN
      : hap.Characteristic.TargetDoorState.CLOSED;
  }
  
  async setTargetDoorState(value) {
    const wantOpen = (value === hap.Characteristic.TargetDoorState.OPEN);
    const action = wantOpen ? 'open' : 'close';
    
    // Telling the Omlet API to open an already-open door (or close an already-closed
    // one) upsets the server, so never send a redundant command. A person tapping the
    // tile in the Home app cannot cause this because the tile shows the real state,
    // but a scheduled automation - "open at sunrise" - fires regardless of state and
    // hits it every single day.
    //
    // Deliberately a fresh read rather than the cache: acting on a stale cache is
    // wrong in both directions - a redundant command if it says closed when the door
    // is open, or a door that never opens if it says open when the door is shut.
    let doorState = null;
    
    try {
      const status = await this.pollDeviceState();
      doorState = status?.state?.door?.state ?? null;
    } catch (error) {
      doorState = this.cachedStatus?.state?.door?.state ?? null;
      
      if (doorState) {
        this.log.warn(`[Door] Could not refresh state before ${action}, using last known state: ${doorState}`);
      } else {
        this.log.warn(`[Door] Could not determine door state before ${action}, sending anyway`);
      }
    }
    
    const alreadyThere = wantOpen
      ? DOOR_OPEN_STATES.includes(doorState)
      : DOOR_CLOSED_STATES.includes(doorState);
    
    if (alreadyThere) {
      this.log.info(`[Door] Received request to ${wantOpen ? 'open' : 'close'} the door, but it is already ${wantOpen ? 'open' : 'closed'}`);
      
      // Report the real state back. From HomeKit's point of view the request
      // succeeded - the door is where it was asked to be.
      const currentState = mapDoorState(doorState);
      
      this.doorService
        .getCharacteristic(hap.Characteristic.CurrentDoorState)
        .updateValue(currentState);
      
      this.doorService
        .getCharacteristic(hap.Characteristic.TargetDoorState)
        .updateValue(value);
      
      return;
    }
    
    try {
      await this.sendAction(action, 'Door');
      this.log.info('[Door]', action === 'open' ? 'Opening door' : 'Closing door');
      
      this.intents.door = { action: action, reapplied: false };
      this.setCachedState('door', wantOpen ? 'openpending' : 'closepending');
      
      const newCurrentState = wantOpen
        ? hap.Characteristic.CurrentDoorState.OPENING
        : hap.Characteristic.CurrentDoorState.CLOSING;
      
      this.doorService
        .getCharacteristic(hap.Characteristic.CurrentDoorState)
        .updateValue(newCurrentState);
      
      // Drop to the fast cadence. The loop stays fast until the door settles, so a
      // stiff or obstructed track that takes longer than usual is still tracked.
      this.platform.schedulePoll(FAST_POLL_MS);
        
    } catch (error) {
      this.log.error('[Door] Failed to set door state:', error.message);
      
      if (error.statusCode === 401 || error.statusCode === 403) {
        const refreshed = await this.platform.handleAuthError();
        if (refreshed) {
          try {
            await this.sendAction(action, 'Door');
            this.log.info('[Door]', action === 'open' ? 'Opening door' : 'Closing door', '(after token refresh)');
            
            const newCurrentState = (action === 'open') 
              ? hap.Characteristic.CurrentDoorState.OPENING
              : hap.Characteristic.CurrentDoorState.CLOSING;
            
            this.doorService
              .getCharacteristic(hap.Characteristic.CurrentDoorState)
              .updateValue(newCurrentState);
            
            return;
          } catch (retryError) {
            this.log.error('[Door] Retry after token refresh also failed');
          }
        }
      }
      
      throw new Error('Failed to set door state');
    }
  }
  
  // polling
  
  // Everything that must happen after a poll succeeds, whatever route got us
  // there. Keeping this in one place matters: the retry-after-recovery paths used
  // to skip it, so a credential that only worked on the second attempt never got
  // marked as verified and config.json was never cleaned up.
  async handlePollSuccess(status) {
    this.cachedStatus = status;
    this.platform.noteSuccess();
    this.platform.credentialVerified = true;
    
    await this.platform.settleCredentials();
    this.platform.migrateTriState(status);
    this.reconcileServices(status);
    await this.maybeReapply('door');
    await this.maybeReapply('light');

    // update serial and firmware from the first real response
    if (!this.accessoryInfoUpdated) {
      const deviceSerial = status.deviceSerial || this.deviceId;
      
      // deviceSerial is the device's wifi MAC address - confirmed against DHCP leases -
      // so it is burned into the hardware and survives a factory reset. deviceId is a
      // cloud registration that is reissued by one. Recording the serial is what lets
      // a reset coop be identified later as the same physical door.
      if (status.deviceSerial && this.accessory.context.deviceSerial !== status.deviceSerial) {
        this.accessory.context.deviceSerial = status.deviceSerial;
        this.platform.api.updatePlatformAccessories([this.accessory]);
      }
      const firmware = status.state?.general?.firmwareVersionCurrent || '0.0.0';
      this.accessory.getService(hap.Service.AccessoryInformation)
        .setCharacteristic(hap.Characteristic.SerialNumber, deviceSerial)
        .setCharacteristic(hap.Characteristic.FirmwareRevision, firmware);
      if (this.debug) {
        this.log.info('[Info] Updated accessory info: Serial=' + deviceSerial + ', Firmware=' + firmware);
      }
      this.accessoryInfoUpdated = true;
    }

    return status;
  }

  async pollDeviceState() {
    try {
      return await this.handlePollSuccess(await this.getDeviceStatus('Poll'));
    } catch (error) {
      // A 404 here means this door is gone from the account. Discovery notices on
      // the next poll and reconciles identity there; nothing to do but report it.
      if (error.statusCode === 404) {
        throw error;
      }
      
      if (error.statusCode === 401 || error.statusCode === 403) {
        const refreshed = await this.platform.handleAuthError();
        
        if (refreshed) {
          try {
            return await this.handlePollSuccess(await this.getDeviceStatus('Poll'));
          } catch (retryError) {
            this.log.error('[Poll] Retry after token refresh failed:', retryError.message);
            throw retryError;
          }
        }
      }
      
      if (this.debug) {
        this.log.warn('[Poll] Failed to get device status:', error.message);
      }
      
      throw error;
    }
  }

  pushStateToHomeKit() {
    try {
      const status = this.cachedStatus;
      if (!status) return;

      // Door state
      const doorState = status.state?.door?.state;
      if (doorState) {
        const currentState = mapDoorState(doorState);
        this.doorService.getCharacteristic(hap.Characteristic.CurrentDoorState).updateValue(currentState);

        const targetState = DOOR_OPEN_STATES.includes(doorState)
          ? hap.Characteristic.TargetDoorState.OPEN
          : hap.Characteristic.TargetDoorState.CLOSED;
        this.doorService.getCharacteristic(hap.Characteristic.TargetDoorState).updateValue(targetState);

        if (!STUCK_RECOVERY.door.stuckStates.includes(doorState)) {
          this.recoveryAttempted.door = false;
          
          if (this.intents.door && STUCK_RECOVERY.door.settledMatches(this.intents.door.action, doorState)) {
            this.intents.door = null;
          }
        }
        
        if (this.debug) {
          this.log.info('[Poll] Door:', doorState, '-> HomeKit:', currentState);
        }
      }
      
      const fault = status.state?.door?.fault;
      if (fault !== undefined) {
        this.noteDoorFault(fault);
        this.doorService
          .getCharacteristic(hap.Characteristic.ObstructionDetected)
          .updateValue(fault === DOOR_FAULT_BLOCKED);
      }

      // Light state
      if (this.lightService) {
        const lightState = status.state?.light?.state;
        if (lightState !== undefined) {
          const isOn = (lightState === 'on' || lightState === 'onpending');
          this.lightService.getCharacteristic(hap.Characteristic.On).updateValue(isOn);
          
          if (!LIGHT_TRANSITION_STATES.includes(lightState)) {
            this.recoveryAttempted.light = false;
            
            if (this.intents.light && (this.intents.light.action === 'on') === (lightState === 'on')) {
              this.intents.light = null;
            }
          }
          if (this.debug) {
            this.log.info('[Poll] Light:', lightState, '-> isOn:', isOn);
          }
        }
      }

      // Battery state
      if (this.batteryService) {
        const batteryLevel = status.state?.general?.batteryLevel;
        if (batteryLevel !== undefined && batteryLevel !== null) {
          this.batteryService.getCharacteristic(hap.Characteristic.BatteryLevel).updateValue(batteryLevel);
          const isLow = (batteryLevel < 20) ? 1 : 0;
          this.batteryService.getCharacteristic(hap.Characteristic.StatusLowBattery).updateValue(isLow);
          if (this.debug) {
            this.log.info('[Poll] Battery:', batteryLevel + '%, low:', isLow);
          }
        }
      }
      
      this.pushLightLevelToHomeKit(status);
    } catch (error) {
      this.log.error('[Poll] Failed to push state to HomeKit:', error.message);
    }
  }

  stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // Point this accessory at a new registration of the same hardware: update what we
  // poll, what the accessory remembers, and the platform's handler key, which is the
  // old device ID until we move it.
  retarget(device) {
    const previous = this.deviceId;
    
    this.deviceId = device.deviceId;
    this.device = device;
    this.name = device.name || this.name;
    this.accessoryInfoUpdated = false;
    this.settings = this.platform.deviceSettings(device);
    
    this.accessory.context.deviceId = device.deviceId;
    
    if (device.serial) {
      this.accessory.context.deviceSerial = device.serial;
    }
    
    this.platform.api.updatePlatformAccessories([this.accessory]);
    
    if (this.platform.handlers.get(previous) === this) {
      this.platform.handlers.delete(previous);
    }
    
    this.platform.handlers.set(device.deviceId, this);
  }
  
  // Discovery saw this device again. The name can change in the Omlet app; the
  // HomeKit accessory keeps whatever the user called it, so only our own label moves.
  noteSeen(device) {
    this.device = device;
    this.name = device.name || this.name;
    
    if (device.serial && this.accessory.context.deviceSerial !== device.serial) {
      this.accessory.context.deviceSerial = device.serial;
      this.platform.api.updatePlatformAccessories([this.accessory]);
    }
  }
  
  // Bumping the generation is what stops a poll that is already in flight from
  // scheduling a successor once it finishes - clearing the timer alone would not.
  destroy() {
    this.destroyed = true;
    this.pollGeneration++;
    this.stopPolling();
  }

  isTransitioning() {
    const doorState = this.cachedStatus?.state?.door?.state;
    const lightState = this.cachedStatus?.state?.light?.state;
    
    return DOOR_TRANSITION_STATES.includes(doorState)
      || LIGHT_TRANSITION_STATES.includes(lightState);
  }

  // A single self-rescheduling timer rather than a fixed interval, for two reasons:
  // a slow cycle (timeout -> re-login -> retry) can outlast the interval and stack
  // overlapping polls, and a separate transition watcher would double up on requests
  // against a backend that only refreshes every ~600s anyway.
  //
  // The generation counter is what makes it safe: if something reschedules while a
  // poll is already in flight, that poll finds its generation stale and declines to
  // schedule a successor, so exactly one chain survives.
  // Handed a device object by the platform's poll. Everything the per-device poll
  // used to do on success, minus the fetching - one /api/v1/group call serves every
  // door, so a handler no longer owns a timer.
  async acceptStatus(device) {
    this.device = device;
    this.name = device.name || this.name;
    
    try {
      await this.handlePollSuccess(device.status || device);
      this.pushStateToHomeKit();
    } catch (error) {
      if (this.debug) {
        this.log.warn(`[Poll] ${this.name}: could not apply status:`, error.message);
      }
    }
  }
  
  reportStuck() {
    const doorState = this.cachedStatus?.state?.door?.state ?? 'unknown';
    const lightState = this.cachedStatus?.state?.light?.state ?? 'unknown';
    const stuck = [];
    
    if (DOOR_TRANSITION_STATES.includes(doorState)) {
      stuck.push(`door: ${doorState}`);
    }
    
    if (LIGHT_TRANSITION_STATES.includes(lightState)) {
      stuck.push(`light: ${lightState}`);
    }
    
    this.log.warn(`[Poll] ${this.name} still mid-change after ${Math.round(MAX_FAST_POLLS * FAST_POLL_MS / 1000)}s (${stuck.join(', ') || `door: ${doorState}, light: ${lightState}`}), returning to normal polling`);
  }
}
