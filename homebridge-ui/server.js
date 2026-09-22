const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = 'omlet-coop-tokens.json';

class OmletPluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    
    this.onRequest('/login', this.handleLogin.bind(this));
    this.onRequest('/discover', this.handleDiscover.bind(this));
    this.onRequest('/validate', this.handleValidate.bind(this));
    this.onRequest('/session-status', this.handleSessionStatus.bind(this));
    this.onRequest('/persist-token', this.handlePersistToken.bind(this));
    this.onRequest('/forget', this.handleForget.bind(this));
    this.onRequest('/strip-credentials', this.handleStripCredentials.bind(this));
    
    this.ready();
  }
  
  // Rewrites config.json directly. updatePluginConfig() could not be relied on to
  // REMOVE a key - omitting it from the staged block did not delete it - and a
  // credential left in config.json overrides the working one in storage.
  async handleStripCredentials() {
    const configPath = this.homebridgeConfigPath;
    
    if (!configPath) {
      throw new RequestError('Homebridge config path is unavailable', { status: 500 });
    }
    
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      if (!Array.isArray(config.platforms)) {
        return { success: true, removed: [] };
      }
      
      const removed = [];
      
      config.platforms.forEach((block) => {
        if (!block || block.platform !== 'OmletCoop') {
          return;
        }
        
        ['email', 'password', 'bearerToken'].forEach((field) => {
          if (block[field] !== undefined) {
            delete block[field];
            removed.push(field);
          }
        });
      });
      
      if (removed.length > 0) {
        const tmpPath = `${configPath}.omlet-tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(config, null, 4));
        fs.renameSync(tmpPath, configPath);
      }
      
      return { success: true, removed: removed };
    } catch (error) {
      throw new RequestError(`Failed to clean config.json: ${error.message}`, { status: 500 });
    }
  }
  
  tokenFilePath() {
    if (!this.homebridgeStoragePath) {
      throw new RequestError('Homebridge storage path is unavailable', { status: 500 });
    }
    
    return path.join(this.homebridgeStoragePath, TOKEN_FILE);
  }
  
  readStoredCredentials() {
    try {
      const file = this.tokenFilePath();
      
      if (!fs.existsSync(file)) {
        return null;
      }
      
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      return null;
    }
  }
  
  // The credential lives in the Homebridge storage directory, not config.json.
  async handlePersistToken(payload) {
    const { token, deviceId } = payload || {};
    
    if (!token) {
      throw new RequestError('Token is required', { status: 400 });
    }
    
    const data = {
      bearerToken: token,
      lastUpdated: new Date().toISOString()
    };
    
    if (deviceId) {
      data.deviceId = deviceId;
    }
    
    try {
      fs.writeFileSync(this.tokenFilePath(), JSON.stringify(data, null, 2));
      return { success: true };
    } catch (error) {
      throw new RequestError(`Failed to save credentials: ${error.message}`, { status: 500 });
    }
  }
  
  // Deleting the stored credential is the only way to genuinely reset the plugin -
  // removing the config block alone leaves this file behind and the plugin still
  // connected, which is confusing rather than helpful.
  async handleForget() {
    try {
      const file = this.tokenFilePath();
      
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
      
      return { success: true };
    } catch (error) {
      throw new RequestError(`Failed to remove credentials: ${error.message}`, { status: 500 });
    }
  }
  
  // Checks whether the saved credentials still work, using the same precedence the
  // plugin uses at runtime. The token is resolved and tested server-side so it is
  // never sent to the browser.
  async handleSessionStatus(payload) {
    const { bearerToken, debug } = payload || {};
    
    // Storage holds the live credential; a token in config.json is a bootstrap value
    // the plugin has not consumed yet.
    let token = null;
    let source = null;
    
    const stored = this.readStoredCredentials();
    
    if (stored && stored.bearerToken) {
      token = stored.bearerToken;
      source = 'storage';
    } else if (bearerToken) {
      token = bearerToken;
      source = 'config';
    }
    
    if (!token) {
      return { state: 'unconfigured' };
    }
    
    try {
      const devices = await this.discoverOmletDevices(token, debug);
      return { state: 'valid', source: source, deviceCount: devices.length, devices: devices };
    } catch (error) {
      // Only 401/403 means the credential is dead. A network failure is not an
      // expired session and must not be reported as one.
      if (error.message.includes('HTTP 401') || error.message.includes('HTTP 403')) {
        return { state: 'expired', source: source };
      }
      return { state: 'unknown', source: source, message: error.message };
    }
  }
  
  async handleValidate(payload) {
    const { token, deviceId, debug } = payload;
    
    if (!token) {
      throw new RequestError('Bearer token is required', { status: 400 });
    }
    
    try {
      const devices = await this.discoverOmletDevices(token, debug);
      
      let deviceValid = false;
      if (deviceId) {
        deviceValid = devices.some(device => device.deviceId === deviceId);
      }
      
      return {
        success: true,
        tokenValid: true,
        deviceValid: deviceValid,
        devices: devices
      };
    } catch (error) {
      // Token is invalid if we get 401/403
      if (error.message.includes('HTTP 401') || error.message.includes('HTTP 403')) {
        return {
          success: false,
          tokenValid: false,
          deviceValid: false,
          devices: []
        };
      }
      
      throw new RequestError(`Validation failed: ${error.message}`, { status: 500 });
    }
  }
  
  async handleLogin(payload) {
    const { email, password, countryCode, debug } = payload;
    
    if (!email || !password || !countryCode) {
      throw new RequestError('Email, password, and country code are required', { status: 400 });
    }
    
    try {
      const token = await this.performOmletLogin(email, password, countryCode, debug);
      
      return {
        success: true,
        token: token
      };
    } catch (error) {
      throw new RequestError(`Login failed: ${error.message}`, { status: 401 });
    }
  }
  
  async handleDiscover(payload) {
    const { token, debug } = payload;
    
    if (!token) {
      throw new RequestError('Bearer token is required', { status: 400 });
    }
    
    try {
      const devices = await this.discoverOmletDevices(token, debug);
      
      return {
        success: true,
        devices: devices
      };
    } catch (error) {
      throw new RequestError(`Discovery failed: ${error.message}`, { status: 500 });
    }
  }
  
  performOmletLogin(email, password, countryCode, debug = false) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        emailAddress: email,
        password: password,
        cc: countryCode
      });
      
      const options = {
        hostname: 'x107.omlet.co.uk',
        port: 443,
        path: '/api/v1/login',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      
      if (debug) {
        console.log('=== OMLET LOGIN REQUEST ===');
        console.log('URL:', `https://${options.hostname}${options.path}`);
        console.log('Method:', options.method);
        console.log('Headers:', JSON.stringify(options.headers, null, 2));
        console.log('Body:', postData);
        console.log('===========================');
      }
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (debug) {
            console.log('Response Body:', data);
            console.log('Body Length:', data.length, 'bytes');
            console.log('============================');
          }
          
          if (res.statusCode === 200) {
            try {
              const response = JSON.parse(data);
              
              if (debug) {
                console.log('=== PARSED JSON ===');
                console.log(JSON.stringify(response, null, 2));
                console.log('===================');
              }
              
              const token = response.data?.api_key || 
                           response.data?.apiKey || 
                           response.data?.token ||
                           response.api_key ||
                           response.apiKey ||
                           response.token;
              
              if (token) {
                if (debug) {
                  console.log('✓ Token extracted:', token.substring(0, 20) + '...');
                }
                resolve(token);
              } else {
                if (debug) {
                  console.log('✗ NO TOKEN FOUND IN RESPONSE');
                  console.log('Response structure:', Object.keys(response));
                  if (response.data) {
                    console.log('Response.data structure:', Object.keys(response.data));
                  }
                }
                reject(new Error(`No API key found. Response keys: ${Object.keys(response).join(', ')}`));
              }
            } catch (e) {
              if (debug) {
                console.log('✗ JSON PARSE ERROR:', e.message);
              }
              reject(new Error(`JSON parse failed: ${e.message}. Raw data: ${data.substring(0, 200)}`));
            }
          } else {
            if (debug) {
              console.log('✗ NON-200 STATUS CODE');
            }
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });
      
      req.on('error', (error) => {
        if (debug) {
          console.log('✗ REQUEST ERROR:', error.message);
        }
        reject(error);
      });
      
      req.write(postData);
      req.end();
    });
  }
  
  discoverOmletDevices(token, debug = false) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'x107.omlet.co.uk',
        port: 443,
        path: '/api/v1/device',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      };
      
      if (debug) {
        console.log('=== OMLET DISCOVERY REQUEST ===');
        console.log('URL:', `https://${options.hostname}${options.path}`);
        console.log('Method:', options.method);
        console.log('Headers:', JSON.stringify({
          ...options.headers,
          'Authorization': 'Bearer ' + token.substring(0, 20) + '...'
        }, null, 2));
        console.log('===============================');
      }
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (debug) {
            console.log('Response Body:', data);
            console.log('Body Length:', data.length, 'bytes');
            console.log('================================');
          }
          
          if (res.statusCode === 200) {
            try {
              const response = JSON.parse(data);
              
              if (debug) {
                console.log('=== PARSED JSON ===');
                console.log(JSON.stringify(response, null, 2));
                console.log('===================');
              }
              
              // Check if response is directly an array OR has a data property with an array
              const devicesArray = Array.isArray(response) ? response : 
                                   (response.data && Array.isArray(response.data)) ? response.data : 
                                   null;
              
              if (devicesArray) {
                const devices = devicesArray.map(device => ({
                  deviceId: device.deviceId,
                  name: device.name || 'Unknown Device',
                  type: device.deviceType || 'Unknown',
                  // Surfaced so the settings page can show what auto-detection sees
                  lightEquipped: Number(device.configuration?.light?.equipped) > 0,
                  powerSource: device.state?.general?.powerSource || null,
                  batteryLevel: device.state?.general?.batteryLevel ?? null,
                  firmware: device.state?.general?.firmwareVersionCurrent || null
                }));
                if (debug) {
                  console.log('✓ Devices extracted:', devices.length);
                }
                resolve(devices);
              } else {
                if (debug) {
                  console.log('✗ NO DEVICES ARRAY FOUND');
                  console.log('Response is array?', Array.isArray(response));
                  console.log('Response structure:', typeof response === 'object' ? Object.keys(response) : typeof response);
                }
                reject(new Error(`No devices array found in response`));
              }
            } catch (e) {
              if (debug) {
                console.log('✗ JSON PARSE ERROR:', e.message);
              }
              reject(new Error(`JSON parse failed: ${e.message}. Raw data: ${data.substring(0, 200)}`));
            }
          } else {
            if (debug) {
              console.log('✗ NON-200 STATUS CODE');
            }
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });
      
      req.on('error', (error) => {
        if (debug) {
          console.log('✗ REQUEST ERROR:', error.message);
        }
        reject(error);
      });
      
      req.end();
    });
  }
}

(() => {
  return new OmletPluginUiServer();
})();
