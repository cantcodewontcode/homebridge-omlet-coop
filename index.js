const https = require('https');
const fs = require('fs');

let hap;

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
    this.enableLight = config.enableLight !== false; // default true for backwards compatibility
    this.enableBattery = config.enableBattery === true; // default false (not visible in Apple Home)
    this.debug = config.debug || false;
    
    this.currentToken = null;
    this.storage = this.api.user.storagePath() + '/omlet-coop-tokens.json';
    this.authFailedPermanently = false;
    this.reloginAttempts = 0;
    this.maxReloginAttempts = 3;
    
    this.accessories = [];
    
    this.log.info('Omlet Coop platform loaded');
    if (this.debug) {
      this.log.info('Debug mode enabled');
    }
    
    const hasEmailPassword = this.email && this.password;
    const hasManualToken = this.bearerToken && this.deviceId;
    
    if (!hasEmailPassword && !hasManualToken) {
      this.log.error('Enter email address & password to configure plugin');
      return;
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
    
    // Must be alphanumeric, max 128 characters
    const tokenRegex = /^[a-zA-Z0-9]{1,128}$/;
    
    if (!tokenRegex.test(token)) {
      this.log.error(`Invalid ${fieldName}: must be alphanumeric and less than 128 characters`);
      return undefined;
    }
    
    return token;
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
        
        // stored credentials take priority over config since they're more recent
        if (data.bearerToken) {
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
  
  async initialize() {
    try {
      if (this.bearerToken) {
        this.log.info('Using configured API token');
        this.currentToken = this.bearerToken;
        
        if (!this.deviceId) {
          this.log.info('Discovering device ID');
          await this.autoDiscoverDevice();
          
          if (!this.deviceId) {
            this.log.error('No device ID found! Please ensure your coop door is connected to your Omlet account and try again.');
            return;
          }
        }
        
        await this.discoverDevices();
        return;
      }
      
      if (!this.email || !this.password) {
        this.log.error('Enter email address & password to configure plugin');
        return;
      }
      
      this.log.info('Logging into Omlet API');
      await this.login();
      
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
          'Content-Length': postData.length,
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
                  this.log.info('[Auth] Bearer token received:', json.apiKey);
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

    // If using token-only mode with no credentials, can't re-login
    if (!this.email || !this.password) {
      this.log.error('API token expired or invalid. No email/password configured for automatic re-login. Please update your API token in the plugin settings.');
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
    
    // services need to be removed before re-adding, otherwise stale ones persist in cache
    if (!this.enableLight) {
      const existingLight = this.accessory.getService(hap.Service.Lightbulb);
      if (existingLight) {
        this.log.warn('Light disabled in config, removing light service...');
        this.accessory.removeService(existingLight);
      }
    }
    
    if (!this.enableBattery) {
      const existingBattery = this.accessory.getService(hap.Service.Battery);
      if (existingBattery) {
        this.log.warn('Battery disabled in config, removing battery service...');
        this.accessory.removeService(existingBattery);
      }
    }
    
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
      .onGet(() => false);
    
    // light and battery are linked to the door as the primary service
    if (this.enableLight) {
      this.lightService = this.accessory.getService(hap.Service.Lightbulb) 
        || this.accessory.addService(hap.Service.Lightbulb);
      
      this.lightService.setCharacteristic(hap.Characteristic.Name, 'Coop Light');
      
      this.lightService
        .getCharacteristic(hap.Characteristic.On)
        .onGet(this.getLightOn.bind(this))
        .onSet(this.setLightOn.bind(this));
      
      this.doorService.addLinkedService(this.lightService);
    }
    
    if (this.enableBattery) {
      this.batteryService = this.accessory.getService(hap.Service.Battery)
        || this.accessory.addService(hap.Service.Battery);
      
      this.batteryService.setCharacteristic(hap.Characteristic.Name, 'Battery');
      
      this.batteryService
        .getCharacteristic(hap.Characteristic.BatteryLevel)
        .onGet(this.getBatteryLevel.bind(this));
      
      this.batteryService
        .getCharacteristic(hap.Characteristic.ChargingState)
        .onGet(this.getChargingState.bind(this));
      
      this.batteryService
        .getCharacteristic(hap.Characteristic.StatusLowBattery)
        .onGet(this.getStatusLowBattery.bind(this));
      
      this.doorService.addLinkedService(this.batteryService);
    }
    
    const services = ['door'];
    if (this.enableLight) services.push('light');
    if (this.enableBattery) services.push('battery');
    this.log.info(`Coop accessory initialized with ${services.join(', ')} service${services.length > 1 ? 's' : ''}`);
    
    this.startPolling();
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
      
      // re-poll after 15s to confirm the light actually switched
      setTimeout(async () => {
        try {
          await this.pollDeviceState();
          this.pushStateToHomeKit();
        } catch (error) {
          if (this.debug) {
            this.log.warn('[Light] Eager re-poll failed:', error.message);
          }
        }
      }, 15000);
      
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
  
  getChargingState() {
    // Omlet autodoor uses AA batteries - not rechargeable, always NOT_CHARGEABLE
    return 2;
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
          'Content-Length': postData.length,
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
      const stateMap = {
        'open': hap.Characteristic.CurrentDoorState.OPEN,
        'closed': hap.Characteristic.CurrentDoorState.CLOSED,
        'opening': hap.Characteristic.CurrentDoorState.OPENING,
        'closing': hap.Characteristic.CurrentDoorState.CLOSING,
        'stopping': hap.Characteristic.CurrentDoorState.STOPPED
      };
      return stateMap[doorState] ?? hap.Characteristic.CurrentDoorState.STOPPED;
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
      if (doorState === 'open' || doorState === 'opening') {
        return hap.Characteristic.TargetDoorState.OPEN;
      }
      return hap.Characteristic.TargetDoorState.CLOSED;
    } catch (error) {
      this.log.error('[Door] Failed to get target door state:', error.message);
      throw new Error('Failed to get target door state');
    }
  }
  
  async setTargetDoorState(value) {
    const action = (value === hap.Characteristic.TargetDoorState.OPEN) ? 'open' : 'close';
    
    try {
      await this.sendAction(action, 'Door');
      this.log.info('[Door]', action === 'open' ? 'Opening door' : 'Closing door');
      
      const newCurrentState = (action === 'open') 
        ? hap.Characteristic.CurrentDoorState.OPENING
        : hap.Characteristic.CurrentDoorState.CLOSING;
      
      this.doorService
        .getCharacteristic(hap.Characteristic.CurrentDoorState)
        .updateValue(newCurrentState);
      
      // re-poll after 15s to confirm the door actually moved
      setTimeout(async () => {
        try {
          await this.pollDeviceState();
          this.pushStateToHomeKit();
        } catch (error) {
          if (this.debug) {
            this.log.warn('[Door] Eager re-poll failed:', error.message);
          }
        }
      }, 15000);
        
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
        const stateMap = {
          'open': hap.Characteristic.CurrentDoorState.OPEN,
          'closed': hap.Characteristic.CurrentDoorState.CLOSED,
          'opening': hap.Characteristic.CurrentDoorState.OPENING,
          'closing': hap.Characteristic.CurrentDoorState.CLOSING,
          'stopping': hap.Characteristic.CurrentDoorState.STOPPED
        };
        const currentState = stateMap[doorState] ?? hap.Characteristic.CurrentDoorState.STOPPED;
        this.doorService.getCharacteristic(hap.Characteristic.CurrentDoorState).updateValue(currentState);

        const targetState = (doorState === 'open' || doorState === 'opening')
          ? hap.Characteristic.TargetDoorState.OPEN
          : hap.Characteristic.TargetDoorState.CLOSED;
        this.doorService.getCharacteristic(hap.Characteristic.TargetDoorState).updateValue(targetState);

        if (this.debug) {
          this.log.info('[Poll] Door:', doorState, '-> HomeKit:', currentState);
        }
      }

      // Light state
      if (this.enableLight && this.lightService) {
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
      if (this.enableBattery && this.batteryService) {
        const batteryLevel = status.state?.general?.batteryLevel;
        if (batteryLevel !== undefined && batteryLevel !== null) {
          this.batteryService.getCharacteristic(hap.Characteristic.BatteryLevel).updateValue(batteryLevel);
          this.batteryService.getCharacteristic(hap.Characteristic.ChargingState).updateValue(2); // NOT_CHARGEABLE
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
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  startPolling() {
    (async () => {
      try {
        await this.pollDeviceState();
        this.pushStateToHomeKit();
      } catch (error) {
        this.log.error('[Poll] First poll failed, will retry on next interval');
      }
    })();

    this.pollTimer = setInterval(async () => {
      try {
        await this.pollDeviceState();
        this.pushStateToHomeKit();
      } catch (error) {
        if (this.debug) {
          this.log.warn('[Poll] Poll cycle failed:', error.message);
        }
      }
    }, this.pollInterval);

    const services = ['door'];
    if (this.enableLight) services.push('light');
    if (this.enableBattery) services.push('battery');
    this.log.info(`Polling started for ${services.join(', ')}: every ${this.pollInterval / 1000} seconds`);
  }
}
