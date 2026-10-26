import { common, abilityAccessCtrl } from '@kit.AbilityKit';
import { ble, constant, connection } from '@kit.ConnectivityKit';
import { socket } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';

export interface BluetoothPeer { id: string; name: string; }
export interface BluetoothSettings { enabled: boolean; id: string; name: string; transport?: string; }
class OutgoingFrame {
  bytes: ArrayBuffer;
  done: () => void;
  failed: (error: Error) => void;
  constructor(bytes: ArrayBuffer, done: () => void, failed: (error: Error) => void) {
    this.bytes = bytes; this.done = done; this.failed = failed;
  }
}

const SERVICE_ID = 'b4525100-17b0-4cb4-96a6-06c73a620c31';
const RECEIVE_ID = 'b4525101-17b0-4cb4-96a6-06c73a620c31';
const TRANSMIT_ID = 'b4525102-17b0-4cb4-96a6-06c73a620c31';
export const BLUETOOTH_URL = 'https://127.0.0.1:53320';

// One BLE GATT link multiplexes bounded local TLS connections. Discovery is
// untrusted; the original CA, certificate pin and paired session remain required.
export class BluetoothTunnel {
  static shared: BluetoothTunnel = new BluetoothTunnel();
  static lastError: string = '';
  static trace(message: string): void { hilog.info(0x3A11, 'NearBridgeBT', '%{public}s', message); }
  static failure(stage: string, error: Error): void {
    const code = (error as BusinessError).code;
    BluetoothTunnel.lastError = `${stage}：${error.message || '连接未完成'}${code ? ` (${code})` : ''}`;
    BluetoothTunnel.trace(BluetoothTunnel.lastError);
  }
  private server?: socket.TCPSocketServer;
  private gatt?: ble.GattClientDevice;
  private rx?: ble.BLECharacteristic;
  private starting?: Promise<void>;
  private closing: Promise<void> = Promise.resolve();
  private generation: number = 0;
  private pipes: Map<number, BluetoothPipe> = new Map();
  private nextId: number = 0;
  private mtu: number = 23;
  private queue: OutgoingFrame[] = [];
  private queueBytes: number = 0;
  private writing: boolean = false;
  private retryAfter: number = 0;

  retry(): void { this.retryAfter = 0; }
  private async deadline<T>(operation: Promise<T>, stage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${stage}超时，请重试蓝牙连接`)), 12000);
      operation.then((value: T) => { clearTimeout(timer); resolve(value); })
        .catch((error: Error) => { clearTimeout(timer); reject(error); });
    });
  }

  static async nearbyDevices(context: common.UIAbilityContext): Promise<BluetoothPeer[]> {
    const result = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(context, ['ohos.permission.ACCESS_BLUETOOTH']);
    if (result.authResults[0] !== 0) throw new Error('需要允许蓝牙权限才能连接 Mac');
    return BluetoothTunnel.scan();
  }
  private static async scan(): Promise<BluetoothPeer[]> {
    const scanner = ble.createBleScanner();
    const peers: Map<string, BluetoothPeer> = new Map();
    scanner.on('BLEDeviceFind', (report: ble.ScanReport) => {
      for (const result of report.scanResult) {
        if (result.connectable) peers.set(result.deviceId, { id: result.deviceId, name: result.deviceName || 'NearBridge Mac' });
      }
    });
    try {
      await scanner.startScan([{ serviceUuid: SERVICE_ID }], { dutyMode: ble.ScanDuty.SCAN_MODE_LOW_LATENCY, interval: 0 });
      await new Promise<void>(resolve => setTimeout(resolve, 3500));
      BluetoothTunnel.trace(`BLE discovery completed: ${peers.size} NearBridge device(s)`);
      return Array.from(peers.values());
    } finally {
      try { await scanner.stopScan(); } catch (_) {}
      scanner.off('BLEDeviceFind');
    }
  }
  async ensure(preferredId: string): Promise<void> {
    if (this.server && this.gatt && this.rx) return;
    if (this.starting) return this.starting;
    if (Date.now() < this.retryAfter) throw new Error(BluetoothTunnel.lastError || '蓝牙暂未连接，请稍候');
    this.stop();
    const generation = this.generation;
    this.starting = this.open(preferredId, generation);
    try { await this.starting; }
    catch (error) {
      if (generation === this.generation) {
        BluetoothTunnel.failure('蓝牙连接失败', error as Error);
        this.stop(); this.retryAfter = Number.MAX_SAFE_INTEGER;
      }
      throw error as Error;
    } finally { this.starting = undefined; }
  }
  private async open(preferredId: string, generation: number): Promise<void> {
    await this.closing;
    BluetoothTunnel.lastError = '';
    const peers = await BluetoothTunnel.scan();
    if (generation !== this.generation) throw new Error('连接已取消');
    let peer = peers.find((value: BluetoothPeer) => value.id === preferredId);
    if (!peer && peers.length === 1) peer = peers[0];
    if (!peer) throw new Error(peers.length ? '发现多台 Mac，请在设备页重新选择' : '未发现 Mac，请开启 Mac NearBridge 的蓝牙通道');
    const gatt = ble.createGattClientDevice(peer.id, { transport: connection.BluetoothTransport.TRANSPORT_LE, autoConnect: false });
    this.gatt = gatt;
    gatt.on('BLECharacteristicChange', (characteristic: ble.BLECharacteristic) => {
      if (generation !== this.generation || characteristic.characteristicUuid.toLowerCase() !== TRANSMIT_ID) return;
      const bytes = new Uint8Array(characteristic.characteristicValue);
      if (bytes.length < 2 || bytes[1] === 0) return;
      this.pipes.get(bytes[1])?.receive(bytes[0], characteristic.characteristicValue.slice(2));
    });
    gatt.on('BLEMtuChange', (mtu: number) => { this.mtu = mtu; });
    await new Promise<void>((resolve, reject) => {
      let connected = false;
      const timeout = setTimeout(() => reject(new Error('蓝牙连接超时')), 12000);
      gatt.on('BLEConnectionStateChange', (event: ble.BLEConnectionChangeState) => {
        if (generation !== this.generation) return;
        BluetoothTunnel.trace(`BLE connection state: ${event.state}`);
        if (event.state === constant.ProfileConnectionState.STATE_CONNECTED) {
          connected = true; clearTimeout(timeout); resolve();
        } else if (event.state === constant.ProfileConnectionState.STATE_DISCONNECTED) {
          clearTimeout(timeout);
          if (!connected) reject(new Error('蓝牙连接已断开'));
          else this.breakLink(new Error('Mac 蓝牙连接已断开'));
        }
      });
      try { gatt.connect(); } catch (error) { clearTimeout(timeout); reject(error as Error); }
    });
    BluetoothTunnel.trace('BLE discovering GATT services');
    const services = await this.deadline(gatt.getServices(), '发现蓝牙服务');
    const service = services.find((value: ble.GattService) => value.serviceUuid.toLowerCase() === SERVICE_ID);
    const rx = service?.characteristics.find((value: ble.BLECharacteristic) => value.characteristicUuid.toLowerCase() === RECEIVE_ID);
    const tx = service?.characteristics.find((value: ble.BLECharacteristic) => value.characteristicUuid.toLowerCase() === TRANSMIT_ID);
    if (!rx || !tx) throw new Error('Mac 蓝牙服务版本不匹配');
    BluetoothTunnel.trace('BLE GATT services found');
    try { this.mtu = await this.deadline(gatt.setBLEMtu(517), '协商传输大小'); } catch (_) { this.mtu = 23; }
    BluetoothTunnel.trace(`BLE subscribing, MTU=${this.mtu}`);
    await this.deadline(gatt.setCharacteristicChangeIndication(tx, true), '开启蓝牙接收');
    if (generation !== this.generation) throw new Error('连接已取消');
    this.rx = rx;
    BluetoothTunnel.trace(`BLE GATT ready, MTU=${this.mtu}`);
    const server = socket.constructTCPSocketServerInstance();
    server.on('connect', (client: socket.TCPSocketConnection) => {
      if (generation !== this.generation || this.pipes.size >= 4) { client.close().catch(() => {}); return; }
      do { this.nextId = this.nextId % 255 + 1; } while (this.pipes.has(this.nextId));
      const id = this.nextId;
      const pipe = new BluetoothPipe(client, (type: number, data: ArrayBuffer): Promise<void> => this.send(type, id, data),
        () => { this.pipes.delete(id); });
      this.pipes.set(id, pipe); pipe.start();
    });
    await server.listen({ address: '127.0.0.1', port: 53320, family: 1 });
    if (generation !== this.generation) { await server.close(); throw new Error('连接已取消'); }
    this.server = server;
    BluetoothTunnel.trace('BLE loopback TLS listener ready');
  }
  private async send(type: number, id: number, data: ArrayBuffer): Promise<void> {
    if (!this.gatt || !this.rx) throw new Error('蓝牙已断开');
    const size = Math.max(1, Math.min(512, this.mtu - 3) - 2);
    const bytes = new Uint8Array(data);
    for (let offset = 0; offset < Math.max(1, bytes.length); offset += size) {
      const count = Math.min(size, bytes.length - offset);
      const packet = new ArrayBuffer(2 + count);
      const frame = new Uint8Array(packet); frame[0] = type; frame[1] = id;
      if (count > 0) frame.set(bytes.subarray(offset, offset + count), 2);
      if (this.queueBytes + frame.length > 512 * 1024) throw new Error('蓝牙发送队列已满');
      await new Promise<void>((resolve, reject) => {
        const queued = new OutgoingFrame(packet, () => resolve(), (error: Error) => reject(error));
        this.queue.push(queued);
        this.queueBytes += frame.length; this.drain();
      });
    }
  }
  private async drain(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    const generation = this.generation;
    try {
      while (this.queue.length && this.gatt && this.rx && generation === this.generation) {
        const frame = this.queue[0];
        this.rx.characteristicValue = frame.bytes;
        try {
          await this.gatt.writeCharacteristicValue(this.rx, ble.GattWriteType.WRITE);
          if (generation !== this.generation) return;
          this.queue.shift(); this.queueBytes -= frame.bytes.byteLength; frame.done();
        } catch (error) { this.breakLink(error as Error); return; }
      }
    } finally { this.writing = false; }
  }
  private breakLink(error: Error): void {
    BluetoothTunnel.failure('蓝牙传输中断', error);
    this.stop(); this.retryAfter = Number.MAX_SAFE_INTEGER;
  }
  stop(): void {
    this.generation++;
    const active = Array.from(this.pipes.values()); this.pipes.clear();
    active.forEach((pipe: BluetoothPipe) => pipe.close(false));
    const queued = this.queue; this.queue = []; this.queueBytes = 0;
    queued.forEach((frame: OutgoingFrame) => frame.failed(new Error('蓝牙连接已关闭')));
    const server = this.server; this.server = undefined;
    if (server) this.closing = server.close().catch(() => {});
    const gatt = this.gatt; this.gatt = undefined; this.rx = undefined;
    if (gatt) {
      try { gatt.off('BLECharacteristicChange'); gatt.off('BLEConnectionStateChange'); gatt.off('BLEMtuChange'); } catch (_) {}
      try { gatt.disconnect(); } catch (_) {}
      try { gatt.close(); } catch (_) {}
    }
    this.mtu = 23;
  }
}

class BluetoothPipe {
  private client: socket.TCPSocketConnection;
  private send: (type: number, data: ArrayBuffer) => Promise<void>;
  private finished: () => void;
  private ready: boolean = false;
  private closed: boolean = false;
  private writing: boolean = false;
  private queue: ArrayBuffer[] = [];
  private queuedBytes: number = 0;
  private incomingBytes: number = 0;
  private incoming: Promise<void> = Promise.resolve();
  private timeout: number = -1;
  constructor(client: socket.TCPSocketConnection, send: (type: number, data: ArrayBuffer) => Promise<void>, finished: () => void) {
    this.client = client; this.send = send; this.finished = finished;
  }
  start(): void {
    this.touch();
    this.client.on('message', (event: socket.SocketMessageInfo) => {
      if (this.closed) return;
      if (this.queuedBytes + event.message.byteLength > 512 * 1024) { this.close(); return; }
      this.touch(); this.queue.push(event.message); this.queuedBytes += event.message.byteLength; this.drain();
    });
    this.client.on('close', () => this.close());
    this.client.on('error', () => this.close());
    this.send(1, new ArrayBuffer(0)).catch(() => this.close(false));
  }
  receive(type: number, data: ArrayBuffer): void {
    if (this.closed) return;
    this.touch();
    if (type === 2) { this.ready = true; this.drain(); }
    else if (type === 3) {
      if (this.incomingBytes + data.byteLength > 512 * 1024) { this.close(); return; }
      this.incomingBytes += data.byteLength;
      this.incoming = this.incoming.then(async () => {
        if (!this.closed) await this.client.send({ data: data });
        this.incomingBytes -= data.byteLength;
      }).catch(() => this.close());
    } else if (type === 4) { this.incoming.then(() => this.close(false)); }
  }
  private touch(): void {
    if (this.timeout >= 0) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => this.close(), 120000);
  }
  private async drain(): Promise<void> {
    if (this.writing || !this.ready || this.closed) return;
    this.writing = true;
    try {
      while (this.queue.length && !this.closed) {
        const data = this.queue.shift()!; this.queuedBytes -= data.byteLength;
        await this.send(3, data); this.touch();
      }
    } catch (_) { this.close(); }
    finally { this.writing = false; }
  }
  close(notify: boolean = true): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timeout >= 0) clearTimeout(this.timeout);
    this.queue = []; this.queuedBytes = 0;
    if (notify) this.send(4, new ArrayBuffer(0)).catch(() => {});
    this.client.close().catch(() => {}); this.finished();
  }
}
