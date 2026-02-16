const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const https = require('https');

class OmletPluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    
    this.onRequest('/login', this.handleLogin.bind(this));
    this.onRequest('/discover', this.handleDiscover.bind(this));
    this.onRequest('/validate', this.handleValidate.bind(this));
    
    this.ready();
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
      
      // LOG REQUEST (only if debug enabled)
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
        
        // LOG RESPONSE HEADERS (only if debug enabled)
        if (debug) {
          console.log('=== OMLET LOGIN RESPONSE ===');
          console.log('Status Code:', res.statusCode);
          console.log('Status Message:', res.statusMessage);
          console.log('Headers:', JSON.stringify(res.headers, null, 2));
        }
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          // LOG RESPONSE BODY (only if debug enabled)
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
      
      // LOG REQUEST (only if debug enabled)
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
        
        // LOG RESPONSE HEADERS (only if debug enabled)
        if (debug) {
          console.log('=== OMLET DISCOVERY RESPONSE ===');
          console.log('Status Code:', res.statusCode);
          console.log('Status Message:', res.statusMessage);
          console.log('Headers:', JSON.stringify(res.headers, null, 2));
        }
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          // LOG RESPONSE BODY (only if debug enabled)
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
                  type: device.deviceType || 'Unknown'
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
