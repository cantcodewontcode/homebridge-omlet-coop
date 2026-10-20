// Pulled out of server.js so it can be tested: server.js constructs the UI server
// as soon as it is required, which needs the Homebridge UI environment to exist.
// This function is pure - string in, string out - and it is what stands between a
// user's wifi name and a public issue thread.

// Replace identifying values with stable placeholders, so the same serial reads as
// the same placeholder everywhere it appears. The structure and the relationships
// between devices are what make a payload worth reading; the MAC addresses and the
// account holder's name are not.
const REDACTED_KEYS = ['emailaddress', 'email', 'firstname', 'lastname', 'ssid',
                       'deviceserial', 'deviceid', 'name', 'api_key', 'apikey', 'token',
                       'sitelink', 'displayline1', 'displayline2'];

function redactPayload(text) {
  let parsed;
  
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return text;
  }
  
  const seen = new Map();
  
  const label = (key, value) => {
    const bucket = key.toUpperCase();
    const id = bucket + '|' + value;
    
    if (!seen.has(id)) {
      const used = [...seen.keys()].filter(k => k.startsWith(bucket + '|')).length;
      seen.set(id, `[${bucket}_${used + 1}]`);
    }
    
    return seen.get(id);
  };
  
  const walk = (node) => {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    
    if (node && typeof node === 'object') {
      const out = {};
      
      Object.keys(node).forEach((key) => {
        const value = node[key];
        
        if (REDACTED_KEYS.includes(key.toLowerCase()) && typeof value === 'string' && value.trim()) {
          out[key] = label(key, value);
        } else {
          out[key] = walk(value);
        }
      });
      
      return out;
    }
    
    return node;
  };
  
  return JSON.stringify(walk(parsed), null, 2);
}

module.exports = { redactPayload, REDACTED_KEYS };
