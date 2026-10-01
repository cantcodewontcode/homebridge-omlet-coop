// Fakes enough of Homebridge, HAP, https and fs to exercise index.js in-process.
//
// Two things make the plugin testable at all: it is a single CommonJS file whose
// only requires are `https` and `fs`, and it hands its platform class to
// `registerPlatform`. So we intercept those two modules while loading it, and keep
// the class the module hands over.
//
// Time is faked throughout. The plugin's whole poll chain is setTimeout-driven, so
// a controllable clock is what turns "wait an hour" into one synchronous call.

const Module = require('module');
const path = require('path');
const assert = require('node:assert');

const PLUGIN = path.join(__dirname, '..', 'index.js');

// ---------- clock

function makeClock() {
  const state = { now: 1700000000000, timers: [], seq: 0 };

  const setTimeoutFake = (fn, ms) => {
    const timer = { id: ++state.seq, at: state.now + (ms || 0), fn };
    state.timers.push(timer);
    return timer.id;
  };

  const clearTimeoutFake = (id) => {
    state.timers = state.timers.filter(t => t.id !== id);
  };

  // Lets anything awaiting a resolved promise run before the next timer fires.
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      await Promise.resolve();
    }
  };

  const advance = async (ms) => {
    const end = state.now + ms;
    
    for (;;) {
      state.timers.sort((a, b) => (a.at - b.at) || (a.id - b.id));
      const next = state.timers[0];
      
      if (!next || next.at > end) {
        break;
      }
      
      state.timers.shift();
      state.now = next.at;
      next.fn();
      await settle();
    }
    
    state.now = end;
    await settle();
  };

  return { state, setTimeoutFake, clearTimeoutFake, settle, advance,
           now: () => state.now, pending: () => state.timers.length };
}

// ---------- fake Omlet cloud

function makeCloud() {
  const cloud = {
    token: 'goodtoken',
    devices: new Map(),
    requests: [],
    // Per-path overrides: { status, body } or a function(options, body).
    routes: new Map(),
    offline: false
  };

  cloud.addDevice = (device) => {
    cloud.devices.set(device.deviceId, device);
    return device;
  };

  cloud.respond = (options, body) => {
    cloud.requests.push({ method: options.method, path: options.path, body,
                          auth: (options.headers || {}).Authorization });

    if (cloud.offline) {
      return { networkError: new Error('ECONNREFUSED') };
    }

    const route = cloud.routes.get(options.path) || cloud.routes.get(options.method + ' ' + options.path);
    
    if (route) {
      return (typeof route === 'function') ? route(options, body) : route;
    }

    const bearer = String((options.headers || {}).Authorization || '').replace('Bearer ', '');

    if (options.path === '/api/v1/login') {
      const creds = JSON.parse(body || '{}');
      return (creds.password === 'goodpassword')
        ? { status: 200, body: JSON.stringify({ apiKey: cloud.token }) }
        : { status: 401, body: '' };
    }

    if (bearer !== cloud.token) {
      return { status: 401, body: JSON.stringify({ message: 'Authorization information is missing or invalid. Check the API key and retry' }) };
    }

    if (options.path === '/api/v1/group') {
      return { status: 200, body: JSON.stringify([{ devices: [...cloud.devices.values()] }]) };
    }

    const match = /^\/api\/v1\/device\/([^/]+)$/.exec(options.path);
    
    if (match) {
      const device = cloud.devices.get(match[1]);
      return device
        ? { status: 200, body: JSON.stringify(device) }
        : { status: 404, body: JSON.stringify({ message: 'Requested device not found' }) };
    }

    const action = /^\/api\/v1\/device\/([^/]+)\/action\/(.+)$/.exec(options.path);
    
    if (action) {
      return cloud.devices.has(action[1]) ? { status: 200, body: '' } : { status: 404, body: '' };
    }

    return { status: 404, body: '' };
  };

  return cloud;
}

// A device shaped as /api/v1/device returns it. Defaults mirror the live Autodoor
// captured in docs/OMLET-API.md (firmware 1.0.53, mains powered, light fitted).
function door(deviceId, name, opts = {}) {
  const state = {
    general: {
      firmwareVersionCurrent: '1.0.53',
      powerSource: opts.powerSource || 'external',
      batteryLevel: opts.batteryLevel === undefined ? 97 : opts.batteryLevel,
      uptime: 1000
    },
    connectivity: { ssid: 'wifi', wifiStrength: -42, connected: true },
    door: {
      state: opts.door || 'closed',
      fault: opts.fault || 'none',
      lightLevel: opts.lightLevel === undefined ? 66 : opts.lightLevel
    }
  };

  if (opts.light !== false) {
    state.light = { state: opts.light || 'off' };
  }

  return {
    deviceId, name: name || 'Omlet Coop',
    deviceType: 'Autodoor', deviceTypeId: 1,
    deviceSerial: 'SER' + deviceId,
    batteryCount: opts.batteryCount === undefined ? 0 : opts.batteryCount,
    state,
    configuration: {
      general: {},
      door: { openLightLevel: 27, closeLightLevel: 6, openMode: 'manual', closeMode: 'manual' },
      light: {}
    },
    actions: [
      { actionName: 'open', actionValue: 'open', pendingValue: 'openpending', url: '' },
      { actionName: 'close', actionValue: 'close', pendingValue: 'closepending', url: '' },
      { actionName: 'on', actionValue: 'on', pendingValue: 'onpending', url: '' },
      { actionName: 'off', actionValue: 'off', pendingValue: 'offpending', url: '' }
    ]
  };
}

// ---------- fake https, driven by the cloud above

function makeHttps(cloud, clock) {
  const listeners = () => {
    const handlers = {};
    return {
      on(event, fn) { (handlers[event] = handlers[event] || []).push(fn); return this; },
      emit(event, value) { (handlers[event] || []).forEach(fn => fn(value)); }
    };
  };

  return {
    request(options, callback) {
      let body = '';
      let destroyed = false;
      const req = listeners();

      req.write = (chunk) => { body += chunk; };
      req.setTimeout = (ms, fn) => { req.timeoutMs = ms; req.timeoutFn = fn; };
      req.destroy = () => { destroyed = true; };

      req.end = () => {
        Promise.resolve().then(() => {
          const result = cloud.respond(options, body);

          if (result.networkError) {
            req.emit('error', result.networkError);
            return;
          }

          if (result.timeout) {
            req.emit('timeout');
            return;
          }

          if (destroyed) {
            return;
          }

          const res = listeners();
          res.statusCode = result.status;
          res.setEncoding = () => {};
          callback(res);
          res.emit('data', result.body || '');
          res.emit('end');
        });
      };

      return req;
    }
  };
}

// ---------- fake fs (in-memory)

function makeFs(seed = {}) {
  const files = Object.assign({}, seed);

  return {
    files,
    existsSync: p => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        const err = new Error('ENOENT: no such file or directory, open ' + p);
        err.code = 'ENOENT';
        throw err;
      }
      return files[p];
    },
    writeFileSync: (p, data) => { files[p] = String(data); },
    renameSync: (a, b) => { files[b] = files[a]; delete files[a]; },
    unlinkSync: (p) => { delete files[p]; },
    mkdirSync: () => {},
    chmodSync: () => {}
  };
}

// ---------- minimal HAP

class FakeCharacteristic {
  constructor(name) { this.name = name; this.value = null; this.getter = null; this.setter = null; }
  onGet(fn) { this.getter = fn; return this; }
  onSet(fn) { this.setter = fn; return this; }
  updateValue(value) { this.value = value; return this; }
  setProps() { return this; }
  async read() { return this.getter ? this.getter() : this.value; }
  async write(value) { if (this.setter) { await this.setter(value); } this.value = value; }
}

class FakeService {
  constructor(type, name) {
    this.type = type;
    this.displayName = name;
    this.characteristics = new Map();
    this.linked = new Set();
  }
  getCharacteristic(c) {
    const key = (typeof c === 'function') ? c.characteristicName : String(c);
    if (!this.characteristics.has(key)) { this.characteristics.set(key, new FakeCharacteristic(key)); }
    return this.characteristics.get(key);
  }
  setCharacteristic(c, value) { this.getCharacteristic(c).updateValue(value); return this; }
  updateCharacteristic(c, value) { this.getCharacteristic(c).updateValue(value); return this; }
  setPrimaryService(flag) { this.primary = (flag !== false); return this; }
  addLinkedService(s) { this.linked.add(s); return this; }
  removeLinkedService(s) { this.linked.delete(s); return this; }
  value(c) { return this.getCharacteristic(c).value; }
}

function serviceClass(name) {
  const fn = function (displayName) { return new FakeService(name, displayName); };
  fn.serviceName = name;
  fn.UUID = name;
  return fn;
}

function characteristicClass(name, members = {}) {
  const fn = function () {};
  fn.characteristicName = name;
  fn.UUID = name;
  Object.assign(fn, members);
  return fn;
}

const hap = {
  Service: {
    AccessoryInformation: serviceClass('AccessoryInformation'),
    GarageDoorOpener: serviceClass('GarageDoorOpener'),
    Lightbulb: serviceClass('Lightbulb'),
    Battery: serviceClass('Battery')
  },
  Characteristic: {
    Name: characteristicClass('Name'),
    Manufacturer: characteristicClass('Manufacturer'),
    Model: characteristicClass('Model'),
    SerialNumber: characteristicClass('SerialNumber'),
    FirmwareRevision: characteristicClass('FirmwareRevision'),
    CurrentDoorState: characteristicClass('CurrentDoorState',
      { OPEN: 0, CLOSED: 1, OPENING: 2, CLOSING: 3, STOPPED: 4 }),
    TargetDoorState: characteristicClass('TargetDoorState', { OPEN: 0, CLOSED: 1 }),
    ObstructionDetected: characteristicClass('ObstructionDetected'),
    On: characteristicClass('On'),
    BatteryLevel: characteristicClass('BatteryLevel'),
    StatusLowBattery: characteristicClass('StatusLowBattery'),
    ChargingState: characteristicClass('ChargingState', { NOT_CHARGEABLE: 2 })
  },
  HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
  HapStatusError: class HapStatusError extends Error {
    constructor(status) { super('HAP ' + status); this.hapStatus = status; }
  },
  uuid: {
    // Not HAP's algorithm - only stability and uniqueness matter here.
    generate: (seed) => 'uuid-' + Buffer.from(String(seed)).toString('hex').slice(0, 24)
  }
};

class FakeAccessory {
  constructor(displayName, uuid) {
    this.displayName = displayName;
    this.UUID = uuid;
    this.context = {};
    this.services = [];
    // Real accessories are born with this one; the plugin sets Manufacturer and
    // friends on it without ever adding it.
    this.addService(hap.Service.AccessoryInformation);
  }
  getService(type) {
    const name = (typeof type === 'function') ? type.serviceName : String(type);
    return this.services.find(s => s.type === name) || undefined;
  }
  addService(type, displayName) {
    const name = (typeof type === 'function') ? type.serviceName : String(type);
    const existing = this.services.find(s => s.type === name);
    if (existing) { return existing; }
    const service = new FakeService(name, displayName);
    this.services.push(service);
    return service;
  }
  removeService(service) { this.services = this.services.filter(s => s !== service); }
  setPrimaryService() {}
}

// ---------- the Homebridge API object

function makeApi(fsFake, options = {}) {
  const handlers = {};

  return {
    hap,
    platformAccessory: FakeAccessory,
    serverVersion: '2.4.0',
    user: {
      storagePath: () => options.storagePath || '/storage',
      configPath: () => options.configPath || '/storage/config.json'
    },
    on(event, fn) { (handlers[event] = handlers[event] || []).push(fn); return this; },
    async fire(event) {
      for (const fn of (handlers[event] || [])) { await fn(); }
    },
    registered: [],
    unregistered: [],
    updated: [],
    registerPlatformAccessories(_p, _n, list) { this.registered.push(...list); },
    unregisterPlatformAccessories(_p, _n, list) { this.unregistered.push(...list); },
    updatePlatformAccessories(list) { this.updated.push(...list); }
  };
}

// ---------- loading the plugin with the fakes in place

function loadPlatformClass(fakes) {
  const original = Module._load;
  let Platform = null;

  Module._load = function (request, parent, isMain) {
    if (request === 'https') { return fakes.https; }
    if (request === 'fs') { return fakes.fs; }
    return original.apply(this, arguments);
  };

  try {
    delete require.cache[require.resolve(PLUGIN)];
    const register = require(PLUGIN);
    // The module reads api.hap at registration time and keeps it in a file-level
    // binding, so the fake hap has to arrive here rather than on the api object
    // the platform is later constructed with.
    register({ hap, registerPlatform: (_pluginName, _platformName, cls) => { Platform = cls; } });
  } finally {
    Module._load = original;
    delete require.cache[require.resolve(PLUGIN)];
  }

  assert.ok(Platform, 'index.js did not register a platform');
  return Platform;
}

// ---------- one call to build a world

function setup(options = {}) {
  const clock = makeClock();
  const cloud = makeCloud();
  const fsFake = makeFs(options.files);
  const httpsFake = makeHttps(cloud, clock);

  const logs = [];
  const record = level => (...args) => logs.push({ level, message: args.map(String).join(' ') });
  const log = { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') };

  const realTimers = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout, now: Date.now };
  global.setTimeout = clock.setTimeoutFake;
  global.clearTimeout = clock.clearTimeoutFake;
  Date.now = clock.now;

  const Platform = loadPlatformClass({ https: httpsFake, fs: fsFake });
  const api = makeApi(fsFake, options);
  const config = Object.assign({ platform: 'OmletCoop', name: 'Omlet Coop' }, options.config);
  const platform = new Platform(log, config, api);

  return {
    platform, api, cloud, clock, fs: fsFake, logs, config,
    said: (fragment) => logs.filter(l => l.message.includes(fragment)),
    saidOnce: (fragment) => logs.filter(l => l.message.includes(fragment)).length === 1,
    lines: () => logs.map(l => `${l.level}  ${l.message}`),
    // startPolling() schedules the first poll on a 0ms timer, so the clock has to
    // turn once for a freshly started platform to have talked to the cloud at all.
    start: async () => { await api.fire('didFinishLaunching'); await clock.advance(0); },
    accessory: () => api.registered[0] || platform.accessories[0],
    restore: () => {
      global.setTimeout = realTimers.setTimeout;
      global.clearTimeout = realTimers.clearTimeout;
      Date.now = realTimers.now;
    }
  };
}

module.exports = { setup, door, hap, FakeAccessory };
