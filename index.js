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
    this.bearerToken = config.bearerToken;
    this.deviceId = config.deviceId;
    this.baseUrl = config.apiServer || 'x107.omlet.co.uk';
    this.pollInterval = (config.pollInterval || 30) * 1000;
    this.debug = config.debug || false;
    
    this.accessories = [];
    
    // Validate required config
    if (!this.bearerToken) {
      this.log.error('Bearer token is required! Please configure the plugin.');
      return;
    }
    
    if (!this.deviceId) {
      this.log.error('Device ID is required! Please configure the plugin.');
      return;
    }
    
    this.log.info('Omlet Coop Platform Loaded');
    if (this.debug) {
      this.log.info('Debug mode enabled');
    }
    
    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }
  
  discoverDevices() {
    this.log.info('Discovering Omlet devices...');
    
    // Create Light Accessory
    const lightUuid = this.api.hap.uuid.generate('omlet-light-' + this.deviceId);
    const existingLight = this.accessories.find(accessory => accessory.UUID === lightUuid);
    
    if (existingLight) {
      this.log.info('Restoring existing accessory from cache:', existingLight.displayName);
      new OmletLightAccessory(this, existingLight);
    } else {
      this.log.info('Adding new accessory: Coop Light');
      const lightAccessory = new this.api.platformAccessory('Coop Light', lightUuid);
      new OmletLightAccessory(this, lightAccessory);
      this.api.registerPlatformAccessories('homebridge-omlet', 'OmletCoop', [lightAccessory]);
    }
    
    // Create Door Accessory
    const doorUuid = this.api.hap.uuid.generate('omlet-door-' + this.deviceId);
    const existingDoor = this.accessories.find(accessory => accessory.UUID === doorUuid);
    
    if (existingDoor) {
      this.log.info('Restoring existing accessory from cache:', existingDoor.displayName);
      new OmletGarageDoorAccessory(this, existingDoor);
    } else {
      this.log.info('Adding new accessory: Coop Door');
      const doorAccessory = new this.api.platformAccessory('Coop Door', doorUuid);
      new OmletGarageDoorAccessory(this, doorAccessory);
      this.api.registerPlatformAccessories('homebridge-omlet', 'OmletCoop', [doorAccessory]);
    }
  }
  
  configureAccessory(accessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }
}

class OmletLightAccessory {
  constructor(platform, accessory) {
    this.platform = platform;
    this.accessory = accessory;
    this.log = platform.log;
    
    this.bearerToken = platform.bearerToken;
    this.deviceId = platform.deviceId;
    this.baseUrl = platform.baseUrl;
    this.pollInterval = platform.pollInterval;
    this.debug = platform.debug;
    
    // Set accessory information
    this.accessory.getService(hap.Service.AccessoryInformation)
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Omlet')
      .setCharacteristic(hap.Characteristic.Model, 'Autodoor Light')
      .setCharacteristic(hap.Characteristic.SerialNumber, this.deviceId + '-light');
    
    // Get or create the lightbulb service
    this.service = this.accessory.getService(hap.Service.Lightbulb) 
      || this.accessory.addService(hap.Service.Lightbulb);
    
    this.service.setCharacteristic(hap.Characteristic.Name, 'Coop Light');
    
    // Set up the On characteristic
    this.service
      .getCharacteristic(hap.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
    
    // Start polling
    this.startPolling();
    
    this.log.info('Light accessory initialized');
  }
  
  async getOn() {
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
      if (this.debug && error.statusCode) {
        this.log.error('[Light] HTTP Status:', error.statusCode);
        this.log.error('[Light] Response:', error.response);
      }
      throw new Error('Failed to get light state');
    }
  }
  
  async setOn(value) {
    const action = value ? 'on' : 'off';
    
    try {
      if (this.debug) {
        this.log.info('[Light] Setting state to:', action);
      }
      
      await this.sendAction(action);
      this.log.info('[Light] Successfully turned', action);
    } catch (error) {
      this.log.error('[Light] Failed to set light state:', error.message);
      if (this.debug && error.statusCode) {
        this.log.error('[Light] HTTP Status:', error.statusCode);
        this.log.error('[Light] Response:', error.response);
      }
      throw new Error('Failed to set light state');
    }
  }
  
  sendAction(action) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({});
      
      const options = {
        hostname: this.baseUrl,
        port: 443,
        path: `/api/v1/device/${this.deviceId}/action/${action}`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.bearerToken}`,
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
      const options = {
        hostname: this.baseUrl,
        port: 443,
        path: `/api/v1/device/${this.deviceId}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.bearerToken}`,
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
}

class OmletGarageDoorAccessory {
  constructor(platform, accessory) {
    this.platform = platform;
    this.accessory = accessory;
    this.log = platform.log;
    
    this.bearerToken = platform.bearerToken;
    this.deviceId = platform.deviceId;
    this.baseUrl = platform.baseUrl;
    this.pollInterval = platform.pollInterval;
    this.debug = platform.debug;
    
    // Set accessory information
    this.accessory.getService(hap.Service.AccessoryInformation)
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Omlet')
      .setCharacteristic(hap.Characteristic.Model, 'Autodoor')
      .setCharacteristic(hap.Characteristic.SerialNumber, this.deviceId + '-door');
    
    // Get or create the garage door opener service
    this.service = this.accessory.getService(hap.Service.GarageDoorOpener) 
      || this.accessory.addService(hap.Service.GarageDoorOpener);
    
    this.service.setCharacteristic(hap.Characteristic.Name, 'Coop Door');
    
    // Set up characteristics
    this.service
      .getCharacteristic(hap.Characteristic.CurrentDoorState)
      .onGet(this.getCurrentDoorState.bind(this));
    
    this.service
      .getCharacteristic(hap.Characteristic.TargetDoorState)
      .onGet(this.getTargetDoorState.bind(this))
      .onSet(this.setTargetDoorState.bind(this));
    
    this.service
      .getCharacteristic(hap.Characteristic.ObstructionDetected)
      .onGet(() => false);
    
    // Start polling
    this.startPolling();
    
    this.log.info('Door accessory initialized');
  }
  
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
      if (this.debug && error.statusCode) {
        this.log.error('[Door] HTTP Status:', error.statusCode);
        this.log.error('[Door] Response:', error.response);
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
      
      this.service
        .getCharacteristic(hap.Characteristic.CurrentDoorState)
        .updateValue(newCurrentState);
        
    } catch (error) {
      this.log.error('[Door] Failed to set door state:', error.message);
      if (this.debug && error.statusCode) {
        this.log.error('[Door] HTTP Status:', error.statusCode);
        this.log.error('[Door] Response:', error.response);
      }
      throw new Error('Failed to set door state');
    }
  }
  
  sendAction(action) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({});
      
      const options = {
        hostname: this.baseUrl,
        port: 443,
        path: `/api/v1/device/${this.deviceId}/action/${action}`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.bearerToken}`,
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
      const options = {
        hostname: this.baseUrl,
        port: 443,
        path: `/api/v1/device/${this.deviceId}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.bearerToken}`,
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
        const currentState = await this.getCurrentDoorState();
        this.service
          .getCharacteristic(hap.Characteristic.CurrentDoorState)
          .updateValue(currentState);
          
        const targetState = await this.getTargetDoorState();
        this.service
          .getCharacteristic(hap.Characteristic.TargetDoorState)
          .updateValue(targetState);
          
      } catch (error) {
        // Already logged in getCurrentDoorState()
      }
    }, this.pollInterval);
    
    this.log.info('Door polling started: every', this.pollInterval / 1000, 'seconds');
  }
}
