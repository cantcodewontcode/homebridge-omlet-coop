const https = require('https');

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
    
    // Configuration
    this.email = config.email;
    this.password = config.password;
    this.countryCode = config.countryCode || 'US';
    this.bearerToken = config.bearerToken; // Manual token option
    this.deviceId = config.deviceId;
    this.baseUrl = config.apiServer || 'x107.omlet.co.uk';
    this.pollInterval = Math.max((config.pollInterval || 30), 30) * 1000;
    this.enableLight = config.enableLight !== false; // Default true for backwards compatibility
    this.debug = config.debug || false;
    
    // Token management
    this.currentToken = null;
    
    // Circuit breaker for failed logins
    this.loginFailures = [];
    this.maxFailures = 3;
    this.failureWindow = 5 * 60 * 1000; // 5 minutes
    this.circuitBroken = false;
    
    this.accessories = [];
    
    this.log.info('Omlet Coop Platform Loaded');
    if (this.debug) {
      this.log.info('Debug mode enabled');
    }
    
    // Validate config
    const hasEmailPassword = this.email && this.password;
    const hasManualToken = this.bearerToken && this.deviceId;
    
    if (!hasEmailPassword && !hasManualToken) {
      this.log.error('Configuration required:');
      this.log.error('  Option 1: Provide email + password (auto-login)');
      this.log.error('  Option 2: Provide bearerToken + deviceId (manual)');
      return;
    }
    
    this.api.on('didFinishLaunching', async () => {
      await this.initialize();
    });
  }
  
  async initialize() {
    try {
      // Check if using manual token mode (token required, deviceId optional)
      if (this.bearerToken) {
        this.log.info('Using manual bearer token mode');
        this.currentToken = this.bearerToken;
        
        // Auto-discover device if not provided
        if (!this.deviceId) {
          this.log.warn('No device ID configured, attempting auto-discovery...');
          await this.autoDiscoverDevice();
          
          if (!this.deviceId) {
            this.log.error('No device ID found! Cannot continue.');
            this.log.error('Please check that your Omlet device is online and connected.');
            return;
          }
        }
        
        // Create accessories
        await this.discoverDevices();
        return;
      }
      
      // Auto-login mode (requires email + password)
      if (!this.email || !this.password) {
        this.log.error('Configuration error: Email and password are required for auto-login mode');
        this.log.error('Please provide either:');
        this.log.error('  1. Email + Password (for auto-login), OR');
        this.log.error('  2. Bearer Token (manual token mode)');
        return;
      }
      
      this.log.info('Logging in to Omlet API...');
      await this.login();
      
      // Auto-discover device if not provided
      if (!this.deviceId) {
        this.log.warn('No device ID configured, attempting auto-discovery...');
        await this.autoDiscoverDevice();
      }
      
      if (!this.deviceId) {
        this.log.error('No device ID found! Cannot continue.');
        this.log.error('Please check that your Omlet device is online and connected.');
        return;
      }
      
      // Discover accessories
      await this.discoverDevices();
      
    } catch (error) {
      this.log.error('Initialization failed:', error.message);
    }
  }
  
  async login() {
    if (this.circuitBroken) {
      this.log.error('Circuit breaker open - too many failed login attempts.');
      this.log.error('Please check credentials and restart Homebridge.');
      throw new Error('Circuit breaker open');
    }
    
    try {
      const apiKey = await this.performLogin();
      
      this.currentToken = apiKey;
      
      // Clear failure history on success
      this.loginFailures = [];
      
      this.log.info('Login successful, token acquired');
      
      return apiKey;
      
    } catch (error) {
      this.recordLoginFailure();
      
      if (error.statusCode === 401 || error.statusCode === 403) {
        this.log.error('Login failed: Invalid email or password');
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
        this.log.info('✓ Auto-discovered device:', devices[0].name, '(', this.deviceId, ')');
        this.log.info('→ Add this to your config.json: "deviceId": "' + this.deviceId + '"');
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
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              const devices = [];
              
              // Extract devices from groups
              if (json.groups && Array.isArray(json.groups)) {
                json.groups.forEach(group => {
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
  
  recordLoginFailure() {
    const now = Date.now();
    this.loginFailures.push(now);
    
    // Remove failures outside the window
    this.loginFailures = this.loginFailures.filter(
      timestamp => now - timestamp < this.failureWindow
    );
    
    if (this.loginFailures.length >= this.maxFailures) {
      this.circuitBroken = true;
      this.log.error('CIRCUIT BREAKER TRIGGERED: 3 login failures in 5 minutes');
      this.log.error('Please verify your email and password in config.json and restart Homebridge');
    }
  }
  
  async handleAuthError() {
    this.log.warn('Authentication error detected, attempting to re-login...');
    try {
      await this.login();
      this.log.info('Re-login successful');
      return true;
    } catch (error) {
      this.log.error('Failed to re-login:', error.message);
      return false;
    }
  }
  
  async discoverDevices() {
    this.log.info('Setting up Homebridge accessories...');
    
    // Create ONE accessory with multiple services (linked services pattern)
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
    this.debug = platform.debug;
    
    // IMPORTANT: Remove light service FIRST if disabled (before setting up anything else)
    if (!this.enableLight) {
      const existingLight = this.accessory.getService(hap.Service.Lightbulb);
      if (existingLight) {
        this.log.warn('Light disabled in config, removing light service...');
        this.accessory.removeService(existingLight);
      }
    }
    
    // Set accessory information
    this.accessory.getService(hap.Service.AccessoryInformation)
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Omlet')
      .setCharacteristic(hap.Characteristic.Model, 'Smart Autodoor')
      .setCharacteristic(hap.Characteristic.SerialNumber, this.deviceId);
    
    // Create Door Service (PRIMARY SERVICE)
    this.doorService = this.accessory.getService(hap.Service.GarageDoorOpener) 
      || this.accessory.addService(hap.Service.GarageDoorOpener);
    
    this.doorService.setCharacteristic(hap.Characteristic.Name, 'Coop Door');
    this.doorService.setPrimaryService(true); // Door is the primary service
    
    // Set up door characteristics
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
    
    // Create Light Service (LINKED SERVICE) - only if enabled
    if (this.enableLight) {
      this.lightService = this.accessory.getService(hap.Service.Lightbulb) 
        || this.accessory.addService(hap.Service.Lightbulb);
      
      this.lightService.setCharacteristic(hap.Characteristic.Name, 'Coop Light');
      this.lightService.addLinkedService(this.doorService); // Link to door service
      
      // Set up light characteristics
      this.lightService
        .getCharacteristic(hap.Characteristic.On)
        .onGet(this.getLightOn.bind(this))
        .onSet(this.setLightOn.bind(this));
        
      this.log.info('Coop accessory initialized with door and light services');
    } else {
      this.log.info('Coop accessory initialized with door service only (light disabled)');
    }
    
    // Start polling
    this.startPolling();
  }
  
  // === LIGHT METHODS ===
  
  async getLightOn() {
    try {
      if (this.debug) {
        this.log.info('[Light] Getting current state...');
      }
      
      const status = await this.getDeviceStatus();
      const lightState = status.state.light.state;
      const isOn = (lightState === 'on' || lightState === 'onpending');
      
      if (this.debug) {
        this.log.info('[Light] Current state:', lightState, '-> isOn:', isOn);
      }
      
      return isOn;
    } catch (error) {
      this.log.error('[Light] Failed to get light state:', error.message);
      
      // Check if it's an auth error
      if (error.statusCode === 401 || error.statusCode === 403) {
        const refreshed = await this.platform.handleAuthError();
        if (refreshed) {
          // Retry once with new token
          try {
            const status = await this.getDeviceStatus();
            const lightState = status.state.light.state;
            return (lightState === 'on' || lightState === 'onpending');
          } catch (retryError) {
            this.log.error('[Light] Retry after token refresh also failed');
          }
        }
      }
      
      throw new Error('Failed to get light state');
    }
  }
  
  async setLightOn(value) {
    const action = value ? 'on' : 'off';
    
    try {
      if (this.debug) {
        this.log.info('[Light] Setting state to:', action);
      }
      
      await this.sendAction(action);
      this.log.info('[Light] Successfully turned', action);
    } catch (error) {
      this.log.error('[Light] Failed to set light state:', error.message);
      
      // Check if it's an auth error
      if (error.statusCode === 401 || error.statusCode === 403) {
        const refreshed = await this.platform.handleAuthError();
        if (refreshed) {
          // Retry once with new token
          try {
            await this.sendAction(action);
            this.log.info('[Light] Successfully turned', action, 'after token refresh');
            return;
          } catch (retryError) {
            this.log.error('[Light] Retry after token refresh also failed');
          }
        }
      }
      
      throw new Error('Failed to set light state');
    }
  }
  
  sendAction(action) {
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
        this.log.info('[Light] POST', options.path);
      }
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (this.debug) {
            this.log.info('[Light] Response status:', res.statusCode);
            if (data) {
              this.log.info('[Light] Response body:', data);
            }
          }
          
          if (res.statusCode === 200 || res.statusCode === 204) {
            resolve();
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
        this.log.error('[Light] Request timeout after 10 seconds');
        reject(new Error('Request timeout'));
      });
      
      req.on('error', (error) => {
        this.log.error('[Light] Network error:', error.message);
        reject(error);
      });
      
      req.write(postData);
      req.end();
    });
  }
  
  getDeviceStatus() {
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
        this.log.info('[Light] GET', options.path);
      }
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (this.debug) {
            this.log.info('[Light] Response status:', res.statusCode);
          }
          
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              resolve(json);
            } catch (error) {
              this.log.error('[Light] Failed to parse JSON:', error.message);
              this.log.error('[Light] Response was:', data);
              reject(new Error('Failed to parse JSON response'));
            }
          } else {
            if (this.debug || res.statusCode === 401 || res.statusCode === 403) {
              this.log.error('[Light] HTTP Error', res.statusCode);
              this.log.error('[Light] Response:', data);
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
        this.log.error('[Light] Request timeout after 10 seconds');
        reject(new Error('Request timeout'));
      });
      
      req.on('error', (error) => {
        this.log.error('[Light] Network error:', error.message);
        reject(error);
      });
      
      req.end();
    });
  }
  
  startPolling() {
    setInterval(async () => {
      try {
        const isOn = await this.getOn();
        this.service
          .getCharacteristic(hap.Characteristic.On)
          .updateValue(isOn);
      } catch (error) {
        // Already logged in getOn()
      }
    }, this.pollInterval);
    
    this.log.info('Light polling started: every', this.pollInterval / 1000, 'seconds');
  }
  
  // === DOOR METHODS ===
  
  async getCurrentDoorState() {
    try {
      if (this.debug) {
        this.log.info('[Door] Getting current state...');
      }
      
      const status = await this.getDeviceStatus();
      const doorState = status.state.door.state;
      
      // Map API states to HomeKit states
      const stateMap = {
        'open': hap.Characteristic.CurrentDoorState.OPEN,
        'closed': hap.Characteristic.CurrentDoorState.CLOSED,
        'opening': hap.Characteristic.CurrentDoorState.OPENING,
        'closing': hap.Characteristic.CurrentDoorState.CLOSING,
        'stopping': hap.Characteristic.CurrentDoorState.STOPPED
      };
      
      const currentState = stateMap[doorState] ?? hap.Characteristic.CurrentDoorState.STOPPED;
      
      if (this.debug) {
        this.log.info('[Door] Current state:', doorState, '-> HomeKit:', currentState);
      }
      
      return currentState;
    } catch (error) {
      this.log.error('[Door] Failed to get door state:', error.message);
      
      // Check if it's an auth error
      if (error.statusCode === 401 || error.statusCode === 403) {
        const refreshed = await this.platform.handleAuthError();
        if (refreshed) {
          // Retry once with new token
          try {
            const status = await this.getDeviceStatus();
            const doorState = status.state.door.state;
            const stateMap = {
              'open': hap.Characteristic.CurrentDoorState.OPEN,
              'closed': hap.Characteristic.CurrentDoorState.CLOSED,
              'opening': hap.Characteristic.CurrentDoorState.OPENING,
              'closing': hap.Characteristic.CurrentDoorState.CLOSING,
              'stopping': hap.Characteristic.CurrentDoorState.STOPPED
            };
            return stateMap[doorState] ?? hap.Characteristic.CurrentDoorState.STOPPED;
          } catch (retryError) {
            this.log.error('[Door] Retry after token refresh also failed');
          }
        }
      }
      
      throw new Error('Failed to get door state');
    }
  }
  
  async getTargetDoorState() {
    try {
      const currentState = await this.getCurrentDoorState();
      
      if (currentState === hap.Characteristic.CurrentDoorState.OPEN || 
          currentState === hap.Characteristic.CurrentDoorState.OPENING) {
        return hap.Characteristic.TargetDoorState.OPEN;
      } else {
        return hap.Characteristic.TargetDoorState.CLOSED;
      }
    } catch (error) {
      this.log.error('[Door] Failed to get target door state:', error.message);
      throw new Error('Failed to get target door state');
    }
  }
  
  async setTargetDoorState(value) {
    const action = (value === hap.Characteristic.TargetDoorState.OPEN) ? 'open' : 'close';
    
    try {
      if (this.debug) {
        this.log.info('[Door] Setting state to:', action);
      }
      
      await this.sendAction(action);
      this.log.info('[Door] Successfully sent command:', action);
      
      const newCurrentState = (action === 'open') 
        ? hap.Characteristic.CurrentDoorState.OPENING
        : hap.Characteristic.CurrentDoorState.CLOSING;
      
      this.doorService
        .getCharacteristic(hap.Characteristic.CurrentDoorState)
        .updateValue(newCurrentState);
        
    } catch (error) {
      this.log.error('[Door] Failed to set door state:', error.message);
      
      // Check if it's an auth error
      if (error.statusCode === 401 || error.statusCode === 403) {
        const refreshed = await this.platform.handleAuthError();
        if (refreshed) {
          // Retry once with new token
          try {
            await this.sendAction(action);
            this.log.info('[Door] Successfully sent command:', action, 'after token refresh');
            
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
  
  // === SHARED API METHODS ===
  
  sendAction(action) {
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
        this.log.info('[Door] POST', options.path);
      }
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (this.debug) {
            this.log.info('[Door] Response status:', res.statusCode);
            if (data) {
              this.log.info('[Door] Response body:', data);
            }
          }
          
          if (res.statusCode === 200 || res.statusCode === 204) {
            resolve();
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
        this.log.error('[Door] Request timeout after 10 seconds');
        reject(new Error('Request timeout'));
      });
      
      req.on('error', (error) => {
        this.log.error('[Door] Network error:', error.message);
        reject(error);
      });
      
      req.write(postData);
      req.end();
    });
  }
  
  getDeviceStatus() {
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
        this.log.info('[Door] GET', options.path);
      }
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (this.debug) {
            this.log.info('[Door] Response status:', res.statusCode);
          }
          
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              resolve(json);
            } catch (error) {
              this.log.error('[Door] Failed to parse JSON:', error.message);
              this.log.error('[Door] Response was:', data);
              reject(new Error('Failed to parse JSON response'));
            }
          } else {
            if (this.debug || res.statusCode === 401 || res.statusCode === 403) {
              this.log.error('[Door] HTTP Error', res.statusCode);
              this.log.error('[Door] Response:', data);
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
        this.log.error('[Door] Request timeout after 10 seconds');
        reject(new Error('Request timeout'));
      });
      
      req.on('error', (error) => {
        this.log.error('[Door] Network error:', error.message);
        reject(error);
      });
      
      req.end();
    });
  }
  
  startPolling() {
    setInterval(async () => {
      try {
        // Poll door state
        const currentState = await this.getCurrentDoorState();
        this.doorService
          .getCharacteristic(hap.Characteristic.CurrentDoorState)
          .updateValue(currentState);
          
        const targetState = await this.getTargetDoorState();
        this.doorService
          .getCharacteristic(hap.Characteristic.TargetDoorState)
          .updateValue(targetState);
        
        // Poll light state (only if enabled)
        if (this.enableLight && this.lightService) {
          const isOn = await this.getLightOn();
          this.lightService
            .getCharacteristic(hap.Characteristic.On)
            .updateValue(isOn);
        }
          
      } catch (error) {
        // Already logged in individual methods
      }
    }, this.pollInterval);
    
    const services = this.enableLight ? 'door and light' : 'door';
    this.log.info(`Polling started for ${services}: every ${this.pollInterval / 1000} seconds`);
  }
}
