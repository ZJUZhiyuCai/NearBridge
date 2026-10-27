import { common } from '@kit.AbilityKit';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { picker, fileIo as fs } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { BridgeClient } from '../core/BridgeClient';
import { BluetoothTunnel, BluetoothPeer } from '../core/BluetoothTunnel';
import { BridgeState, BridgeItem, Workflow, Job } from '../core/Types';
import {
  Palette, palette, watchTheme, toneFor, glyphFor, glyph, isLink, isImageName, timeLabel, sizeLabel, TINT_TOP, TINT_BOTTOM
} from '../design/Theme';

@Entry
@Component
struct Index {
  // 既有状态（键名与含义不变）
  @StorageLink('paired') private paired: boolean = false;
  @StorageLink('macName') private macName: string = '我的电脑';
  @StorageLink('status') private status: string = '扫码连接你的电脑';
  @StorageLink('progress') private progress: string = '';
  @StorageLink('stateJSON') @Watch('updateState') private stateJSON: string = '{"items":[],"workflows":[],"jobs":[]}';
  @StorageLink('savedJSON') private savedJSON: string = '[]';
  @StorageLink('outgoingCount') private outgoingCount: number = 0;
  @StorageLink('autoReceive') private autoReceive: boolean = true;
  @StorageLink('useBluetooth') private useBluetooth: boolean = false;
  @StorageLink('connectionMode') private connectionMode: string = 'lan';
  @StorageLink('pendingAction') private pendingAction: string = '';
  @StorageLink('bluetoothName') private bluetoothName: string = '';
  @StorageLink('bluetoothCheck') private bluetoothCheck: string = '';
  // 外观：design/Theme.ets 写入
  @StorageProp('nbDark') private dark: boolean = false;
  // 可选结构化状态（见 BACKEND-REQUESTS.md）；缺省值即回落到旧行为
  @StorageProp('linkPhase') private linkPhase: string = '';
  @StorageProp('progressFraction') private progressFraction: number = -1;
  @StorageProp('transferPhase') private transferPhase: string = 'idle';

  @State private items: BridgeItem[] = [];
  @State private workflows: Workflow[] = [];
  @State private jobs: Job[] = [];
  @State private draft: string = '';
  @State private busy: boolean = false;
  @State private error: string = '';
  @State private bluetoothPeers: BluetoothPeer[] = [];
  @State private bluetoothListed: boolean = false;
  @State private scanningPeers: boolean = false;
  @State private showSettings: boolean = false;
  @State private runningFlow: string = '';
  @State private doneFlow: string = '';
  @State private sendingText: boolean = false;
  @State private showAllHistory: boolean = false;
  @State private pulse: boolean = false;

  aboutToAppear(): void {
    watchTheme(this.getUIContext().getHostContext() as common.Context);
    this.updateState();
    BridgeClient.shared.start();
  }

  private updateState(): void {
    try {
      const state = JSON.parse(this.stateJSON) as BridgeState;
      this.items = state.items; this.workflows = state.workflows; this.jobs = state.jobs;
    } catch (_) {}
  }

  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }

  private async execute(work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.error = '';
    try { await work(); }
    catch (error) { this.error = (error as Error).message || '操作未完成，请重试'; }
    finally { this.busy = false; }
  }

  // ---------- 既有动作（逻辑不变） ----------

  private async scan(): Promise<void> {
    const result = await scanBarcode.startScanForResult(this.context(), { scanTypes: [scanCore.ScanType.QR_CODE], enableMultiMode: false, enableAlbum: true });
    await BridgeClient.shared.pair(result.originalValue);
  }
  private async selectFiles(): Promise<void> {
    const uris = await new picker.DocumentViewPicker(this.context()).select({ maxSelectNumber: 50 });
    for (const uri of uris) await BridgeClient.shared.sendFile(uri);
  }
  private async selectPhotos(): Promise<void> {
    const result = await new photoAccessHelper.PhotoViewPicker().select({ MIMEType: photoAccessHelper.PhotoViewMIMETypes.IMAGE_VIDEO_TYPE, maxSelectNumber: 50 });
    for (const uri of result.photoUris) await BridgeClient.shared.sendFile(uri);
  }
  private async saveToFiles(item: BridgeItem): Promise<void> {
    const path = BridgeClient.shared.savedPath(item.id);
    if (!path) throw new Error('文件正在接收，请稍后再试');
    const destinations = await new picker.DocumentViewPicker(this.context()).save({ newFileNames: [item.name || '文件'] });
    if (!destinations.length) return;
    const source = fs.openSync(path, fs.OpenMode.READ_ONLY);
    const destination = fs.openSync(destinations[0], fs.OpenMode.READ_WRITE);
    try { fs.copyFileSync(source.fd, destination.fd); }
    finally { fs.closeSync(source); fs.closeSync(destination); }
    this.toast('已保存到所选位置');
  }
  private async copy(item: BridgeItem): Promise<void> {
    await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, item.text || ''));
    if (item.source === 'mac') await BridgeClient.shared.markTextReceived(item.id);
    this.toast('已复制');
  }

  // ---------- 新增动作（只用现有接口与系统能力） ----------

  private toast(message: string): void {
    this.getUIContext().getPromptAction().showToast({ message: message });
  }

  private async openLink(item: BridgeItem): Promise<void> {
    await this.context().openLink((item.text || '').trim());
    if (item.source === 'mac') await BridgeClient.shared.markTextReceived(item.id);
  }

  private sendDraft(): void {
    if (!this.canSend()) return;
    this.sendingText = true;
    this.execute(async () => {
      try {
        const text = this.draft;
        await BridgeClient.shared.sendText(text);
        if (this.draft === text) this.draft = '';
        this.toast('已发到电脑');
      } finally {
        this.sendingText = false;
      }
    });
  }

  private runFlow(flow: Workflow): void {
    if (this.busy) return;
    this.runningFlow = flow.id;
    this.execute(async () => {
      try {
        await BridgeClient.shared.runWorkflow(flow.id);
        this.doneFlow = flow.id;
        this.toast(`已交给电脑：${flow.name}`);
        setTimeout(() => { if (this.doneFlow === flow.id) this.doneFlow = ''; }, 1800);
      } finally {
        this.runningFlow = '';
      }
    });
  }

  private chooseMode(mode: string): void {
    this.execute(async () => {
      await BridgeClient.shared.setConnectionMode(mode);
      this.bluetoothListed = false;
      this.toast(mode === 'auto' ? '已开启自动连接' : (mode === 'bt' ? '已选择仅蓝牙' : '已选择仅局域网'));
    });
  }
  private discardAction(): void {
    this.execute(async () => {
      const choice = await this.getUIContext().getPromptAction().showDialog({
        title: '结束重试？', message: '这不会撤销电脑上已经执行的操作。请先检查电脑的结果，之后再次点按会发起一项新操作。',
        buttons: [{ text: '保留', color: this.c().text2 }, { text: '已检查，结束重试', color: this.c().tint }]
      });
      if (choice.index === 1) BridgeClient.shared.discardPendingAction();
    });
  }

  private findMacs(): void {
    this.execute(async () => {
      this.scanningPeers = true;
      this.bluetoothListed = true;
      try { this.bluetoothPeers = await BluetoothTunnel.nearbyDevices(this.context()); }
      finally { this.scanningPeers = false; }
    });
  }

  // ---------- 派生状态 ----------

  private c(): Palette { return palette(this.dark); }
  private canSend(): boolean { return !this.busy && this.draft.trim().length > 0; }
  private isSaved(item: BridgeItem): boolean { return this.savedJSON.includes(item.id); }

  /** 优先用后端的 linkPhase；没有时按旧状态文字粗略判断。 */
  private phase(): string {
    if (this.linkPhase) return this.linkPhase;
    const s = this.status;
    if (s.indexOf('失败') >= 0 || s.indexOf('无法') >= 0 || s.indexOf('断开') >= 0 || s.indexOf('离线') >= 0 || s.startsWith('未')) return 'offline';
    if (s.indexOf('已连接') >= 0 || s.indexOf('在线') >= 0) return 'online';
    return 'connecting';
  }
  private phaseLabel(): string {
    const p = this.phase();
    if (p === 'online') return '已连接';
    if (p === 'offline') return '未连接';
    if (p === 'waitingApproval') return '等待电脑允许';
    if (p === 'error') return '连接出错';
    return '正在连接';
  }
  private dotColor(): string {
    const p = this.phase();
    if (p === 'online') return this.c().tint;
    if (p === 'offline' || p === 'error') return this.c().warn;
    return this.c().text3;
  }
  private routeLabel(): string {
    const route = this.useBluetooth ? '蓝牙' : '局域网';
    return this.connectionMode === 'auto' ? `自动 · 当前${route}` : route;
  }
  private linkLine(): string { return `${this.phaseLabel()} · ${this.routeLabel()}`; }

  private sortedItems(): BridgeItem[] {
    return this.items.slice().sort((a: BridgeItem, b: BridgeItem) => a.createdAt < b.createdAt ? 1 : (a.createdAt > b.createdAt ? -1 : 0));
  }
  private historyItems(): BridgeItem[] {
    const all = this.sortedItems();
    return this.showAllHistory ? all : all.slice(0, 20);
  }
  private isLastHistory(item: BridgeItem): boolean {
    const list = this.historyItems();
    return list.length > 0 && list[list.length - 1].id === item.id;
  }
  /** 电脑发来、手机还没用过的最新一段文字（0 或 1 项，用 ForEach 以便内容切换时重建）。 */
  private freshFromMac(): BridgeItem[] {
    const list = this.sortedItems().filter((i: BridgeItem) => i.source === 'mac' && i.kind === 'text' && !i.receivedAt && !!i.text);
    return list.slice(0, 1);
  }
  private flowRows(): Workflow[][] {
    const rows: Workflow[][] = [];
    for (let i = 0; i < this.workflows.length; i += 2) rows.push(this.workflows.slice(i, i + 2));
    return rows;
  }
  private recentJobs(): Job[] { return this.jobs.slice(0, 3); }
  private isLastJob(job: Job): boolean {
    const list = this.recentJobs();
    return list.length > 0 && list[list.length - 1].id === job.id;
  }
  private jobState(job: Job): string {
    if (job.status === 'succeeded') return 'done';
    if (job.status === 'running' || job.status === 'queued' || job.status === 'pending') return 'running';
    return 'failed';
  }
  private jobLabel(job: Job): string {
    const state = this.jobState(job);
    if (state === 'done') return '已完成';
    if (state === 'running') return '运行中';
    return '未完成';
  }

  private itemMeta(item: BridgeItem): string {
    let state = '';
    if (item.source === 'phone') state = item.kind === 'text' ? '已发到电脑' : '已存入电脑';
    else if (item.kind === 'text') state = '来自电脑';
    else if (this.isSaved(item)) state = '已收到 · 仅在 App 内';
    else state = this.autoReceive ? '等待收取' : '未收取';
    const parts: string[] = [state];
    const size = item.kind === 'text' ? '' : sizeLabel(item.size);
    if (size) parts.push(size);
    const time = timeLabel(item.createdAt);
    if (time) parts.push(time);
    return parts.join(' · ');
  }
  private itemIcon(item: BridgeItem): Resource {
    if (item.kind === 'text') return isLink(item.text) ? glyph('open') : glyph('bubble');
    return isImageName(item.name) ? glyph('photo') : glyph('doc');
  }
  private showsPreview(item: BridgeItem): boolean {
    return item.source === 'mac' && item.kind !== 'text' && this.isSaved(item) && isImageName(item.name)
      && BridgeClient.shared.savedPath(item.id).length > 0;
  }
  private routeSelected(kind: string): boolean { return kind === this.connectionMode; }

  // ---------- 页面 ----------

  build() {
    Column() {
      if (this.error) { this.errorBanner() }
      if (!this.paired) { this.welcome() } else { this.home() }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.c().bg)
    .bindSheet(this.showSettings, this.settingsSheet(), {
      height: SheetSize.LARGE,
      dragBar: true,
      backgroundColor: this.c().bg,
      onDisappear: () => { this.showSettings = false; }
    })
  }

  @Builder errorBanner() {
    Column() {
      Row({ space: 10 }) {
        Text('!').fontSize(13).fontWeight(FontWeight.Bold).fontColor(Color.White)
          .width(20).height(20).borderRadius(10).textAlign(TextAlign.Center).backgroundColor(this.c().warn)
        Text(this.error).fontSize(14).fontColor(this.c().text).layoutWeight(1).maxLines(3)
        Button({ type: ButtonType.Circle, stateEffect: true }) {
          Image(glyph('close')).width(11).height(11).fillColor(this.c().text2)
        }
        .width(28).height(28).backgroundColor(this.c().fill)
        .onClick(() => { this.error = ''; })
      }
      .width('100%')
      .padding({ left: 14, right: 10, top: 10, bottom: 10 })
      .borderRadius(14)
      .backgroundColor(this.c().warnSoft)
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 8 })
  }

  // ----- 首次使用 -----

  @Builder welcome() {
    Column() {
      Blank()
      Stack() {
        ForEach([0, 1, 2], (i: number) => {
          Column() {}
            .width(118).height(118)
            .borderRadius(59)
            .backgroundColor(Color.Transparent)
            .border({ color: this.c().tint, width: 1.2 })
            .opacity(this.pulse ? 0 : 0.55)
            .scale({ x: this.pulse ? 2.1 : 1, y: this.pulse ? 2.1 : 1 })
            .animation({ duration: 2700, delay: i * 900, iterations: -1, curve: Curve.EaseOut })
        }, (i: number) => `ring${i}`)
        Column() {
          Image(glyph('laptop')).width(48).height(48).fillColor(this.c().tint)
        }
        .width(112).height(112).borderRadius(56)
        .justifyContent(FlexAlign.Center)
        .backgroundColor(this.c().card)
        .shadow({ radius: 24, color: this.c().shadow, offsetY: 8 })
      }
      .width(280).height(250)
      .onAppear(() => { setTimeout(() => { this.pulse = true; }, 80); })

      Text('连接你的电脑').fontSize(30).fontWeight(FontWeight.Bold).fontColor(this.c().text).margin({ top: 4 })
      Text('配对一次，以后打开就能用。').fontSize(15).fontColor(this.c().text2).margin({ top: 8 })

      Column() {
        this.stepRow(1, '手机和电脑连同一个 Wi‑Fi')
        Divider().color(this.c().separator).margin({ left: 36 })
        this.stepRow(2, '在电脑的 NearBridge 打开“设备连接”')
        Divider().color(this.c().separator).margin({ left: 36 })
        this.stepRow(3, '扫码后，在电脑上点“允许”')
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 4, bottom: 4 })
      .borderRadius(20)
      .backgroundColor(this.c().card)
      .margin({ top: 28 })

      Blank()

      Button({ type: ButtonType.Capsule, stateEffect: true }) {
        Row({ space: 8 }) {
          if (this.busy) {
            LoadingProgress().width(22).height(22).color(Color.White)
          } else {
            Image(glyph('scan')).width(20).height(20).fillColor(Color.White)
          }
          Text(this.busy ? '等待电脑允许…' : '扫码连接').fontSize(17).fontWeight(FontWeight.Medium).fontColor(Color.White)
        }
      }
      .width('100%').height(54)
      .backgroundColor(this.c().tint)
      .enabled(!this.busy)
      .onClick(() => { this.execute(async () => { await this.scan(); }); })

      Text(this.busy ? '在电脑上点“允许”就完成了' : this.status)
        .fontSize(13).fontColor(this.c().text3).textAlign(TextAlign.Center).maxLines(2)
        .margin({ top: 12, bottom: 4 })
    }
    .width('100%')
    .layoutWeight(1)
    .padding({ left: 24, right: 24, top: 12, bottom: 24 })
  }

  @Builder stepRow(n: number, text: string) {
    Row({ space: 12 }) {
      Text(`${n}`).fontSize(13).fontWeight(FontWeight.Bold).fontColor(Color.White)
        .width(24).height(24).borderRadius(12).textAlign(TextAlign.Center).backgroundColor(this.c().tint)
      Text(text).fontSize(15).fontColor(this.c().text).layoutWeight(1)
    }
    .width('100%')
    .padding({ top: 13, bottom: 13 })
  }

  // ----- 首页 -----

  @Builder home() {
    Scroll() {
      Column() {
        this.header()
        ForEach(this.freshFromMac(), (item: BridgeItem) => { this.macCard(item) }, (item: BridgeItem) => item.id)
        this.sendTiles()
        this.composer()
        if (this.pendingAction) { this.pendingActionCard() }
        if (this.progress || this.outgoingCount > 0) { this.transferCard() }

        this.sectionTitle('快捷指令', '点一下，电脑就开始')
        if (this.workflows.length === 0) {
          this.flowEmpty()
        } else {
          ForEach(this.flowRows(), (row: Workflow[]) => { this.flowRow(row) },
            (row: Workflow[]) => row.map((f: Workflow) => `${f.id}:${f.name}:${f.description}`).join('|'))
        }
        if (this.jobs.length > 0) { this.recentRuns() }

        this.sectionTitle('最近', '')
        this.history()

        Text('NearBridge · 加密直连 · 仅在前台收发')
          .fontSize(12).fontColor(this.c().text3)
          .margin({ top: 28, bottom: 12 })
      }
      .width('100%')
      .padding({ left: 16, right: 16, bottom: 24 })
    }
    .width('100%')
    .layoutWeight(1)
    .align(Alignment.Top)
    .scrollBar(BarState.Off)
    .edgeEffect(EdgeEffect.Spring)
  }

  @Builder header() {
    Row({ space: 12 }) {
      Column({ space: 6 }) {
        Text(this.macName)
          .fontSize(32).fontWeight(FontWeight.Bold).fontColor(this.c().text)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        Row({ space: 6 }) {
          Column() {}.width(8).height(8).borderRadius(4).backgroundColor(this.dotColor())
          Text(this.linkLine()).fontSize(14).fontColor(this.c().text2).maxLines(1)
        }
        if (this.phase() !== 'online' && this.status) {
          Text(this.status).fontSize(12).fontColor(this.c().text3).maxLines(2)
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      Button({ type: ButtonType.Circle, stateEffect: true }) {
        Image(glyph('more')).width(18).height(18).fillColor(this.c().tint)
      }
      .width(38).height(38)
      .backgroundColor(this.c().card)
      .margin({ top: 4 })
      .onClick(() => { this.showSettings = true; })
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .padding({ top: 24, bottom: 18, left: 4 })
  }

  @Builder macCard(item: BridgeItem) {
    Column({ space: 10 }) {
      Row({ space: 6 }) {
        Image(glyph('laptop')).width(16).height(16).fillColor(this.c().tint)
        Text('电脑发来').fontSize(13).fontWeight(FontWeight.Medium).fontColor(this.c().tint)
        Blank()
        Text(timeLabel(item.createdAt)).fontSize(12).fontColor(this.c().text3)
      }
      .width('100%')
      Text(item.text || '')
        .fontSize(16).fontColor(this.c().text).width('100%')
        .maxLines(4).textOverflow({ overflow: TextOverflow.Ellipsis })
      Row({ space: 10 }) {
        if (isLink(item.text)) {
          this.pillButton('打开', glyph('open'), false, false, () => { this.execute(async () => { await this.openLink(item); }); })
        }
        this.pillButton('复制', glyph('copy'), true, false, () => { this.execute(async () => { await this.copy(item); }); })
      }
      .width('100%')
      .justifyContent(FlexAlign.End)
    }
    .width('100%')
    .padding(16)
    .borderRadius(20)
    .backgroundColor(this.c().card)
    .border({ width: 1.5, color: this.c().tintSoft })
    .margin({ bottom: 12 })
  }

  @Builder pillButton(label: string, icon: Resource, primary: boolean, always: boolean, action: () => void) {
    Button({ type: ButtonType.Capsule, stateEffect: true }) {
      Row({ space: 6 }) {
        Image(icon).width(15).height(15).fillColor(primary ? Color.White : this.c().tint)
        Text(label).fontSize(14).fontWeight(FontWeight.Medium).fontColor(primary ? Color.White : this.c().tint)
      }
    }
    .height(34)
    .padding({ left: 14, right: 14 })
    .backgroundColor(primary ? this.c().tint : this.c().tintSoft)
    .enabled(always || !this.busy)
    .onClick(() => { action(); })
  }

  @Builder sendTiles() {
    Row({ space: 12 }) {
      Button({ type: ButtonType.Normal, stateEffect: true }) {
        Column() {
          Column() {
            Image(glyph('photo')).width(24).height(24).fillColor(Color.White)
          }
          .width(44).height(44).borderRadius(22).justifyContent(FlexAlign.Center).backgroundColor('#33FFFFFF')
          Blank()
          Text('照片和视频').fontSize(17).fontWeight(FontWeight.Bold).fontColor(Color.White)
          Text('发到电脑').fontSize(12).fontColor('#D9FFFFFF').margin({ top: 2 })
        }
        .width('100%').height('100%')
        .alignItems(HorizontalAlign.Start)
        .padding(14)
      }
      .layoutWeight(1).height(124)
      .borderRadius(22)
      .backgroundColor(Color.Transparent)
      .linearGradient({ angle: 160, colors: [[TINT_TOP, 0.0], [TINT_BOTTOM, 1.0]] })
      .shadow({ radius: 16, color: '#330A6CFF', offsetY: 6 })
      .enabled(!this.busy)
      .opacity(this.busy ? 0.55 : 1)
      .onClick(() => { this.execute(async () => { await this.selectPhotos(); }); })

      Button({ type: ButtonType.Normal, stateEffect: true }) {
        Column() {
          Column() {
            Image(glyph('doc')).width(24).height(24).fillColor(this.c().tint)
          }
          .width(44).height(44).borderRadius(22).justifyContent(FlexAlign.Center).backgroundColor(this.c().tintSoft)
          Blank()
          Text('文件').fontSize(17).fontWeight(FontWeight.Bold).fontColor(this.c().text)
          Text('任意类型，最多 50 个').fontSize(12).fontColor(this.c().text2).margin({ top: 2 })
        }
        .width('100%').height('100%')
        .alignItems(HorizontalAlign.Start)
        .padding(14)
      }
      .layoutWeight(1).height(124)
      .borderRadius(22)
      .backgroundColor(this.c().card)
      .enabled(!this.busy)
      .opacity(this.busy ? 0.55 : 1)
      .onClick(() => { this.execute(async () => { await this.selectFiles(); }); })
    }
    .width('100%')
    .margin({ bottom: 12 })
  }

  @Builder composer() {
    Column() {
      TextArea({ text: this.draft, placeholder: `发给 ${this.macName} 的文字或链接` })
        .fontSize(16)
        .fontColor(this.c().text)
        .placeholderColor(this.c().text3)
        .caretColor(this.c().tint)
        .backgroundColor(Color.Transparent)
        .borderRadius(0)
        .constraintSize({ minHeight: 48, maxHeight: 160 })
        .padding({ left: 14, right: 14, top: 12, bottom: 4 })
        .onChange((text: string) => { this.draft = text; })
      Row() {
        // 系统安全控件：只有用户点按时才读取剪贴板，读入后先放进输入框确认
        PasteButton({ icon: PasteIconStyle.LINES, text: PasteDescription.PASTE, buttonType: ButtonType.Capsule })
          .fontSize(14)
          .fontColor(this.c().tint)
          .iconColor(this.c().tint)
          .backgroundColor(this.c().tintSoft)
          .padding({ left: 12, right: 14, top: 7, bottom: 7 })
          .onClick(async (_event: ClickEvent, result: PasteButtonOnClickResult) => {
            if (result === PasteButtonOnClickResult.SUCCESS) {
              await this.execute(async () => {
                const data = await pasteboard.getSystemPasteboard().getData();
                this.draft = data.getPrimaryText();
              });
            }
          })
        Blank()
        Button({ type: ButtonType.Circle, stateEffect: true }) {
          if (this.sendingText) {
            LoadingProgress().width(20).height(20).color(Color.White)
          } else {
            Image(glyph('up')).width(18).height(18).fillColor(Color.White)
          }
        }
        .width(36).height(36)
        .backgroundColor(this.canSend() || this.sendingText ? this.c().tint : this.c().fill)
        .enabled(this.canSend())
        .onClick(() => { this.sendDraft(); })
      }
      .width('100%')
      .padding({ left: 10, right: 10, top: 4, bottom: 10 })
    }
    .width('100%')
    .borderRadius(22)
    .backgroundColor(this.c().card)
    .margin({ bottom: 12 })
  }

  @Builder transferCard() {
    Column({ space: 10 }) {
      Row({ space: 12 }) {
        if (this.transferPhase === 'sending' || this.transferPhase === 'receiving') {
          LoadingProgress().width(24).height(24).color(this.c().tint)
        } else if (this.transferPhase === 'completed') {
          Image(glyph('check')).width(24).height(24).fillColor(this.c().tint)
        } else if (this.transferPhase === 'failed') {
          Text('!').fontSize(18).fontWeight(FontWeight.Bold).fontColor(this.c().warn).width(24).textAlign(TextAlign.Center)
        } else {
          Column() {
            Image(glyph('pause')).width(12).height(12).fillColor(this.c().tint)
          }
          .width(26).height(26).borderRadius(13).justifyContent(FlexAlign.Center).backgroundColor(this.c().tintSoft)
        }
        Column({ space: 3 }) {
          Text(this.progress || '有文件还没发完').fontSize(14).fontColor(this.c().text).maxLines(2)
          if (this.transferPhase === 'failed' || this.transferPhase === 'paused') {
            Text(this.transferPhase === 'paused' ? '已暂停，进度保留' : '未完成，进度保留')
              .fontSize(12).fontColor(this.c().text2)
          }
          if (this.outgoingCount > 0) {
            Text(`${this.outgoingCount} 个文件待发`).fontSize(12).fontColor(this.c().text2)
          }
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        if (this.outgoingCount > 0) {
          if (this.transferPhase === 'sending') {
            this.pillButton('暂停', glyph('pause'), false, true, () => { BridgeClient.shared.pauseSending(); })
          } else {
            this.pillButton('继续发送', glyph('up'), true, false, () => { this.execute(async () => { await BridgeClient.shared.retryOutgoing(); }); })
          }
        }
      }
      .width('100%')
      if (this.progressFraction >= 0) {
        Progress({ value: this.progressFraction * 100, total: 100, type: ProgressType.Linear })
          .color(this.c().tint)
          .backgroundColor(this.c().fill)
          .width('100%')
      }
    }
    .width('100%')
    .padding(14)
    .borderRadius(18)
    .backgroundColor(this.c().card)
    .margin({ bottom: 12 })
  }

  @Builder sectionTitle(title: string, hint: string) {
    Row() {
      Text(title).fontSize(22).fontWeight(FontWeight.Bold).fontColor(this.c().text)
      Blank()
      if (hint) { Text(hint).fontSize(13).fontColor(this.c().text3) }
    }
    .width('100%')
    .padding({ top: 18, bottom: 10, left: 4, right: 4 })
  }

  @Builder flowRow(row: Workflow[]) {
    Row({ space: 12 }) {
      ForEach(row, (flow: Workflow) => { this.flowTile(flow) }, (flow: Workflow) => flow.id)
      if (row.length === 1) { Column().layoutWeight(1) }
    }
    .width('100%')
    .margin({ bottom: 12 })
  }

  @Builder flowTile(flow: Workflow) {
    Button({ type: ButtonType.Normal, stateEffect: true }) {
      Column() {
        Row() {
          Image(glyph(glyphFor(flow.name))).width(26).height(26).fillColor(Color.White)
          Blank()
          if (this.runningFlow === flow.id) {
            LoadingProgress().width(22).height(22).color(Color.White)
          } else if (this.doneFlow === flow.id) {
            Column() {
              Image(glyph('check')).width(14).height(14).fillColor(toneFor(flow.id).bottom)
            }
            .width(24).height(24).borderRadius(12).justifyContent(FlexAlign.Center).backgroundColor(Color.White)
          }
        }
        .width('100%')
        Blank()
        Text(flow.name)
          .fontSize(16).fontWeight(FontWeight.Bold).fontColor(Color.White)
          .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
        if (flow.description) {
          Text(flow.description)
            .fontSize(12).fontColor('#D9FFFFFF').margin({ top: 2 })
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
      .width('100%').height('100%')
      .alignItems(HorizontalAlign.Start)
      .padding(14)
    }
    .layoutWeight(1).height(116)
    .borderRadius(20)
    .backgroundColor(Color.Transparent)
    .linearGradient({ angle: 160, colors: [[toneFor(flow.id).top, 0.0], [toneFor(flow.id).bottom, 1.0]] })
    .shadow({ radius: 12, color: '#26000000', offsetY: 4 })
    .opacity(this.busy && this.runningFlow !== flow.id ? 0.55 : 1)
    .enabled(!this.busy)
    .onClick(() => { this.runFlow(flow); })
  }

  @Builder flowEmpty() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        this.miniTile('camera', 3)
        this.miniTile('bolt', 1)
        this.miniTile('music', 5)
      }
      .margin({ bottom: 6 })
      Text('还没有快捷指令').fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.c().text)
      Text('在电脑 NearBridge 的“工作流”里添加并打开“手机可用”，按钮就会出现在这里。')
        .fontSize(13).fontColor(this.c().text2).textAlign(TextAlign.Center)
    }
    .width('100%')
    .padding(20)
    .borderRadius(20)
    .backgroundColor(this.c().card)
  }

  @Builder miniTile(icon: string, tone: number) {
    Column() {
      Image(glyph(icon)).width(18).height(18).fillColor(Color.White)
    }
    .width(36).height(36).borderRadius(10).justifyContent(FlexAlign.Center)
    .linearGradient({ angle: 160, colors: [[toneFor(`${tone}`).top, 0.0], [toneFor(`${tone}`).bottom, 1.0]] })
  }

  @Builder recentRuns() {
    Column() {
      Text('最近运行').fontSize(13).fontColor(this.c().text2).width('100%').padding({ left: 4, bottom: 8, top: 4 })
      Column() {
        ForEach(this.recentJobs(), (job: Job) => {
          Column() {
            Row({ space: 12 }) {
              if (this.jobState(job) === 'running') {
                LoadingProgress().width(18).height(18).color(this.c().tint)
              } else if (this.jobState(job) === 'done') {
                Image(glyph('check')).width(16).height(16).fillColor(this.c().tint)
              } else {
                Text('!').fontSize(14).fontWeight(FontWeight.Bold).fontColor(this.c().warn).width(18).textAlign(TextAlign.Center)
              }
              Column({ space: 2 }) {
                Text(job.name).fontSize(15).fontColor(this.c().text).maxLines(1)
                if (job.message) { Text(job.message).fontSize(12).fontColor(this.c().text2).maxLines(2) }
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
              Text(this.jobLabel(job)).fontSize(12).fontColor(this.c().text3)
            }
            .width('100%')
            .padding({ left: 14, right: 14, top: 11, bottom: 11 })
            if (!this.isLastJob(job)) { Divider().color(this.c().separator).margin({ left: 44 }) }
          }
        }, (job: Job) => `${job.id}|${job.status}|${job.message}`)
      }
      .width('100%')
      .borderRadius(18)
      .backgroundColor(this.c().card)
    }
    .width('100%')
  }

  @Builder history() {
    if (this.items.length === 0) {
      Column({ space: 6 }) {
        Image(glyph('bubble')).width(28).height(28).fillColor(this.c().text3)
        Text('还没有记录').fontSize(15).fontColor(this.c().text2)
        Text('发出去的和收到的都会出现在这里。').fontSize(13).fontColor(this.c().text3)
      }
      .width('100%')
      .padding(28)
      .borderRadius(18)
      .backgroundColor(this.c().card)
    } else {
      Column() {
        ForEach(this.historyItems(), (item: BridgeItem) => { this.historyRow(item) },
          (item: BridgeItem) => `${item.id}|${item.receivedAt || ''}`)
      }
      .width('100%')
      .borderRadius(18)
      .backgroundColor(this.c().card)
      .clip(true)
      if (this.items.length > 20) {
        Button(this.showAllHistory ? '收起' : `显示全部 ${this.items.length} 条`, { type: ButtonType.Capsule })
          .fontSize(14).fontColor(this.c().tint).backgroundColor(Color.Transparent)
          .margin({ top: 6 })
          .onClick(() => { this.showAllHistory = !this.showAllHistory; })
      }
    }
  }

  @Builder historyRow(item: BridgeItem) {
    Column() {
      Row({ space: 12 }) {
        Stack() {
          if (this.showsPreview(item)) {
            Image(`file://${BridgeClient.shared.savedPath(item.id)}`)
              .width(42).height(42).borderRadius(10).objectFit(ImageFit.Cover)
          } else {
            Column() {
              Image(this.itemIcon(item)).width(20).height(20).fillColor(item.source === 'mac' ? this.c().tint : this.c().text2)
            }
            .width(42).height(42).borderRadius(10).justifyContent(FlexAlign.Center)
            .backgroundColor(item.source === 'mac' ? this.c().tintSoft : this.c().fill)
          }
          Column() {
            Image(item.source === 'mac' ? glyph('down') : glyph('up')).width(9).height(9).fillColor(Color.White)
          }
          .width(17).height(17).borderRadius(9).justifyContent(FlexAlign.Center)
          .backgroundColor(item.source === 'mac' ? this.c().tint : '#8E8E93')
          .border({ width: 1.5, color: this.c().card })
          .position({ x: 30, y: 30 })
        }
        .width(48).height(48)

        Column({ space: 3 }) {
          Text(item.name || item.text || '')
            .fontSize(15).fontColor(this.c().text)
            .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(this.itemMeta(item)).fontSize(12).fontColor(this.c().text2).maxLines(1)
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        if (item.kind === 'text') {
          this.smallButton('复制', () => { this.execute(async () => { await this.copy(item); }); })
        } else if (item.source === 'mac' && this.isSaved(item)) {
          this.smallButton('另存为', () => { this.execute(async () => { await this.saveToFiles(item); }); })
        } else if (item.source === 'mac' && !this.autoReceive) {
          this.smallButton('接收', () => { this.execute(async () => { await BridgeClient.shared.receive(item); }); })
        }
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 10, bottom: 10 })
      if (!this.isLastHistory(item)) { Divider().color(this.c().separator).margin({ left: 72 }) }
    }
  }

  @Builder smallButton(label: string, action: () => void) {
    Button(label, { type: ButtonType.Capsule, stateEffect: true })
      .fontSize(13)
      .fontWeight(FontWeight.Medium)
      .fontColor(this.c().tint)
      .backgroundColor(this.c().tintSoft)
      .height(30)
      .padding({ left: 12, right: 12 })
      .enabled(!this.busy)
      .onClick(() => { action(); })
  }

  // ----- 连接与设置（半屏 Sheet） -----

  @Builder pendingActionCard() {
    Column({ space: 10 }) {
      Text(this.pendingAction).fontSize(15).fontWeight(FontWeight.Medium).fontColor(this.c().text).width('100%')
      Text('重试会继续同一项操作。不会因回执丢失而再次发送或执行。')
        .fontSize(12).fontColor(this.c().text2).width('100%')
      Row({ space: 12 }) {
        Button('重试确认').fontColor(Color.White).backgroundColor(this.c().tint).enabled(!this.busy)
          .onClick(() => { this.execute(async () => { const sent = await BridgeClient.shared.retryPendingAction(); if (sent && this.draft === sent) this.draft = ''; this.toast('电脑已确认接收'); }); })
        Button('结束重试').fontColor(this.c().text2).backgroundColor(Color.Transparent).enabled(!this.busy)
          .onClick(() => { this.discardAction(); })
      }
    }
    .padding(16).width('100%').borderRadius(18).backgroundColor(this.c().card).margin({ top: 12 })
  }

  @Builder settingsSheet() {
    Column() {
      Row() {
        Text('连接与设置').fontSize(20).fontWeight(FontWeight.Bold).fontColor(this.c().text)
        Blank()
        Button('完成', { type: ButtonType.Capsule })
          .fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.c().tint).backgroundColor(Color.Transparent)
          .onClick(() => { this.showSettings = false; })
      }
      .width('100%')
      .padding({ left: 20, right: 8, top: 8, bottom: 8 })

      if (this.error) { this.errorBanner() }

      Scroll() {
        Column() {
          Row({ space: 14 }) {
            Column() {
              Image(glyph('laptop')).width(28).height(28).fillColor(Color.White)
            }
            .width(56).height(56).borderRadius(16).justifyContent(FlexAlign.Center)
            .linearGradient({ angle: 160, colors: [[TINT_TOP, 0.0], [TINT_BOTTOM, 1.0]] })
            Column({ space: 4 }) {
              Text(this.macName).fontSize(18).fontWeight(FontWeight.Bold).fontColor(this.c().text).maxLines(1)
              Row({ space: 6 }) {
                Column() {}.width(7).height(7).borderRadius(4).backgroundColor(this.dotColor())
                Text(this.linkLine()).fontSize(13).fontColor(this.c().text2).maxLines(1)
              }
              if (this.status) { Text(this.status).fontSize(12).fontColor(this.c().text3).maxLines(2) }
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
          }
          .width('100%')
          .padding(16)
          .borderRadius(20)
          .backgroundColor(this.c().card)
          .margin({ top: 8 })

          this.groupTitle('连接方式')
          Row({ space: 12 }) {
            this.routeCard('auto', '自动', '优先高速连接', '', glyph('laptop'))
            this.routeCard('lan', '仅局域网', '适合大文件', '', glyph('wifi'))
            this.routeCard('bt', '仅蓝牙', '无需同一 Wi‑Fi', '', glyph('bluetooth'))
          }
          .width('100%')
          this.footnote('自动：优先使用局域网，连接不上时尝试已选的蓝牙电脑。正在传输时保持当前线路。选择“仅蓝牙”后，所有内容只走蓝牙。')
          if (this.connectionMode !== 'lan') {
            Button(this.bluetoothName ? `蓝牙电脑：${this.bluetoothName} · 更换` : '选择蓝牙电脑作为备用')
              .fontSize(14).fontColor(this.c().tint).backgroundColor(Color.Transparent).margin({ top: 8 })
              .enabled(!this.busy).onClick(() => { this.findMacs(); })
          }

          if (this.bluetoothListed) { this.peerList() }

          if (this.useBluetooth) {
            Column() {
              Row({ space: 10 }) {
                Column({ space: 3 }) {
                  Text('检查蓝牙连接').fontSize(16).fontColor(this.c().tint)
                  Text(this.bluetoothCheck || '会在电脑留下一份 32 KB 测试文件，并检查返回手机后的内容。')
                    .fontSize(12).fontColor(this.c().text2)
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)
                Image(glyph('chevron')).width(13).height(13).fillColor(this.c().text3)
              }
              .width('100%')
              .padding({ left: 16, right: 14, top: 12, bottom: 12 })
              .opacity(this.busy ? 0.5 : 1)
              .onClick(() => { this.execute(async () => { await BridgeClient.shared.checkBluetooth(); }); })
              Divider().color(this.c().separator).margin({ left: 16 })
              Row({ space: 10 }) {
                Text('重新连接蓝牙').fontSize(16).fontColor(this.c().tint).layoutWeight(1)
                Image(glyph('chevron')).width(13).height(13).fillColor(this.c().text3)
              }
              .width('100%')
              .padding({ left: 16, right: 14, top: 14, bottom: 14 })
              .opacity(this.busy ? 0.5 : 1)
              .onClick(() => { this.execute(async () => { await BridgeClient.shared.retryBluetooth(); }); })
            }
            .width('100%')
            .borderRadius(18)
            .backgroundColor(this.c().card)
            .margin({ top: 12 })
          }

          this.groupTitle('接收')
          Row() {
            Text('打开 App 时自动收取').fontSize(16).fontColor(this.c().text).layoutWeight(1)
            Toggle({ type: ToggleType.Switch, isOn: this.autoReceive })
              .selectedColor(this.c().tint)
              .onChange((value: boolean) => { this.execute(async () => { BridgeClient.shared.setAutoReceive(value); }); })
          }
          .width('100%')
          .padding({ left: 16, right: 12, top: 10, bottom: 10 })
          .borderRadius(18)
          .backgroundColor(this.c().card)
          this.footnote('电脑发来的文件先放在 NearBridge 里，点“另存为”导出。目前只在前台收取：离开 App 会暂停，回来继续。关闭自动收取后，可在记录里逐个点“接收”。')

          this.groupTitle('从其他 App 发送')
          Column({ space: 6 }) {
            Text('在图库或文件管理里点“分享”，选择“发送到电脑”。').fontSize(15).fontColor(this.c().text)
            Text('在分享页点一下“发送到电脑”即可，照片、文件、文字都行。').fontSize(13).fontColor(this.c().text2)
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
          .padding(16)
          .borderRadius(18)
          .backgroundColor(this.c().card)

          this.groupTitle('配对')
          Row({ space: 10 }) {
            Column({ space: 3 }) {
              Text('重新扫码连接').fontSize(16).fontColor(this.c().tint)
              Text('换了电脑或配对失效时使用；需要在电脑上点“允许”。').fontSize(12).fontColor(this.c().text2)
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
            Image(glyph('scan')).width(18).height(18).fillColor(this.c().tint)
          }
          .width('100%')
          .padding({ left: 16, right: 14, top: 12, bottom: 12 })
          .borderRadius(18)
          .backgroundColor(this.c().card)
          .opacity(this.busy ? 0.5 : 1)
          .onClick(() => { this.execute(async () => { await this.scan(); }); })

          Text('NearBridge · 加密直连').fontSize(12).fontColor(this.c().text3).margin({ top: 28, bottom: 36 })
        }
        .width('100%')
        .padding({ left: 16, right: 16 })
      }
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.c().bg)
  }

  @Builder groupTitle(title: string) {
    Text(title).fontSize(13).fontColor(this.c().text2).width('100%').padding({ left: 16, top: 24, bottom: 8 })
  }

  @Builder footnote(text: string) {
    Text(text).fontSize(12).lineHeight(18).fontColor(this.c().text3).width('100%').padding({ left: 16, right: 16, top: 8 })
  }

  @Builder routeCard(kind: string, title: string, sub: string, badge: string, icon: Resource) {
    Button({ type: ButtonType.Normal, stateEffect: true }) {
      Column({ space: 8 }) {
        Row() {
          Column() {
            Image(icon).width(20).height(20).fillColor(this.routeSelected(kind) ? Color.White : this.c().tint)
          }
          .width(38).height(38).borderRadius(19).justifyContent(FlexAlign.Center)
          .backgroundColor(this.routeSelected(kind) ? this.c().tint : this.c().tintSoft)
          Blank()
          if (this.routeSelected(kind)) {
            Image(glyph('check')).width(18).height(18).fillColor(this.c().tint)
          }
        }
        .width('100%')
        Row({ space: 6 }) {
          Text(title).fontSize(16).fontWeight(FontWeight.Bold).fontColor(this.c().text)
          if (badge) {
            Text(badge).fontSize(10).fontWeight(FontWeight.Medium).fontColor(this.c().tint)
              .padding({ left: 6, right: 6, top: 2, bottom: 2 }).borderRadius(8).backgroundColor(this.c().tintSoft)
          }
        }
        Text(sub).fontSize(12).fontColor(this.c().text2)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding(14)
    }
    .layoutWeight(1)
    .borderRadius(18)
    .backgroundColor(this.c().card)
    .border({ width: 2, color: this.routeSelected(kind) ? this.c().tint : Color.Transparent })
    .enabled(!this.busy)
    .onClick(() => { if (kind === 'bt' && !this.bluetoothName) { this.findMacs(); } else { this.chooseMode(kind); } })
  }

  @Builder peerList() {
    Column() {
      Row({ space: 8 }) {
        Text('附近的电脑').fontSize(13).fontColor(this.c().text2)
        if (this.scanningPeers) { LoadingProgress().width(16).height(16).color(this.c().text2) }
        Blank()
        if (!this.scanningPeers) {
          Button('重新查找', { type: ButtonType.Capsule })
            .fontSize(13).fontColor(this.c().tint).backgroundColor(Color.Transparent).height(28)
            .enabled(!this.busy)
            .onClick(() => { this.findMacs(); })
        }
      }
      .width('100%')
      .padding({ left: 16, right: 8, top: 10, bottom: 4 })

      if (!this.scanningPeers && this.bluetoothPeers.length === 0) {
        Text('没找到电脑。请在 Windows NearBridge 窗口顶部点“开启蓝牙”，再点“重新查找”。')
          .fontSize(13).fontColor(this.c().text2).width('100%')
          .padding({ left: 16, right: 16, bottom: 14 })
      }
      ForEach(this.bluetoothPeers, (peer: BluetoothPeer) => {
        Row({ space: 12 }) {
          Image(glyph('laptop')).width(22).height(22).fillColor(this.c().tint)
          Text(peer.name).fontSize(16).fontColor(this.c().text).layoutWeight(1).maxLines(1)
          if (this.useBluetooth && this.bluetoothName === peer.name) {
            Image(glyph('check')).width(16).height(16).fillColor(this.c().tint)
          } else {
            Text('使用').fontSize(14).fontColor(this.c().tint)
          }
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 12, bottom: 12 })
        .opacity(this.busy ? 0.5 : 1)
        .onClick(() => {
          this.execute(async () => {
            await BridgeClient.shared.useBluetoothDevice(peer.id, peer.name, this.connectionMode === 'auto');
            this.bluetoothListed = false;
            this.toast(`已选择蓝牙电脑：${peer.name}`);
          });
        })
      }, (peer: BluetoothPeer) => peer.id)
    }
    .width('100%')
    .borderRadius(18)
    .backgroundColor(this.c().card)
    .margin({ top: 12 })
  }
}
