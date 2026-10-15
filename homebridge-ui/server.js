const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { redactPayload } = require('./redact');

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
    this.onRequest('/capture-payload', this.handleCapturePayload.bind(this));
    this.onRequest('/reset-plugin', this.handleResetPlugin.bind(this));
    
    this.ready();
  }
  
  // Rewrites config.json directly. updatePluginConfig() could not be relied on to
  // REMOVE a key - omitting it from the staged block did not delete it - and a
  // credential left in config.json overrides the working one in storage.
  // Disconnect is a full reset: wipe the plugin's settings without having to
  // uninstall and reinstall. Credential trouble is Re-authenticate's job, and an
  // expired session already returns to the sign-in form on its own, so nothing
  // reaches this except a deliberate click.
  //
  // It edits config.json directly because updatePluginConfig merges - omitting a
  // key leaves the old value in place, which is the opposite of a reset.
  async handleResetPlugin() {
    const configPath = this.homebridgeConfigPath;
    
    if (!configPath) {
      throw new RequestError('Homebridge config path is unavailable', { status: 500 });
    }
    
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      if (!Array.isArray(config.platforms)) {
        return { success: true, cleared: [] };
      }
      
      const cleared = [];
      
      config.platforms.forEach((block, index) => {
        if (!block || block.platform !== 'OmletCoop') {
          return;
        }
        
        const kept = { platform: 'OmletCoop', name: block.name || 'Omlet Coop' };
        
        Object.keys(block).forEach((key) => {
          // Homebridge owns anything underscore-prefixed. _bridge carries the child
          // bridge's identity, and dropping it would unpair every accessory from
          // HomeKit - which is well beyond resetting the plugin's settings.
          if (key.startsWith('_')) {
            kept[key] = block[key];
            return;
          }
          
          if (key !== 'platform' && key !== 'name') {
            cleared.push(key);
          }
        });
        
        config.platforms[index] = kept;
      });
      
      const tmpPath = `${configPath}.omlet-tmp`;
      
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 4));
      fs.renameSync(tmpPath, configPath);
      
      return { success: true, cleared: cleared };
    } catch (error) {
      throw new RequestError(`Failed to reset the plugin settings: ${error.message}`, { status: 500 });
    }
  }
  
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
  
  // One raw /api/v1/group response, on demand. The alternative was logging every
  // payload under debug, which at two polls a minute buries everything else - and
  // what you want is almost always a single snapshot.
  async handleCapturePayload(payload) {
    const { bearerToken, redact } = payload || {};
    const stored = this.readStoredCredentials();
    const token = (stored && stored.bearerToken) || bearerToken;
    
    if (!token) {
      throw new RequestError('No saved credential to capture with. Sign in first.', { status: 400 });
    }
    
    try {
      const body = await this.fetchGroupRaw(token);
      let text;
      
      try {
        text = JSON.stringify(JSON.parse(body), null, 2);
      } catch (parseError) {
        text = body;
      }
      
      return redact === false
        ? { payload: text, redacted: false }
        : { payload: redactPayload(text), redacted: true };
    } catch (error) {
      throw new RequestError(`Could not capture the payload: ${error.message}`, { status: 500 });
    }
  }
  
  fetchGroupRaw(token) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'x107.omlet.co.uk',
        port: 443,
        path: '/api/v1/group',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        timeout: 15000
      }, (res) => {
        let data = '';
        
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });
      
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      req.on('error', reject);
      req.end();
    });
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
      // Leave a marker rather than just deleting the file. The plugin uses it to
      // tell "the user asked to disconnect" apart from "credentials are missing
      // for some other reason", and removes the HomeKit accessories accordingly.
      fs.writeFileSync(this.tokenFilePath(), JSON.stringify({
        disconnected: true,
        lastUpdated: new Date().toISOString()
      }, null, 2));
      
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
        // Never the body: it is the account email address and password in plain
        // text, and the Homebridge log is the first thing people paste into a bug
        // report. Never the headers either, for the same reason.
        console.log(`[Omlet] POST https://${options.hostname}${options.path} (credentials withheld)`);
      }
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          // The login response body is where the issued API key arrives, so it is
          // never printed - not raw, not parsed.
          if (debug) {
            console.log(`[Omlet] Login response: HTTP ${res.statusCode}, ${data.length} bytes`);
          }
          
          if (res.statusCode === 200) {
            try {
              const response = JSON.parse(data);
              
              const token = response.data?.api_key || 
                           response.data?.apiKey || 
                           response.data?.token ||
                           response.api_key ||
                           response.apiKey ||
                           response.token;
              
              if (token) {
                if (debug) {
                  console.log('[Omlet] API key received and will be saved to storage');
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
        // A 20-character prefix of an API key is still part of an API key.
        console.log(`[Omlet] GET https://${options.hostname}${options.path}`);
      }
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          // Deliberately not the payload. It was printed twice over, raw and
          // parsed, every time the settings page opened - which buried everything
          // else in the log. "Capture device payload" in advanced settings is the
          // way to get one on purpose.
          if (debug) {
            console.log(`[Omlet] Discovery response: HTTP ${res.statusCode}, ${data.length} bytes`);
          }
          
          if (res.statusCode === 200) {
            try {
              const response = JSON.parse(data);
              
              // Check if response is directly an array OR has a data property with an array
              const devicesArray = Array.isArray(response) ? response : 
                                   (response.data && Array.isArray(response.data)) ? response.data : 
                                   null;
              
              if (devicesArray) {
                const devices = devicesArray.map(device => ({
                  deviceId: device.deviceId,
                  // The wifi MAC, and stable across a factory reset - so it is what
                  // per-device settings are keyed on, and what the list shows.
                  serial: device.deviceSerial || null,
                  name: device.name || 'Unknown Device',
                  type: device.deviceType || 'Unknown',
                  // Surfaced so the settings page can show what auto-detection sees
                  // Absent section means the device has no light at all - a feeder
                  // has no `configuration.light`. That is "not applicable", not
                  // "not fitted", and the settings page says nothing about it.
                  lightEquipped: device.configuration?.light
                    ? Number(device.configuration.light.equipped) > 0
                    : undefined,
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
