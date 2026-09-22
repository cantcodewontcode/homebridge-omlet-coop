const https = require('https');
const fs = require('fs');

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
const FAST_POLL_MS = 5000;
const MAX_FAST_POLLS = 18; // ~90s at 5s, well past the ~16s a healthy door takes

const DOOR_OPEN_STATES = ['open'].concat(DOOR_OPENING_STATES);
const DOOR_CLOSED_STATES = ['closed'].concat(DOOR_CLOSING_STATES);

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
    this.password = config.password;
    this.countryCode = this.validateCountryCode(config.countryCode);
    this.bearerToken = this.validateToken(config.bearerToken, 'bearerToken');
    this.deviceId = this.validateDeviceId(config.deviceId, 'deviceId');
    this.baseUrl = this.validateHostname(config.apiServer) || 'x107.omlet.co.uk';
    this.pollInterval = this.validatePollInterval(config.pollInterval);
    // "auto" (the default, and what an absent setting means) lets the device decide.
    // An explicit true/false is an override and is always obeyed.
    this.enableLight = this.normalizeTriState(config.enableLight, 'enableLight');
    this.enableBattery = this.normalizeTriState(config.enableBattery, 'enableBattery');
    this.debug = config.debug || false;
    
    this.currentToken = null;
    this.authMode = null;
    this.storage = this.api.user.storagePath() + '/omlet-coop-tokens.json';
    this.authFailedPermanently = false;
    this.reloginAttempts = 0;
    this.maxReloginAttempts = 3;
    
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
        
        // config.json is where the settings UI now writes the token, so a token
        // there is the current one. Storage is a fallback for installs that predate
        // that, and for tokens the plugin obtained itself by logging in.
        if (data.bearerToken && !this.bearerToken) {
          const validToken = this.validateToken(data.bearerToken, 'stored bearerToken');
          if (validToken) {
            this.bearerToken = validToken;
            this.log.info('Loaded stored API token');
          } else {
            this.log.warn('Stored API token is invalid, ignoring');
          }
        }
        
        if (data.deviceId) {
          const validDeviceId = this.validateDeviceId(data.deviceId, 'stored deviceId');
          if (validDeviceId) {
            this.deviceId = validDeviceId;
            this.log.info('Loaded stored device ID');
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
      const data = {
        bearerToken: this.bearerToken,
        deviceId: this.deviceId,
        lastUpdated: new Date().toISOString()
      };
      
      fs.writeFileSync(this.storage, JSON.stringify(data, null, 2));
      this.log.info('Saved credentials to storage');
    } catch (error) {
      this.log.error('Failed to save API token and device ID:', error.message);
    }
  }
  
  // Removes a saved password from config.json once we hold a working token.
  // API keys and bearer tokens are deliberately left untouched - only the password
  // goes, because it is the one credential we no longer need to keep.
  scrubConfigPassword() {
    let configPath;
    
    try {
      configPath = this.api.user.configPath();
    } catch (error) {
      return;
    }
    
    try {
      if (!configPath || !fs.existsSync(configPath)) {
        return;
      }
      
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      if (!Array.isArray(config.platforms)) {
        return;
      }
      
      let changed = false;
      
      config.platforms.forEach((block) => {
        if (block && block.platform === 'OmletCoop' && block.password !== undefined) {
          delete block.password;
          changed = true;
        }
      });
      
      if (!changed) {
        return;
      }
      
      // Write via a temp file so an interrupted write cannot truncate config.json
      const tmpPath = configPath + '.omlet-tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 4));
      fs.renameSync(tmpPath, configPath);
      
      this.password = undefined;
      this.log.info('Removed the saved password from config.json - the stored token is used instead');
      
    } catch (error) {
      this.log.warn('Could not remove the saved password from config.json:', error.message);
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
        this.log.error('Not configured. Open the Omlet Coop plugin settings and log in.');
        return;
      }
      
      // Only once authentication has succeeded, so a failed login never strands
      // the user with no password and no token.
      if (this.password) {
        this.scrubConfigPassword();
      }
      
      if (!this.deviceId) {
        this.log.info('Discovering device ID');
        await this.autoDiscoverDevice();
      }
      
      if (!this.deviceId) {
        this.log.error('No device ID found! Please ensure your coop door is connected to your Omlet account and try again.');
        return;
      }
      
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
  
  async autoDiscoverDevice() {
    try {
      this.log.info('Discovering devices on your account...');
      
      const devices = await this.discoverAllDevices();
      
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
            reject(new Error(`HTTP ${res.statusCode}`));
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

    // No password is persisted, so a dead key cannot be refreshed automatically.
    // It may have been revoked in the developer console, or the login session behind
    // it may have ended - the plugin cannot tell which, so cover both.
    if (!this.email || !this.password) {
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
  
  async discoverDevices() {
    this.log.info('Setting up Homebridge accessories...');
    
    const uuid = this.api.hap.uuid.generate('omlet-coop-' + this.deviceId);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
    
    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      new OmletCoopAccessory(this, existingAccessory);
    } else {
      this.log.info('Adding new accessory: Omlet Coop');
      const coopAccessory = new this.api.platformAccessory('Omlet Coop', uuid);
      new OmletCoopAccessory(this, coopAccessory);
      this.api.registerPlatformAccessories('homebridge-omlet', 'OmletCoop', [coopAccessory]);
    }
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
    this.enableLight = platform.enableLight;
    this.enableBattery = platform.enableBattery;
    this.debug = platform.debug;
    
    this.accessoryInfoUpdated = false;
    this.cachedStatus = null;
    this.pollTimer = null;
    this.pollGeneration = 0;
    this.fastPollCount = 0;
    this.pendingServiceChange = { light: null, battery: null };
    this.lastFault = null;
    
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
    this.applyLightService(this.enableLight === 'auto' ? this.hasLightService() : this.enableLight);
    this.applyBatteryService(this.enableBattery === 'auto' ? this.hasBatteryService() : this.enableBattery);
    
    this.log.info(`Coop accessory initialized (light: ${this.describePref(this.enableLight)}, battery: ${this.describePref(this.enableBattery)})`);
    
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
    if (this.enableLight !== 'auto') {
      return this.enableLight;
    }
    
    const equipped = status?.configuration?.light?.equipped;
    if (equipped !== undefined && equipped !== null) {
      return Number(equipped) > 0;
    }
    
    const lightState = status?.state?.light;
    return lightState !== undefined && lightState !== null;
  }
  
  desiredBattery(status) {
    if (this.enableBattery !== 'auto') {
      return this.enableBattery;
    }
    
    const count = status?.batteryCount;
    if (typeof count === 'number' && count > 0) {
      return true;
    }
    
    const source = status?.state?.general?.powerSource;
    if (typeof source === 'string' && source.length > 0) {
      return source.toLowerCase() !== 'external';
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
    this.reconcileService('light', this.desiredLight(status),
      () => this.hasLightService(), (v) => this.applyLightService(v));
    this.reconcileService('battery', this.desiredBattery(status),
      () => this.hasBatteryService(), (v) => this.applyBatteryService(v));
  }
  
  // light
  
  async getLightOn() {
    try {
      if (!this.cachedStatus) {
        await this.pollDeviceState();
      }
      const lightState = this.cachedStatus?.state?.light?.state;
      if (!lightState) {
        throw new Error('Invalid API response: missing light state');
      }
      return (lightState === 'on' || lightState === 'onpending');
    } catch (error) {
      this.log.error('[Light] Failed to get light state:', error.message);
      throw new Error('Failed to get light state');
    }
  }
  
  async setLightOn(value) {
    const action = value ? 'on' : 'off';
    
    try {
      await this.sendAction(action, 'Light');
      this.log.info('[Light]', action === 'on' ? 'Turning on light' : 'Turning off light');
      
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
    try {
      if (!this.cachedStatus) {
        await this.pollDeviceState();
      }
      const batteryLevel = this.cachedStatus?.state?.general?.batteryLevel;
      if (batteryLevel === undefined || batteryLevel === null) {
        throw new Error('Invalid API response: missing battery level');
      }
      return batteryLevel;
    } catch (error) {
      this.log.error('[Battery] Failed to get battery level:', error.message);
      throw new Error('Failed to get battery level');
    }
  }
  
  async getStatusLowBattery() {
    try {
      if (!this.cachedStatus) {
        await this.pollDeviceState();
      }
      const batteryLevel = this.cachedStatus?.state?.general?.batteryLevel;
      if (batteryLevel === undefined || batteryLevel === null) {
        throw new Error('Invalid API response: missing battery level');
      }
      return (batteryLevel < 20) ? 1 : 0;
    } catch (error) {
      this.log.error('[Battery] Failed to get low battery status:', error.message);
      throw new Error('Failed to get low battery status');
    }
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
            if (this.debug || res.statusCode === 401 || res.statusCode === 403) {
              this.log.error(`[${context}] HTTP Error`, res.statusCode);
              this.log.error(`[${context}] Response:`, data);
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
    try {
      if (!this.cachedStatus) {
        await this.pollDeviceState();
      }
      const doorState = this.cachedStatus?.state?.door?.state;
      if (!doorState) {
        throw new Error('Invalid API response: missing door state');
      }
      return mapDoorState(doorState);
    } catch (error) {
      this.log.error('[Door] Failed to get door state:', error.message);
      throw new Error('Failed to get door state');
    }
  }
  
  async getTargetDoorState() {
    try {
      if (!this.cachedStatus) {
        await this.pollDeviceState();
      }
      const doorState = this.cachedStatus?.state?.door?.state;
      if (DOOR_OPEN_STATES.includes(doorState)) {
        return hap.Characteristic.TargetDoorState.OPEN;
      }
      return hap.Characteristic.TargetDoorState.CLOSED;
    } catch (error) {
      this.log.error('[Door] Failed to get target door state:', error.message);
      throw new Error('Failed to get target door state');
    }
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
      this.log.info(`[Door] Door is already ${doorState}, not sending ${action}`);
      
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
      
      const newCurrentState = (action === 'open') 
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
  
  async pollDeviceState() {
    try {
      const status = await this.getDeviceStatus('Poll');
      this.cachedStatus = status;
      this.reconcileServices(status);

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
    } catch (error) {
      if (error.statusCode === 401 || error.statusCode === 403) {
        const refreshed = await this.platform.handleAuthError();
        if (refreshed) {
          try {
            const status = await this.getDeviceStatus('Poll');
            this.cachedStatus = status;
            return status;
          } catch (retryError) {
            this.log.error('[Poll] Retry after token refresh failed:', retryError.message);
            throw retryError;
          }
        }
      }
      this.log.error('[Poll] Failed to get device status:', error.message);
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
    
    if (this.isTransitioning()) {
      this.fastPollCount++;
      
      if (this.fastPollCount <= MAX_FAST_POLLS) {
        this.scheduleNextPoll(FAST_POLL_MS);
        return;
      }
      
      this.log.warn(`[Poll] Door has not settled after ${Math.round(MAX_FAST_POLLS * FAST_POLL_MS / 1000)}s (state: ${this.cachedStatus?.state?.door?.state ?? 'unknown'}), returning to normal polling`);
    }
    
    this.fastPollCount = 0;
    this.scheduleNextPoll(this.pollInterval);
  }

  startPolling() {
    this.log.info(`Polling every ${this.pollInterval / 1000}s, or every ${FAST_POLL_MS / 1000}s while the door or light is moving`);
    this.scheduleNextPoll(0);
  }
}
