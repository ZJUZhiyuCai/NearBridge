import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as module from "node:module";

const skip = typeof module.stripTypeScriptTypes !== "function";
const service = "b4525100-17b0-4cb4-96a6-06c73a620c31";
const peer = "11:22:33:44:55:66";
const flush = () => new Promise(resolve => setImmediate(resolve));

// Run the actual tunnel, including cancellation and backpressure, against a
// controllable radio/socket adapter. No OS Bluetooth state is changed.
function fixture(behavior = {}) {
  const devices = [], timers = new Map(), servers = [];
  let scans = 0, scansStopped = 0, serial = 0, now = 100000;
  const context = vm.createContext({
    hilog: { info() {} },
    constant: { ProfileConnectionState: { STATE_CONNECTED: 2, STATE_DISCONNECTED: 0 } },
    connection: { BluetoothTransport: { TRANSPORT_LE: 2 } },
    ble: {
      ScanDuty: { SCAN_MODE_LOW_LATENCY: 1 }, GattWriteType: { WRITE: 1 },
      createBleScanner() {
        const handlers = {};
        return { on: (event, fn) => { handlers[event] = fn; }, off: event => { delete handlers[event]; },
          async startScan() { scans++; handlers.BLEDeviceFind({ scanResult: [{ connectable: true, deviceId: peer, deviceName: "NearBridge Mac" }] }); },
          async stopScan() { scansStopped++; } };
      },
      createGattClientDevice(id) {
        const handlers = {};
        const device = { id, handlers, closed: false,
          on(event, fn) { handlers[event] = fn; }, off(event) { delete handlers[event]; },
          connect() { behavior.connect ? behavior.connect(device, devices.length) : queueMicrotask(() => device.emit(2)); },
          emit(state) { handlers.BLEConnectionStateChange?.({ state }); },
          async getServices() { return behavior.services ? behavior.services(device) : [{ serviceUuid: service, characteristics: [
            { characteristicUuid: service.replace("5100", "5101"), characteristicValue: new ArrayBuffer(0) },
            { characteristicUuid: service.replace("5100", "5102"), characteristicValue: new ArrayBuffer(0) },
          ] }]; },
          async setBLEMtu() { return 517; }, async setCharacteristicChangeIndication() {},
          async writeCharacteristicValue(value) { if (behavior.write) return behavior.write(value); },
          disconnect() {}, close() { device.closed = true; },
        };
        devices.push(device); return device;
      },
    },
    socket: { constructTCPSocketServerInstance() {
      const server = { closed: false, on() {},
        async listen() { if (behavior.listen) return behavior.listen(); }, async close() { server.closed = true; } };
      servers.push(server); return server;
    } },
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, Uint8Array, ArrayBuffer,
    Date: class extends Date { static now() { return now; } },
  });
  const source = fs.readFileSync(new URL("../harmony/entry/src/main/ets/core/BluetoothTunnel.ets", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace(/export /g, "");
  const Tunnel = new vm.Script(module.stripTypeScriptTypes(source) + "\nBluetoothTunnel;").runInContext(context);
  return { tunnel: new Tunnel(), devices, timers, servers, behavior,
    advance(ms) { now += ms; }, get scans() { return scans; }, get scansStopped() { return scansStopped; } };
}

test("remembered BLE devices reconnect without the 3500 ms discovery delay", { skip }, async () => {
  const f = fixture();
  await f.tunnel.ensure(peer);
  assert.equal(f.scans, 0);
  assert.equal(f.devices.length, 1);
  assert.equal(f.tunnel.connectedDeviceId, peer);
  await f.tunnel.send(3, 1, new Uint8Array(1200).buffer);
  assert.equal(f.timers.size, 0);
  f.tunnel.stop();
  assert.ok(f.devices[0].closed && f.servers[0].closed);
});

test("an unavailable remembered device falls back to discovery and stops scanning when found", { skip }, async () => {
  const f = fixture({ connect(device, count) { queueMicrotask(() => device.emit(count === 1 ? 0 : 2)); } });
  await f.tunnel.ensure(peer);
  assert.equal(f.scans, 1);
  assert.equal(f.scansStopped, 1);
  assert.ok(f.devices[0].closed);
  assert.equal(f.devices.length, 2);
  assert.equal(f.timers.size, 0);
  f.tunnel.stop();
});

test("cancelled connection work cannot clear or disconnect the next foreground connection", { skip }, async () => {
  const f = fixture({ connect() {} });
  const old = f.tunnel.ensure(peer);
  const cancelled = assert.rejects(old, /取消/);
  await flush(); f.tunnel.stop();
  const next = f.tunnel.ensure(peer);
  await cancelled; await flush();
  const shared = f.tunnel.ensure(peer);
  assert.equal(f.devices.length, 2, "new callers join the current attempt");
  f.devices[1].emit(2);
  await Promise.all([next, shared]);
  assert.ok(f.tunnel.server);
  assert.equal(f.timers.size, 0);
  f.tunnel.stop();
});

test("a late write failure on the previous connection cannot break the new one", { skip }, async () => {
  let rejectWrite;
  const f = fixture({ write() { return new Promise((_, reject) => { rejectWrite = reject; }); } });
  await f.tunnel.ensure(peer);
  const old = f.tunnel.send(3, 1, new Uint8Array([1]).buffer);
  const cancelled = assert.rejects(old, /关闭/);
  await flush(); f.tunnel.stop();
  f.behavior.write = undefined;
  await f.tunnel.ensure(peer);
  rejectWrite(new Error("late system callback"));
  await cancelled; await flush();
  assert.ok(f.tunnel.server && !f.devices[1].closed);
  await f.tunnel.send(3, 1, new Uint8Array([2]).buffer);
  assert.equal(f.tunnel.queueBytes, 0);
  f.tunnel.stop();
});

test("a hanging GATT or local listener is cancelled immediately and releases resources", { skip }, async () => {
  for (const stage of ["services", "listen"]) {
    const f = fixture({ [stage]: () => new Promise(() => {}) });
    const opening = f.tunnel.ensure(peer);
    const cancelled = assert.rejects(opening, /取消/);
    await flush(); f.tunnel.stop(); await cancelled;
    assert.ok(f.devices.every(value => value.closed));
    assert.ok(f.servers.every(value => value.closed));
    assert.equal(f.timers.size, 0);
  }
});

test("repeated radio failures use backoff and stop after three attempts until manual retry", { skip }, async () => {
  const f = fixture({ connect(device) { queueMicrotask(() => device.emit(0)); } });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(f.tunnel.ensure(peer));
    const count = f.devices.length;
    await assert.rejects(f.tunnel.ensure(peer));
    assert.equal(f.devices.length, count, "backoff must not touch the radio");
    f.advance(10000);
  }
  const count = f.devices.length;
  f.advance(60000); await assert.rejects(f.tunnel.ensure(peer));
  assert.equal(f.devices.length, count);
  f.behavior.connect = undefined; f.tunnel.retry();
  await f.tunnel.ensure(peer);
  assert.ok(f.tunnel.server);
  f.tunnel.stop();
});
