const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const https = require('https');

class OmletPluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    
    this.onRequest('/login', this.handleLogin.bind(this));
    this.onRequest('/discover', this.handleDiscover.bind(this));
    
    this.ready();
  }
  
  async handleLogin(payload) {
    const { email, password, countryCode } = payload;
    
    if (!email || !password || !countryCode) {
      throw new RequestError('Email, password, and country code are required', { status: 400 });
    }
    
    try {
      const token = await this.performOmletLogin(email, password, countryCode);
      
      return {
        success: true,
        token: token
      };
    } catch (error) {
      throw new RequestError(`Login failed: ${error.message}`, { status: 401 });
    }
  }
  
  async handleDiscover(payload) {
    const { token } = payload;
    
    if (!token) {
      throw new RequestError('Bearer token is required', { status: 400 });
    }
    
    try {
      const devices = await this.discoverOmletDevices(token);
      
      return {
        success: true,
        devices: devices
      };
    } catch (error) {
      throw new RequestError(`Discovery failed: ${error.message}`, { status: 500 });
    }
  }
  
  performOmletLogin(email, password, countryCode) {
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
      
      // LOG REQUEST
      console.log('=== OMLET LOGIN REQUEST ===');
      console.log('URL:', `https://${options.hostname}${options.path}`);
      console.log('Method:', options.method);
      console.log('Headers:', JSON.stringify(options.headers, null, 2));
      console.log('Body:', postData);
      console.log('===========================');
      
      const req = https.request(options, (res) => {
        let data = '';
        
        // LOG RESPONSE HEADERS
        console.log('=== OMLET LOGIN RESPONSE ===');
        console.log('Status Code:', res.statusCode);
        console.log('Status Message:', res.statusMessage);
        console.log('Headers:', JSON.stringify(res.headers, null, 2));
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          // LOG RESPONSE BODY
          console.log('Response Body:', data);
          console.log('Body Length:', data.length, 'bytes');
          console.log('============================');
          
          if (res.statusCode === 200) {
            try {
              const response = JSON.parse(data);
              
              console.log('=== PARSED JSON ===');
              console.log(JSON.stringify(response, null, 2));
              console.log('===================');
              
              const token = response.data?.api_key || 
                           response.data?.apiKey || 
                           response.data?.token ||
                           response.api_key ||
                           response.apiKey ||
                           response.token;
              
              if (token) {
                console.log('✓ Token extracted:', token.substring(0, 20) + '...');
                resolve(token);
              } else {
                console.log('✗ NO TOKEN FOUND IN RESPONSE');
                console.log('Response structure:', Object.keys(response));
                if (response.data) {
                  console.log('Response.data structure:', Object.keys(response.data));
                }
                reject(new Error(`No API key found. Response keys: ${Object.keys(response).join(', ')}`));
              }
            } catch (e) {
              console.log('✗ JSON PARSE ERROR:', e.message);
              reject(new Error(`JSON parse failed: ${e.message}. Raw data: ${data.substring(0, 200)}`));
            }
          } else {
            console.log('✗ NON-200 STATUS CODE');
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });
      
      req.on('error', (error) => {
        console.log('✗ REQUEST ERROR:', error.message);
        reject(error);
      });
      
      req.write(postData);
      req.end();
    });
  }
  
  discoverOmletDevices(token) {
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
      
      // LOG REQUEST
      console.log('=== OMLET DISCOVERY REQUEST ===');
      console.log('URL:', `https://${options.hostname}${options.path}`);
      console.log('Method:', options.method);
      console.log('Headers:', JSON.stringify({
        ...options.headers,
        'Authorization': 'Bearer ' + token.substring(0, 20) + '...'
      }, null, 2));
      console.log('===============================');
      
      const req = https.request(options, (res) => {
        let data = '';
        
        // LOG RESPONSE HEADERS
        console.log('=== OMLET DISCOVERY RESPONSE ===');
        console.log('Status Code:', res.statusCode);
        console.log('Status Message:', res.statusMessage);
        console.log('Headers:', JSON.stringify(res.headers, null, 2));
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          // LOG RESPONSE BODY
          console.log('Response Body:', data);
          console.log('Body Length:', data.length, 'bytes');
          console.log('================================');
          
          if (res.statusCode === 200) {
            try {
              const response = JSON.parse(data);
              
              console.log('=== PARSED JSON ===');
              console.log(JSON.stringify(response, null, 2));
              console.log('===================');
              
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
                console.log('✓ Devices extracted:', devices.length);
                resolve(devices);
              } else {
                console.log('✗ NO DEVICES ARRAY FOUND');
                console.log('Response is array?', Array.isArray(response));
                console.log('Response structure:', typeof response === 'object' ? Object.keys(response) : typeof response);
                reject(new Error(`No devices array found in response`));
              }
            } catch (e) {
              console.log('✗ JSON PARSE ERROR:', e.message);
              reject(new Error(`JSON parse failed: ${e.message}. Raw data: ${data.substring(0, 200)}`));
            }
          } else {
            console.log('✗ NON-200 STATUS CODE');
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });
      
      req.on('error', (error) => {
        console.log('✗ REQUEST ERROR:', error.message);
        reject(error);
      });
      
      req.end();
    });
  }
}

(() => {
  return new OmletPluginUiServer();
})();
