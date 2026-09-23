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
    this.authFailedPermanently = false;
    this.reloginAttempts = 0;
    this.maxReloginAttempts = 3;
    this.authFailures = 0;
    
    this.accessories = [];
    
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
      this.log.error(`Invalid ${fieldName}: must be 1-128 characters, letters, digits, underscore or hyphen`);
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
      this.log.info('Credentials moved out of config.json into Homebridge storage');
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
      const parts = Object.keys(next).map(key => `${key}: ${next[key]}`);
      this.log.info(`Migrated settings to the new Auto options (${parts.join(', ')})`);
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
      
      if (!this.deviceId) {
        this.log.info('Discovering device ID');
        await this.autoDiscoverDevice();
      }
      
      if (!this.deviceId) {
        if (!this.authFailedDiscovery) {
          this.log.error('No device ID found! Please ensure your coop door is connected to your Omlet account and try again.');
        }
        
        return;
      }
      
      // Discovery succeeding is proof the credential works, so clean config.json now
      // rather than after the first poll - the settings UI cannot reliably delete a
      // key, so this is the mechanism users actually depend on.
      await this.settleCredentials();
      
      await this.discoverDevices();
      
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
  
  async autoDiscoverDevice(isRetry = false) {
    try {
      this.log.info('Discovering devices on your account...');
      
      const devices = await this.discoverAllDevices();
      this.credentialVerified = true;
      
      if (devices.length === 0) {
        this.log.warn('No devices found on your account');
        return;
      }
      
      if (devices.length === 1) {
        this.deviceId = devices[0].deviceId;
        await this.saveStoredCredentials();
        this.log.info('✓ Auto-discovered device:', devices[0].name, '(', this.deviceId, ')');
      } else {
        this.log.warn('Multiple devices found on your account:');
        devices.forEach((device, index) => {
          this.log.warn(`  ${index + 1}. ${device.name} (${device.deviceId})`);
        });
        this.log.warn('→ Please add one to your config.json: "deviceId": "DEVICE_ID_HERE"');
      }
      
    } catch (error) {
      // Discovery runs before any polling, so this is the first place a bad
      // credential shows up. Without this, a rejected key from config.json stops
      // setup dead: no device, no polling, and therefore no chance to fall back to
      // the working credential in storage or to clean config.json up afterwards.
      if (!isRetry && (error.statusCode === 401 || error.statusCode === 403)) {
        const recovered = await this.handleAuthError();
        
        if (recovered) {
          return this.autoDiscoverDevice(true);
        }
      }
      
      // Point at the actual cause. "Check your coop is connected" sends someone to
      // the wrong place entirely when the real problem is a rejected credential.
      if (error.statusCode === 401 || error.statusCode === 403) {
        this.authFailedDiscovery = true;
        this.log.error('Could not sign in to Omlet. Open the Omlet Coop plugin settings and log in again.');
        return;
      }
      
      this.log.error('Device discovery failed:', error.message);
    }
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
                      name: device.name || 'Omlet Device',
                      type: device.deviceType || 'unknown'
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
            const error = new Error(`HTTP ${res.statusCode}`);
            error.statusCode = res.statusCode;
            reject(error);
          }
        });
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      req.end();
    });
  }
  
  async handleAuthError() {
    // If auth already failed 3 times, don't retry - just show "No Response" in HomeKit
    if (this.authFailedPermanently) {
      throw new Error('Authentication permanently failed - restart Homebridge after fixing credentials');
    }

    // A credential from config.json that does not work must never block a working
    // one in storage - otherwise a typo'd key jams the plugin permanently, because
    // config is only cleaned up after a successful poll.
    if (this.storedToken && this.currentToken !== this.storedToken) {
      this.log.warn('The API key in config.json was rejected; falling back to the saved credential');
      this.bearerToken = this.storedToken;
      this.currentToken = this.storedToken;
      this.authFailures = 0;
      return true;
    }
    
    // No password is persisted, so a dead key cannot be refreshed automatically.
    // It may have been revoked in the developer console, or the login session behind
    // it may have ended - the plugin cannot tell which, so cover both. A couple of
    // failures could still be a server blip, so give it a few tries before giving up.
    if (!this.email || !this.password) {
      this.authFailures++;
      
      if (this.authFailures < this.maxReloginAttempts) {
        if (this.debug) {
          this.log.warn(`Authentication failed (${this.authFailures}/${this.maxReloginAttempts}), will retry`);
        }
        return false;
      }
      
      this.log.error('Saved API key is no longer valid. Open the Omlet Coop plugin settings and log in again, or paste a new developer API key.');
      this.authFailedPermanently = true;
      return false;
    }
    
    this.reloginAttempts++;
    this.log.warn(`Authentication error detected, attempting to re-login (attempt ${this.reloginAttempts}/${this.maxReloginAttempts})...`);
    
    try {
      await this.login();
      this.log.info('Re-login successful');
      
      // Reset counter on success
      this.reloginAttempts = 0;
      
      return true;
    } catch (error) {
      this.log.error('Failed to re-login:', error.message);
      
      if (this.reloginAttempts >= this.maxReloginAttempts) {
        this.log.error(`Re-login failed ${this.maxReloginAttempts} times. Accessory will show "No Response" until Homebridge is restarted with valid credentials.`);
        this.authFailedPermanently = true;
      } else {
        this.log.warn(`Will retry on next operation (${this.maxReloginAttempts - this.reloginAttempts} attempts remaining)`);
      }
      
      return false;
    }
  }
  
  removeAllAccessories() {
    if (this.accessories.length > 0) {
      this.log.info(`Disconnected: removing ${this.accessories.length} accessory(s) from HomeKit`);
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
  
  async discoverDevices() {
    this.log.info('Setting up Homebridge accessories...');
    
    const uuid = this.api.hap.uuid.generate('omlet-coop-' + this.deviceId);
    let accessory = this.accessories.find(item => item.UUID === uuid);
    
    // If the coop was replaced it has a new device ID, and therefore a new UUID.
    // Do NOT unregister and re-register in that case: that destroys the HomeKit
    // accessory and takes the user's room, name, automations and scenes with it.
    // Adopt the accessory we already have and quietly point it at the new device -
    // the UUID becomes historical, which costs nothing.
    if (!accessory && this.accessories.length > 0) {
      accessory = this.accessories[0];
      this.log.info('Device ID changed; keeping the existing HomeKit accessory and pointing it at the new device');
    }
    
    // Only genuine duplicates get removed - never the one in use.
    const extras = this.accessories.filter(item => item !== accessory);
    
    if (extras.length > 0) {
      extras.forEach(item => this.log.warn('Removing duplicate accessory:', item.displayName));
      this.api.unregisterPlatformAccessories('homebridge-omlet', 'OmletCoop', extras);
      this.accessories = this.accessories.filter(item => item === accessory);
    }
    
    if (accessory) {
      new OmletCoopAccessory(this, accessory);
      return;
    }
    
    this.log.info('Adding new accessory: Omlet Coop');
    const coopAccessory = new this.api.platformAccessory('Omlet Coop', uuid);
    new OmletCoopAccessory(this, coopAccessory);
    this.api.registerPlatformAccessories('homebridge-omlet', 'OmletCoop', [coopAccessory]);
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
  constructor(platform, accessory) {
    this.platform = platform;
    this.accessory = accessory;
    this.log = platform.log;
    
    this.deviceId = platform.deviceId;
    this.baseUrl = platform.baseUrl;
    this.pollInterval = platform.pollInterval;

    this.debug = platform.debug;
    
    this.accessoryInfoUpdated = false;
    this.cachedStatus = null;
    this.pollTimer = null;
    this.pollGeneration = 0;
    this.fastPollCount = 0;
    this.pendingServiceChange = { light: null, battery: null };
    this.firstReconcileDone = false;
    this.lastFault = null;
    this.pollingHalted = false;
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
    this.applyLightService(platform.enableLight === 'auto' ? this.hasLightService() : platform.enableLight);
    this.applyBatteryService(platform.enableBattery === 'auto' ? this.hasBatteryService() : platform.enableBattery);
    
    this.log.info(`Coop accessory initialized (light: ${this.describePref(platform.enableLight)}, battery: ${this.describePref(platform.enableBattery)})`);
    
    this.startPolling();
  }
  
  // Read-only status: HomeKit cannot use this to block the door control, and we
  // would not want it to. It self-clears - the fault drops back to "none" within a
  // few seconds of the next close attempt, including the door's own dusk close.
  getObstructionDetected() {
    return this.cachedStatus?.state?.door?.fault === DOOR_FAULT_BLOCKED;
  }
  
  // Faults we do not recognise are surfaced once each, rather than silently ignored
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
    
    this.log.warn(`[Door] Door reported an unrecognised fault: "${fault}". Please report this at https://github.com/cantcodewontcode/homebridge-omlet-coop/issues`);
  }
  
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
    if (this.platform.enableLight !== 'auto') {
      return this.platform.enableLight;
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
      if (this.platform.enableBattery === true && !this.batteryOverrideRefused) {
        this.batteryOverrideRefused = true;
        this.log.warn('Battery Status is set to "Always on", but this door reports mains power with no batteries fitted, so no battery accessory is shown.');
      }
      return false;
    }
    
    if (this.platform.enableBattery !== 'auto') {
      return this.platform.enableBattery;
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
      this.log.info(`${kind === 'light' ? 'Coop light' : 'Battery'} ${desired ? 'detected, adding accessory' : 'not present, no accessory added'}`);
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
      this.log.info(`${kind === 'light' ? 'Coop light' : 'Battery'} ${desired ? 'detected, adding accessory' : 'no longer present, removing accessory'}`);
      apply(desired);
    }
  }
  
  reconcileServices(status) {
    const before = `${this.hasLightService()}|${this.hasBatteryService()}`;
    
    this.reconcileService('light', this.desiredLight(status),
      () => this.hasLightService(), (v) => this.applyLightService(v));
    this.reconcileService('battery', this.desiredBattery(status),
      () => this.hasBatteryService(), (v) => this.applyBatteryService(v));
    
    this.firstReconcileDone = true;
    
    if (before !== `${this.hasLightService()}|${this.hasBatteryService()}`) {
      // Without this the added or removed service is not published, and the tile
      // only appears (or disappears) after the next Homebridge restart.
      this.platform.api.updatePlatformAccessories([this.accessory]);
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
      this.scheduleNextPoll(FAST_POLL_MS);
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
      this.scheduleNextPoll(FAST_POLL_MS);
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
      this.log.info(`[Light] Light is already ${value ? 'on' : 'off'}`);
      
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
      this.scheduleNextPoll(FAST_POLL_MS);
      
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
            const error = new Error(`HTTP ${res.statusCode}`);
            error.statusCode = res.statusCode;
            error.response = data;
            reject(error);
          }
        });
      });
      
      req.on('timeout', () => {
        req.destroy();
        this.log.error(`[${context}] Request timeout after 10 seconds`);
        reject(new Error('Request timeout'));
      });
      
      req.on('error', (error) => {
        this.log.error(`[${context}] Network error:`, error.message);
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
            const isAuthError = (res.statusCode === 401 || res.statusCode === 403);
            
            // Auth failures are reported once, in context, by handleAuthError -
            // repeating the same 401 every cycle is noise. Everything else is a
            // real problem and must not be swallowed.
            if (this.debug || !isAuthError) {
              this.log.error(`[${context}] HTTP Error`, res.statusCode, data || '');
            }
            const error = new Error(`HTTP ${res.statusCode}`);
            error.statusCode = res.statusCode;
            error.response = data;
            reject(error);
          }
        });
      });
      
      req.on('timeout', () => {
        req.destroy();
        this.log.error(`[${context}] Request timeout after 10 seconds`);
        reject(new Error('Request timeout'));
      });
      
      req.on('error', (error) => {
        this.log.error(`[${context}] Network error:`, error.message);
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
      this.log.info(`[Door] Door is already ${wantOpen ? 'open' : 'closed'}`);
      
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
      this.scheduleNextPoll(FAST_POLL_MS);
        
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
  
  // A saved deviceId can outlive the device: replacing a coop door issues a new id,
  // and every request then 404s forever against an id that no longer exists.
  async handleDeviceNotFound() {
    if (this.platform.rediscovering) {
      return false;
    }
    
    this.platform.rediscovering = true;
    
    try {
      this.log.warn(`[Device] Saved device ID ${this.deviceId} no longer exists on this account, rediscovering`);
      
      const devices = await this.platform.discoverAllDevices();
      const match = devices.find(device => device.deviceId && device.deviceId !== this.deviceId);
      
      if (!match) {
        this.log.error('[Device] No coop door found on this account. Check the Omlet app, then restart Homebridge.');
        return false;
      }
      
      this.deviceId = match.deviceId;
      this.platform.deviceId = match.deviceId;
      await this.platform.saveStoredCredentials();
      this.accessoryInfoUpdated = false;
      this.log.info(`[Device] Now using "${match.name}" (${match.deviceId})`);
      
      return true;
    } catch (error) {
      this.log.error('[Device] Rediscovery failed:', error.message);
      return false;
    } finally {
      this.platform.rediscovering = false;
    }
  }
  
  // Everything that must happen after a poll succeeds, whatever route got us
  // there. Keeping this in one place matters: the retry-after-recovery paths used
  // to skip it, so a credential that only worked on the second attempt never got
  // marked as verified and config.json was never cleaned up.
  async handlePollSuccess(status) {
    this.cachedStatus = status;
    this.platform.authFailures = 0;
    this.platform.credentialVerified = true;
    
    await this.platform.settleCredentials();
    this.platform.migrateTriState(status);
    this.reconcileServices(status);
    await this.maybeReapply('door');
    await this.maybeReapply('light');

    // update serial and firmware from the first real response
    if (!this.accessoryInfoUpdated) {
      const deviceSerial = status.deviceSerial || this.deviceId;
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
      if (error.statusCode === 404) {
        const found = await this.handleDeviceNotFound();
        
        if (found) {
          return this.handlePollSuccess(await this.getDeviceStatus('Poll'));
        }
        
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
  scheduleNextPoll(delayMs) {
    this.pollGeneration++;
    
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    
    const generation = this.pollGeneration;
    this.pollTimer = setTimeout(() => this.runPoll(generation), delayMs);
  }

  async runPoll(generation) {
    try {
      await this.pollDeviceState();
      this.pushStateToHomeKit();
    } catch (error) {
      if (this.debug) {
        this.log.warn('[Poll] Poll cycle failed:', error.message);
      }
    }
    
    // Superseded while we were in flight - the newer timer owns the chain now.
    if (generation !== this.pollGeneration) {
      return;
    }
    
    // Nothing will change until someone fixes the credentials, so stop asking.
    if (this.platform.authFailedPermanently) {
      if (!this.pollingHalted) {
        this.pollingHalted = true;
        this.log.error('[Poll] Polling stopped. Update your credentials in the plugin settings, then restart Homebridge.');
      }
      this.stopPolling();
      return;
    }
    
    if (this.isTransitioning()) {
      this.fastPollCount++;
      
      if (this.fastPollCount <= MAX_FAST_POLLS) {
        this.scheduleNextPoll(FAST_POLL_MS);
        return;
      }
      
      const doorState = this.cachedStatus?.state?.door?.state ?? 'unknown';
      const lightState = this.cachedStatus?.state?.light?.state ?? 'unknown';
      const stuck = [];
      
      if (DOOR_TRANSITION_STATES.includes(doorState)) {
        stuck.push(`door: ${doorState}`);
      }
      
      if (LIGHT_TRANSITION_STATES.includes(lightState)) {
        stuck.push(`light: ${lightState}`);
      }
      
      this.log.warn(`[Poll] Still mid-change after ${Math.round(MAX_FAST_POLLS * FAST_POLL_MS / 1000)}s (${stuck.join(', ') || `door: ${doorState}, light: ${lightState}`}), returning to normal polling`);
      
      // recoverStuck schedules its own fast poll to confirm the fix; falling
      // through here would immediately overwrite it with the slow one.
      const recovered = (await this.recoverStuck('door')) || (await this.recoverStuck('light'));
      
      this.fastPollCount = 0;
      
      if (recovered) {
        return;
      }
    }
    
    this.fastPollCount = 0;
    this.scheduleNextPoll(this.pollInterval);
  }

  startPolling() {
    this.log.info(`Polling every ${this.pollInterval / 1000}s`);
    this.scheduleNextPoll(0);
  }
}
