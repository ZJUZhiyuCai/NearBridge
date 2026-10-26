import { common } from '@kit.AbilityKit';
import { http, mdns } from '@kit.NetworkKit';
import { fileIo as fs, fileUri, hash } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { window } from '@kit.ArkUI';
import { BluetoothTunnel, BluetoothSettings, BLUETOOTH_URL } from './BluetoothTunnel';
import { BridgeState, StateUpdate, BridgeItem, PairedMac, PairingPayload, PairClaim, PairStatus, TransferReply, SavedFile, SendJob, ErrorReply } from './Types';

const CHUNK = 4 * 1024 * 1024;
const PRIVATE_URL = /^https:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):\d{1,5}$/;

export class BridgeClient {
  static shared: BridgeClient = new BridgeClient();
  private context?: common.Context;
  private directory: string = '';
  private paired?: PairedMac;
  private saved: SavedFile[] = [];
  private sendJobs: SendJob[] = [];
  private discovery?: mdns.DiscoveryService;
  private timer: number = -1;
  private active: boolean = false;
  private syncing: boolean = false;
  private revision: string = '';
  private syncFailures: number = 0;
  private requests: Set<http.HttpRequest> = new Set();
  private receiving: Map<string, Promise<void>> = new Map();
  private receivingQueue: boolean = false;
  private sending: boolean = false;
  private cancelRequested: boolean = false;
  private discoveryBusy: boolean = false;
  private lastDiscovery: number = 0;
  private connectionEpoch: number = 0;
  private progressEpoch: number = 0;
  private sessionRejected: boolean = false;
  private checkingBluetooth: boolean = false;
  private screenHolds: number = 0;
  private bluetooth: BluetoothSettings = { enabled: false, id: '', name: '' };

  init(context: common.Context): void {
    if (this.directory !== '') return;
    this.context = context;
    this.directory = `${context.filesDir}/nearbridge`;
    if (!fs.accessSync(this.directory)) fs.mkdirSync(this.directory);
    try { this.paired = JSON.parse(fs.readTextSync(`${this.directory}/paired.json`)) as PairedMac; } catch (_) {}
    try { this.saved = JSON.parse(fs.readTextSync(`${this.directory}/saved.json`)) as SavedFile[]; } catch (_) {}
    try { this.sendJobs = JSON.parse(fs.readTextSync(`${this.directory}/outgoing.json`)) as SendJob[]; } catch (_) {}
    try {
      const settings = JSON.parse(fs.readTextSync(`${this.directory}/bluetooth.json`)) as BluetoothSettings;
      if (/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(settings.id) || settings.id === '') {
        this.bluetooth = settings;
        // Retire the RFCOMM experiment and restore the working LAN transport.
        // BLE is an explicit choice; never label a LAN fallback as Bluetooth.
        if (settings.transport !== 'ble-v1') {
          this.bluetooth = { enabled: false, id: '', name: '', transport: 'ble-v1' };
          this.write('bluetooth.json', JSON.stringify(this.bluetooth));
        }
      }
    } catch (_) {}
    AppStorage.setOrCreate('useBluetooth', this.bluetooth.enabled);
    AppStorage.setOrCreate('bluetoothName', this.bluetooth.name);
    AppStorage.setOrCreate('bluetoothCheck', '');
    AppStorage.setOrCreate('paired', this.paired !== undefined && this.paired.session !== '');
    AppStorage.setOrCreate('macName', this.paired?.name || '我的 Mac');
    AppStorage.setOrCreate('status', this.paired ? '正在连接 Mac…' : '扫码连接你的 Mac');
    AppStorage.setOrCreate('linkPhase', this.paired?.session ? 'connecting' : 'offline');
    AppStorage.setOrCreate('progress', '');
    AppStorage.setOrCreate('progressFraction', -1);
    AppStorage.setOrCreate('transferPhase', 'idle');
    AppStorage.setOrCreate('stateJSON', '{"name":"","items":[],"workflows":[],"jobs":[]}');
    AppStorage.setOrCreate('savedJSON', JSON.stringify(this.saved));
    AppStorage.setOrCreate('outgoingCount', this.sendJobs.length);
    let autoReceive = true;
    try { autoReceive = fs.readTextSync(`${this.directory}/auto-receive`) !== 'false'; } catch (_) {}
    AppStorage.setOrCreate('autoReceive', autoReceive);
  }
  private write(name: string, contents: string): void {
    const temp = `${this.directory}/${name}.tmp`;
    const file = fs.openSync(temp, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try { fs.writeSync(file.fd, contents); fs.fsyncSync(file.fd); } finally { fs.closeSync(file); }
    fs.renameSync(temp, `${this.directory}/${name}`);
  }
  private persistPair(): void {
    if (this.paired) this.write('paired.json', JSON.stringify(this.paired));
    AppStorage.setOrCreate('paired', this.paired !== undefined && this.paired.session !== '');
    AppStorage.setOrCreate('macName', this.paired?.name || '我的 Mac');
  }
  private async request(route: string, method: http.RequestMethod = http.RequestMethod.GET, body?: string | ArrayBuffer,
    extraHeaders: Record<string, string> = {}, origin: string = '', anonymous: boolean = false): Promise<http.HttpResponse> {
    const pair = this.paired;
    if (!pair) throw new Error('请先扫码配对');
    const epoch = this.connectionEpoch;
    const bluetooth = this.bluetooth.enabled && !origin;
    if (bluetooth) await BluetoothTunnel.shared.ensure(this.bluetooth.id);
    if (epoch !== this.connectionEpoch) throw new Error('连接方式已切换或应用已暂停');
    const base = bluetooth ? BLUETOOTH_URL : (origin || pair.url);
    if (!bluetooth && !PRIVATE_URL.test(base)) throw new Error('只允许局域网内的 Mac 地址');
    const headers: Record<string, string> = { 'X-NearBridge': '1' };
    for (const name of Object.keys(extraHeaders)) headers[name] = extraHeaders[name];
    if (pair.session && !anonymous) headers['Authorization'] = `Bearer ${pair.session}`;
    if (body !== undefined) headers['Content-Type'] = typeof body === 'string' ? 'application/json' : 'application/octet-stream';
    const client = http.createHttp();
    this.requests.add(client);
    try {
      const options: http.HttpRequestOptions = {
        method: method, header: headers, extraData: body, expectDataType: http.HttpDataType.ARRAY_BUFFER,
        caPath: `${this.directory}/root.pem`, remoteValidation: 'system',
        certificatePinning: { publicKeyHash: pair.publicKeyHash, hashAlgorithm: 'SHA-256' },
        usingProxy: false, usingCache: false, connectTimeout: bluetooth ? 35000 : 4000,
        readTimeout: bluetooth ? 120000 : 30000, maxLimit: 20 * 1024 * 1024
      };
      const response = await client.request(base + route, options);
      if (epoch !== this.connectionEpoch) throw new Error('连接方式已切换或应用已暂停');
      if (response.responseCode < 200 || response.responseCode >= 300) {
        if (response.responseCode === 401 && pair.session && !anonymous) this.sessionRejected = true;
        const decoded = this.decode(response);
        let message = `Mac 返回 ${response.responseCode}`;
        try { message = (JSON.parse(decoded) as ErrorReply).error || message; } catch (_) {}
        throw new Error(message);
      }
      if (pair.session && !anonymous) this.sessionRejected = false;
      return response;
    } catch (error) {
      if (bluetooth) {
        BluetoothTunnel.trace(`HTTPS request failed: ${(error as Error).message}`);
        if (BluetoothTunnel.lastError) throw new Error(BluetoothTunnel.lastError);
      }
      throw error as Error;
    } finally { if (this.requests.delete(client)) client.destroy(); }
  }
  private decode(response: http.HttpResponse): string {
    return new util.TextDecoder().decodeToString(new Uint8Array(response.result as ArrayBuffer));
  }
  private async json<T>(route: string, method: http.RequestMethod = http.RequestMethod.GET, body: string = '',
    headers: Record<string, string> = {}): Promise<T> {
    const response = await this.request(route, method, body || undefined, headers);
    return JSON.parse(this.decode(response)) as T;
  }
  async pair(raw: string): Promise<void> {
    if (raw.length > 8000) throw new Error('二维码内容无效');
    const data = JSON.parse(raw) as PairingPayload;
    if (data.protocol !== 'nearbridge' || data.version !== 2 || !PRIVATE_URL.test(data.url) ||
      !/^[A-Za-z0-9_-]{43}$/.test(data.token) || !/^[A-Za-z0-9+/]{43}=$/.test(data.publicKeyHash) ||
      !/^[A-Za-z0-9+/=]{300,6000}$/.test(data.certificate)) throw new Error('请扫描 Mac 原生窗口中的配对码');
    const previous = this.paired;
    const previousBluetooth = this.bluetooth;
    let previousRoot = '';
    try { previousRoot = fs.readTextSync(`${this.directory}/root.pem`); } catch (_) {}
    this.stop();
    // A QR code identifies the new Mac's LAN endpoint. An old BLE selection
    // belongs to the previous pairing and must not intercept this handshake.
    this.bluetooth = { enabled: false, id: '', name: '', transport: 'ble-v1' };
    this.paired = { name: data.name, url: data.url, session: '', certificate: data.certificate, publicKeyHash: data.publicKeyHash };
    const lines = data.certificate.match(/.{1,64}/g) || [];
    this.write('root.pem', `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`);
    AppStorage.setOrCreate('status', '请在 Mac 确认配对请求');
    AppStorage.setOrCreate('linkPhase', 'waitingApproval');
    try {
      const claim = await this.json<PairClaim>('/api/pair', http.RequestMethod.POST,
        JSON.stringify({ token: data.token, name: 'Mate 70 Pro+', client: 'harmony-native' }));
      const deadline = Date.now() + 5 * 60000;
      while (Date.now() < deadline) {
        const result = await this.json<PairStatus>(`/api/pair/status?id=${claim.id}`, http.RequestMethod.GET, '', { 'X-Pair-Claim': claim.claim });
        if (result.status === 'rejected') throw new Error('Mac 拒绝了本次配对');
        if (result.status === 'approved' && result.session) {
          this.paired.session = result.session;
          this.sessionRejected = false;
          this.persistPair();
          this.write('bluetooth.json', JSON.stringify(this.bluetooth));
          AppStorage.setOrCreate('useBluetooth', false);
          AppStorage.setOrCreate('bluetoothName', '');
          this.start();
          return;
        }
        await new Promise<void>(resolve => setTimeout(resolve, 1200));
      }
      throw new Error('配对已过期，请在 Mac 刷新二维码');
    } catch (error) {
      this.paired = previous;
      this.bluetooth = previousBluetooth;
      if (previousRoot) this.write('root.pem', previousRoot);
      this.persistPair();
      if (previous?.session) this.start();
      else {
        AppStorage.setOrCreate('status', `连接未完成 · ${(error as Error).message}`);
        AppStorage.setOrCreate('linkPhase', 'error');
      }
      throw error as Error;
    }
  }
  start(): void {
    if (!this.paired?.session || this.active) return;
    this.active = true;
    if (AppStorage.get<string>('linkPhase') !== 'online') AppStorage.setOrCreate('linkPhase', 'connecting');
    this.updateScreenHold();
    this.tick();
  }
  stop(): void {
    this.connectionEpoch++;
    this.progressEpoch++;
    this.active = false;
    this.syncing = false;
    this.revision = '';
    this.syncFailures = 0;
    this.receivingQueue = false;
    this.receiving.clear();
    this.cancelRequested = true;
    AppStorage.setOrCreate('linkPhase', 'offline');
    AppStorage.setOrCreate('progressFraction', -1);
    if (this.screenHolds > 0) AppStorage.setOrCreate('transferPhase', 'paused');
    this.updateScreenHold();
    if (this.timer >= 0) clearTimeout(this.timer);
    this.timer = -1;
    // Destroying active HTTP tasks releases long polls and blocked transfers now,
    // instead of making the next foreground session wait for a 120 s timeout.
    this.requests.forEach((request: http.HttpRequest) => { try { request.destroy(); } catch (_) {} });
    this.requests.clear();
    try { this.discovery?.stopSearchingMDNS(); } catch (_) {}
    this.discovery = undefined;
    BluetoothTunnel.shared.stop();
  }
  async refresh(): Promise<void> {
    const epoch = this.connectionEpoch;
    const state = await this.json<BridgeState>('/api/state');
    if (epoch !== this.connectionEpoch) return;
    this.applyState(state);
    this.connectionReady();
  }
  private applyState(state: BridgeState): void {
    const next = state.revision || '';
    const previousParts = this.revision.split('.');
    const nextParts = next.split('.');
    if (next && nextParts[0] === previousParts[0] && Number(nextParts[1]) < Number(previousParts[1])) return;
    this.revision = next;
    const encoded = JSON.stringify(state);
    if (encoded !== AppStorage.get<string>('stateJSON')) AppStorage.setOrCreate('stateJSON', encoded);
  }
  private connectionReady(): void {
    this.sessionRejected = false;
    AppStorage.setOrCreate('status', this.bluetooth.enabled ? '已连接 · 纯蓝牙直传' : '已连接 · 局域网直传');
    AppStorage.setOrCreate('linkPhase', 'online');
  }
  private async tick(): Promise<void> {
    if (this.syncing || !this.active) return;
    this.syncing = true;
    const epoch = this.connectionEpoch;
    let delay = 0;
    try {
      if (this.revision) {
        const update = await this.json<StateUpdate>(`/api/changes?since=${encodeURIComponent(this.revision)}`);
        if (epoch !== this.connectionEpoch || !this.active) return;
        if (update.state) this.applyState(update.state);
        this.connectionReady();
      } else {
        await this.refresh();
      }
      if (epoch !== this.connectionEpoch || !this.active) return;
      this.syncFailures = 0;
      // Keep the notification channel responsive while a file is being received.
      this.receivePending();
      delay = this.revision ? 0 : 3000; // Compatibility with an older Mac build.
    } catch (error) {
      if (epoch === this.connectionEpoch && this.active) {
        this.revision = ''; // Bootstrap again after reconnect or a server rollback.
        this.connectionFailed(error as Error);
        if (!this.bluetooth.enabled) this.discover();
        this.syncFailures++;
        delay = Math.min(15000, 1000 * Math.pow(2, Math.min(4, this.syncFailures - 1)));
      }
    } finally {
      if (epoch === this.connectionEpoch) {
        this.syncing = false;
        if (this.active && !this.sessionRejected) {
          this.timer = setTimeout(() => { this.timer = -1; this.tick(); }, delay);
        }
      }
    }
  }
  private async receivePending(): Promise<void> {
    if (this.receivingQueue || this.sending || this.checkingBluetooth || !this.active || AppStorage.get<boolean>('autoReceive') === false) return;
    this.receivingQueue = true;
    const epoch = this.connectionEpoch;
    const snapshot = AppStorage.get<string>('stateJSON') || '{}';
    try {
      const state = JSON.parse(snapshot) as BridgeState;
      for (const item of (state.items || []).filter((item: BridgeItem) => item.source === 'mac' && item.kind === 'file')) {
        if (epoch !== this.connectionEpoch || !this.active || this.sending || AppStorage.get<boolean>('autoReceive') === false) break;
        await this.receive(item);
      }
    } catch (error) {
      if (epoch === this.connectionEpoch && !this.sending && AppStorage.get<string>('transferPhase') === 'failed') {
        AppStorage.setOrCreate('progress', `接收未完成 · ${(error as Error).message}`);
      }
    } finally {
      if (epoch === this.connectionEpoch) {
        this.receivingQueue = false;
        if (snapshot !== AppStorage.get<string>('stateJSON')) this.receivePending();
      }
    }
  }
  private connectionFailed(error: Error): void {
    AppStorage.setOrCreate('linkPhase', this.sessionRejected ? 'error' : 'offline');
    AppStorage.setOrCreate('status', this.sessionRejected ? '连接授权已失效，请重新扫码连接 Mac' : `等待 Mac 连接 · ${error.message}`);
  }
  private discover(): void {
    if (!this.context || !this.paired || this.discovery || Date.now() - this.lastDiscovery < 15000) return;
    this.lastDiscovery = Date.now();
    const epoch = this.connectionEpoch;
    try {
      this.discovery = mdns.createDiscoveryService(this.context, '_nearbridge._tcp');
      this.discovery.on('serviceFound', async (service: mdns.LocalServiceInfo) => {
        if (this.discoveryBusy || !this.context || !this.paired || !this.active) return;
        this.discoveryBusy = true;
        try {
          const resolved = await mdns.resolveLocalService(this.context, service);
          if (epoch !== this.connectionEpoch || !this.active) return;
          const candidate = `https://${resolved.host?.address}:${resolved.port}`;
          if (!PRIVATE_URL.test(candidate)) return;
          // Discovery is untrusted. No device credential is sent until TLS
          // validates against the QR root and pinned public key.
          await this.request('/api/bootstrap', http.RequestMethod.GET, undefined, {}, candidate, true);
          if (epoch !== this.connectionEpoch || !this.active) return;
          this.paired.url = candidate;
          this.persistPair();
          await this.refresh();
        } catch (_) { /* Ignore unrelated hosts and retry when the service renews. */ }
        finally { this.discoveryBusy = false; }
      });
      this.discovery.startSearchingMDNS();
      setTimeout(() => {
        if (epoch !== this.connectionEpoch) return;
        try { this.discovery?.stopSearchingMDNS(); } catch (_) {} this.discovery = undefined;
      }, 10000);
    } catch (_) { this.discovery = undefined; }
  }
  async sendText(text: string): Promise<void> {
    if (!text.trim()) throw new Error('请先输入文字或链接');
    await this.json<Object>('/api/items', http.RequestMethod.POST, JSON.stringify({ text: text }));
    await this.refreshAfterAction();
  }
  async runWorkflow(id: string): Promise<void> {
    await this.json<Object>(`/api/workflows/${encodeURIComponent(id)}/run`, http.RequestMethod.POST, JSON.stringify({ requestId: util.generateRandomUUID(true) }));
    await this.refreshAfterAction();
  }
  private async refreshAfterAction(): Promise<void> {
    // A committed action wakes the pending change request. Avoid a second full
    // snapshot before releasing the send/run button, especially over BLE.
    if (this.active && this.revision && AppStorage.get<string>('linkPhase') === 'online') return;
    const epoch = this.connectionEpoch;
    try { await this.refresh(); }
    catch (error) {
      // The action already committed on the Mac. Reporting it as failed invites
      // duplicate sends or a second workflow execution when the user retries.
      if (epoch === this.connectionEpoch) {
        this.connectionFailed(error as Error);
      }
    }
  }
  async markTextReceived(id: string): Promise<void> {
    await this.json<Object>(`/api/items/${id}/received`, http.RequestMethod.POST, '{}');
  }
  private saveJobs(): void {
    this.write('outgoing.json', JSON.stringify(this.sendJobs));
    AppStorage.setOrCreate('outgoingCount', this.sendJobs.length);
  }
  async sendFile(uri: string, suggestedName: string = ''): Promise<void> {
    if (this.sending) throw new Error('请等待当前发送完成');
    const file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
    let job: SendJob;
    try {
      const stat = fs.statSync(file.fd);
      const existing = this.sendJobs.find((value: SendJob) => value.uri === uri && value.size === stat.size && value.modified === stat.mtime);
      if (existing) job = existing;
      else {
        const name = suggestedName || new fileUri.FileUri(uri).name || '未命名文件';
        job = { id: util.generateRandomUUID(true), uri: uri, name: name, size: stat.size, modified: stat.mtime };
        this.sendJobs.push(job); this.saveJobs();
      }
    } finally { fs.closeSync(file); }
    await this.upload(job);
  }
  async retryOutgoing(): Promise<void> {
    this.cancelRequested = false;
    for (const job of this.sendJobs.slice()) {
      if (this.cancelRequested) throw new Error('发送已暂停，进度已保留');
      await this.upload(job);
    }
  }
  pauseSending(): void { this.cancelRequested = true; }
  private async upload(job: SendJob): Promise<void> {
    if (this.sending) throw new Error('正在发送其他文件');
    const file = fs.openSync(job.uri, fs.OpenMode.READ_ONLY);
    this.sending = true; this.cancelRequested = false;
    const progress = this.beginProgress(`正在发送 ${job.name}`, 'sending');
    let completed = false;
    this.holdScreen(1);
    try {
      const stat = fs.statSync(file.fd);
      if (stat.size !== job.size || stat.mtime !== job.modified) throw new Error('原文件已改变，请重新选择文件');
      const transfer = await this.json<TransferReply>('/api/transfers', http.RequestMethod.POST, JSON.stringify({ id: job.id, name: job.name, size: job.size }));
      let offset = transfer.offset;
      if (!transfer.item) {
        while (offset < job.size) {
          if (this.cancelRequested) throw new Error('发送已暂停，进度已保留');
          const chunk = new ArrayBuffer(Math.min(transfer.chunkSize, this.bluetooth.enabled ? 64 * 1024 : CHUNK, job.size - offset));
          const length = fs.readSync(file.fd, chunk, { offset: offset });
          if (length <= 0) throw new Error('文件读取中断');
          const result = await this.request(`/api/transfers/${job.id}?offset=${offset}`, http.RequestMethod.PUT, chunk.slice(0, length));
          offset = (JSON.parse(this.decode(result)) as TransferReply).offset;
          this.reportProgress(progress, `发送 ${job.name} · ${Math.floor(offset / Math.max(1, job.size) * 100)}%`, offset / Math.max(1, job.size));
        }
        if (this.cancelRequested) throw new Error('发送已暂停，进度已保留');
        await this.json<Object>(`/api/transfers/${job.id}/complete`, http.RequestMethod.POST, '{}');
      }
      this.sendJobs = this.sendJobs.filter((value: SendJob) => value.id !== job.id); this.saveJobs();
      this.reportProgress(progress, `${job.name} 已存入 Mac`, 1);
      completed = true;
      await this.refreshAfterAction();
    } finally {
      fs.closeSync(file); this.sending = false; this.holdScreen(-1);
      this.endProgress(progress, completed ? 'completed' : (this.cancelRequested ? 'paused' : 'failed'));
      if (this.active) this.receivePending();
    }
  }
  async receive(item: BridgeItem): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(item.id) || item.kind !== 'file' || item.source !== 'mac' ||
      !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !Number.isSafeInteger(item.size) || item.size === undefined || item.size < 0 || item.size > 512 * 1024 * 1024) return;
    const existing = this.receiving.get(item.id);
    if (existing) return existing;
    const epoch = this.connectionEpoch;
    const pending = this.receiveOnce(item);
    this.receiving.set(item.id, pending);
    try { await pending; }
    finally { if (epoch === this.connectionEpoch) this.receiving.delete(item.id); }
  }
  private async receiveOnce(item: BridgeItem): Promise<void> {
    const epoch = this.connectionEpoch;
    const saved = this.saved.find((value: SavedFile) => value.id === item.id);
    if (saved && saved.sha256 === item.sha256 && fs.accessSync(saved.path)) {
      if (!item.receivedAt) {
        const progress = this.beginProgress('文件已保存，正在确认收件…', 'receiving');
        try {
          await this.acknowledge(item);
          this.reportProgress(progress, `${item.name || '文件'} 已保存到手机 NearBridge 收件箱`, 1);
          this.endProgress(progress, 'completed');
        } catch (error) {
          this.reportProgress(progress, '文件已保存，连接恢复后确认收件', 1);
          this.endProgress(progress, 'paused');
          throw error as Error;
        }
      }
      return;
    }
    this.holdScreen(1);
    const progress = this.beginProgress(`正在接收 ${item.name || '文件'}`, 'receiving');
    let completed = false;
    try { await this.receiveFile(item, progress, epoch); completed = true; }
    finally {
      this.holdScreen(-1);
      const stored = this.saved.some((value: SavedFile) => value.id === item.id && value.sha256 === item.sha256);
      if (!completed && stored) this.reportProgress(progress, '文件已保存，连接恢复后确认收件', 1);
      this.endProgress(progress, completed ? 'completed' : ((!this.active || stored) ? 'paused' : 'failed'));
    }
  }
  private ensureActive(epoch: number): void {
    if (epoch !== this.connectionEpoch || !this.active) throw new Error('已暂停接收，返回应用后继续');
  }
  private async receiveFile(item: BridgeItem, progress: number, epoch: number): Promise<void> {
    this.ensureActive(epoch);
    if (item.size === undefined || !item.sha256) throw new Error('文件信息不完整');
    const folder = `${this.directory}/received/${item.id}`;
    if (!fs.accessSync(`${this.directory}/received`)) fs.mkdirSync(`${this.directory}/received`);
    if (!fs.accessSync(folder)) fs.mkdirSync(folder);
    const name = (item.name || '未命名文件').replace(/[\\/\x00-\x1f:]/g, '_').replace(/^\.+/, '') || '未命名文件';
    const target = `${folder}/${name}`;
    const partial = `${folder}/payload.part`;
    // If the app closed after renaming but before recording the receipt, recover
    // the verified file instead of downloading a second copy.
    // CoreFileKit returns uppercase hexadecimal; the wire format uses lowercase.
    if (!(fs.accessSync(target) && (await hash.hash(target, 'sha256')).toLowerCase() === item.sha256)) {
      this.ensureActive(epoch);
      const file = fs.openSync(partial, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE);
      try {
        let offset = fs.statSync(file.fd).size;
        if (offset > item.size) { fs.truncateSync(file.fd, 0); offset = 0; }
        while (offset < item.size) {
          this.ensureActive(epoch);
          const end = Math.min(item.size - 1, offset + (this.bluetooth.enabled ? 64 * 1024 : CHUNK) - 1);
          const response = await this.request(`/api/files/${item.id}`, http.RequestMethod.GET, undefined, { 'Range': `bytes=${offset}-${end}` });
          const chunk = response.result as ArrayBuffer;
          if (response.responseCode !== 206 || chunk.byteLength !== end - offset + 1) throw new Error('下载分块不完整');
          let written = 0;
          while (written < chunk.byteLength) {
            const count = fs.writeSync(file.fd, chunk.slice(written), { offset: offset + written });
            if (count <= 0) throw new Error('手机存储写入中断，请检查剩余空间');
            written += count;
          }
          fs.fsyncSync(file.fd);
          offset += chunk.byteLength;
          this.reportProgress(progress, `接收 ${name} · ${Math.floor(offset / Math.max(1, item.size) * 100)}%`, offset / Math.max(1, item.size));
        }
      } finally { fs.closeSync(file); }
      const digest = (await hash.hash(partial, 'sha256')).toLowerCase();
      this.ensureActive(epoch);
      if (digest !== item.sha256) {
        fs.unlinkSync(partial); throw new Error('文件校验失败，下次连接会重新接收');
      }
      fs.renameSync(partial, target);
    }
    this.ensureActive(epoch);
    this.saved = this.saved.filter((value: SavedFile) => value.id !== item.id);
    this.saved.push({ id: item.id, path: target, sha256: item.sha256 });
    this.write('saved.json', JSON.stringify(this.saved));
    AppStorage.setOrCreate('savedJSON', JSON.stringify(this.saved));
    await this.acknowledge(item);
    this.reportProgress(progress, `${name} 已保存到手机 NearBridge 收件箱`, 1);
  }
  private beginProgress(message: string, phase: string): number {
    const id = ++this.progressEpoch;
    AppStorage.setOrCreate('transferPhase', phase);
    this.reportProgress(id, message, 0);
    return id;
  }
  private reportProgress(id: number, message: string, fraction: number): void {
    if (id !== this.progressEpoch) return;
    AppStorage.setOrCreate('progress', message);
    AppStorage.setOrCreate('progressFraction', Math.min(1, Math.max(0, fraction)));
  }
  private endProgress(id: number, phase: string): void {
    // A finishing receive must not clear a newer upload's progress indicator.
    if (id === this.progressEpoch) {
      AppStorage.setOrCreate('progressFraction', -1);
      AppStorage.setOrCreate('transferPhase', phase);
    }
  }
  private holdScreen(delta: number): void {
    this.screenHolds = Math.max(0, this.screenHolds + delta);
    this.updateScreenHold();
  }
  private updateScreenHold(): void {
    if (!this.context) return;
    try {
      window.getLastWindow(this.context).then((current: window.Window) => {
        // Scoped to our foreground window; never changes system lock settings.
        current.setWindowKeepScreenOn(this.active && this.screenHolds > 0).catch(() => {});
      }).catch(() => {});
    } catch (_) {}
  }
  private writeBinary(path: string, bytes: ArrayBuffer): void {
    const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const count = fs.writeSync(file.fd, bytes.slice(offset), { offset: offset });
        if (count <= 0) throw new Error('测试文件写入中断');
        offset += count;
      }
      fs.fsyncSync(file.fd);
    } finally { fs.closeSync(file); }
  }
  async checkBluetooth(): Promise<void> {
    if (!this.bluetooth.enabled) throw new Error('请先选择蓝牙 Mac');
    if (this.checkingBluetooth || this.sending) throw new Error('请等待当前传输完成');
    this.checkingBluetooth = true; this.holdScreen(1);
    const id = util.generateRandomUUID(true);
    const name = `NearBridge蓝牙自检-${id.slice(0, 8)}.bin`;
    const path = `${this.directory}/${name}`;
    const returned = `${path}.returned`;
    let uploaded = false;
    const started = Date.now();
    AppStorage.setOrCreate('bluetoothCheck', '正在用 32 KB 测试文件检查双向传输…');
    try {
      const bytes = new ArrayBuffer(32771);
      const view = new Uint8Array(bytes);
      for (let index = 0; index < view.length; index++) view[index] = (index * 73 ^ id.charCodeAt(index % id.length) ^ (index >>> 8)) & 255;
      this.writeBinary(path, bytes);
      const expected = (await hash.hash(path, 'sha256')).toLowerCase();
      // Use the same resumable file upload path as user-selected files.
      await this.sendFile(path, name); uploaded = true;
      const state = await this.json<BridgeState>('/api/state');
      const item = state.items.find((value: BridgeItem) => value.source === 'phone' && value.name === name);
      if (!item || item.size !== bytes.byteLength || item.sha256 !== expected) throw new Error('Mac 收到的测试文件校验不一致');
      const reply = await this.request(`/api/files/${item.id}`, http.RequestMethod.GET, undefined,
        { 'Range': `bytes=0-${bytes.byteLength - 1}` });
      const body = reply.result as ArrayBuffer;
      if (reply.responseCode !== 206 || body.byteLength !== bytes.byteLength) throw new Error('返回的测试文件不完整');
      this.writeBinary(returned, body);
      if ((await hash.hash(returned, 'sha256')).toLowerCase() !== expected) throw new Error('返回手机的测试文件校验不一致');
      const elapsed = Math.max(1, Math.round((Date.now() - started) / 1000));
      AppStorage.setOrCreate('bluetoothCheck', `上次自检通过 · 双向 32 KB 文件校验一致 · ${elapsed} 秒`);
      BluetoothTunnel.trace(`BLE file round-trip verified: size=${bytes.byteLength} sha256=${expected} seconds=${elapsed}`);
    } catch (error) {
      AppStorage.setOrCreate('bluetoothCheck', `自检未完成：${(error as Error).message}`);
      throw error as Error;
    } finally {
      // A failed upload keeps its generated source for the normal retry queue.
      try { if (uploaded && fs.accessSync(path)) fs.unlinkSync(path); } catch (_) {}
      try { if (fs.accessSync(returned)) fs.unlinkSync(returned); } catch (_) {}
      this.checkingBluetooth = false; this.holdScreen(-1);
    }
  }
  private async acknowledge(item: BridgeItem): Promise<void> {
    await this.json<Object>(`/api/items/${item.id}/received`, http.RequestMethod.POST, JSON.stringify({ sha256: item.sha256 }));
  }
  savedPath(id: string): string { return this.saved.find((value: SavedFile) => value.id === id)?.path || ''; }
  setAutoReceive(value: boolean): void {
    this.write('auto-receive', value ? 'true' : 'false');
    AppStorage.setOrCreate('autoReceive', value);
  }
  async useBluetoothDevice(id: string, name: string): Promise<void> {
    if (!this.paired?.session) throw new Error('请先扫码配对 Mac');
    if (!/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(id)) throw new Error('蓝牙设备地址无效');
    this.stop();
    this.bluetooth = { enabled: true, id: id, name: name.slice(0, 80), transport: 'ble-v1' };
    BluetoothTunnel.shared.retry();
    this.write('bluetooth.json', JSON.stringify(this.bluetooth));
    AppStorage.setOrCreate('useBluetooth', true); AppStorage.setOrCreate('bluetoothName', this.bluetooth.name);
    AppStorage.setOrCreate('status', '正在连接蓝牙 Mac…');
    AppStorage.setOrCreate('linkPhase', 'connecting');
    const epoch = this.connectionEpoch;
    try { await this.refresh(); } finally { if (epoch === this.connectionEpoch) this.start(); }
  }
  useLocalNetwork(): void {
    this.stop(); this.bluetooth.enabled = false;
    this.write('bluetooth.json', JSON.stringify(this.bluetooth));
    AppStorage.setOrCreate('useBluetooth', false);
    AppStorage.setOrCreate('status', '正在连接局域网…'); this.start();
  }
  async retryBluetooth(): Promise<void> {
    this.stop(); BluetoothTunnel.shared.retry();
    AppStorage.setOrCreate('status', '正在重新连接蓝牙…');
    AppStorage.setOrCreate('linkPhase', 'connecting');
    const epoch = this.connectionEpoch;
    try { await this.refresh(); } finally { if (epoch === this.connectionEpoch) this.start(); }
  }
}
