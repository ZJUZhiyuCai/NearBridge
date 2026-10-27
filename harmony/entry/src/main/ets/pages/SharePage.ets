import { common } from '@kit.AbilityKit';
import { BridgeClient } from '../core/BridgeClient';
import { ShareRecord, ComputerSummary } from '../core/Types';
import { Palette, palette, watchTheme, glyph, isImageName, TINT_TOP, TINT_BOTTOM } from '../design/Theme';

@Entry({ useSharedStorage: true })
@Component
struct SharePage {
  @LocalStorageLink('shareJSON') private shareJSON: string = '[]';
  @LocalStorageLink('shareError') private shareError: string = '';
  @StorageLink('paired') private paired: boolean = false;
  // macName 为“当前电脑”的名称
  @StorageLink('macName') private macName: string = '我的电脑';
  @StorageLink('progress') private progress: string = '';
  @StorageLink('useBluetooth') private useBluetooth: boolean = false;
  @StorageProp('nbDark') private dark: boolean = false;
  // 可选结构化进度（见 BACKEND-REQUESTS.md）；-1 表示未知，只显示文字
  @StorageProp('progressFraction') private progressFraction: number = -1;
  // 我的电脑（BridgeClient 写入）
  @StorageProp('computersJSON') @Watch('updateComputers') private computersJSON: string = '[]';
  @StorageProp('activeComputerId') private activeComputerId: string = '';
  @StorageProp('computerPlatform') private computerPlatform: string = '';
  @State private busy: boolean = false;
  @State private finished: boolean = false;
  @State private paused: boolean = false;
  // 已完成条数：重试 / 继续时从这里接着发（原语义不变，改为 @State 以便显示）
  @State private completed: number = 0;
  // 一旦开始发送（哪怕暂停或出错），目标就锁定在当前电脑
  @State private started: boolean = false;
  @State private targetId: string = '';
  @State private targetName: string = '';
  @State private targetPlatform: string = '';
  @State private computers: ComputerSummary[] = [];
  @State private picking: boolean = false;
  @State private switching: string = '';
  @State private pickError: string = '';

  aboutToAppear(): void {
    watchTheme(this.getUIContext().getHostContext() as common.Context);
    this.updateComputers();
  }

  private updateComputers(): void {
    try {
      const list = JSON.parse(this.computersJSON) as ComputerSummary[];
      this.computers = Array.isArray(list) ? list.filter((computer: ComputerSummary) => !!computer && typeof computer.id === 'string') : [];
    } catch (_) {
      this.computers = [];
    }
  }

  private async send(): Promise<void> {
    if (!this.paired || !this.canSend()) return;
    this.busy = true; this.picking = false; this.shareError = ''; this.paused = false;
    try {
      if (!this.started) {
        this.targetId = this.activeComputerId;
        this.targetName = this.macName;
        this.targetPlatform = this.computerPlatform;
      }
      BridgeClient.shared.ensureComputer(this.targetId);
      this.started = true;
      const records = JSON.parse(this.shareJSON) as ShareRecord[];
      for (let i = this.completed; i < records.length; i++) {
        if (this.paused) throw new Error('发送已暂停，进度已保留');
        BridgeClient.shared.ensureComputer(this.targetId);
        const record = records[i];
        if (record.uri && record.uri.startsWith('file://')) await BridgeClient.shared.sendFile(record.uri, record.name);
        else if (record.text) await BridgeClient.shared.sendText(record.text);
        else throw new Error('这条分享内容没有可读取的文件或文字');
        this.completed = i + 1;
      }
      this.finished = true;
    } catch (error) { this.shareError = (error as Error).message; }
    finally { this.busy = false; }
  }

  private pause(): void {
    this.paused = true;
    BridgeClient.shared.pauseSending();
  }

  /** 只在还没开始发送、completed === 0 时允许；与首页使用同一个 selectComputer。 */
  private async chooseTarget(computer: ComputerSummary): Promise<void> {
    if (computer.id === this.activeComputerId) { this.picking = false; return; }
    if (!this.canChangeTarget()) return;
    this.switching = computer.id; this.pickError = '';
    try {
      await BridgeClient.shared.selectComputer(computer.id);
      // 只清本页局部状态；分享内容本身不变
      this.picking = false; this.shareError = ''; this.paused = false;
    } catch (error) {
      this.pickError = (error as Error).message || '没能切换电脑，请重试';
    } finally {
      this.switching = '';
    }
  }

  // ---------- 派生状态 ----------

  private c(): Palette { return palette(this.dark); }

  private records(): ShareRecord[] {
    try {
      const list = JSON.parse(this.shareJSON) as ShareRecord[];
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }
  private isFile(record: ShareRecord): boolean { return !!record.uri && record.uri.startsWith('file://'); }
  private images(): ShareRecord[] {
    return this.records().filter((r: ShareRecord) => this.isFile(r) && isImageName(r.name || r.uri));
  }
  private fan(): ShareRecord[] { return this.images().slice(0, 4); }
  private fanAngle(index: number): number { return (index - (this.fan().length - 1) / 2) * 7; }
  private fanOffset(index: number): number { return (index - (this.fan().length - 1) / 2) * 28; }
  private firstText(): string {
    const texts = this.records().filter((r: ShareRecord) => !this.isFile(r) && !!r.text);
    return texts.length ? texts[0].text : '';
  }
  private summary(): string {
    const list = this.records();
    if (!list.length) return '没有可发送的内容';
    const images = this.images().length;
    const texts = list.filter((r: ShareRecord) => !this.isFile(r) && !!r.text).length;
    const files = list.length - images - texts;
    const parts: string[] = [];
    if (images > 0) parts.push(`${images} 张图片`);
    if (files > 0) parts.push(`${files} 个文件`);
    if (texts > 0) parts.push(`${texts} 段文字`);
    return list.length === 1 ? parts.join('') : `${list.length} 项 · ${parts.join('、')}`;
  }
  private names(): string {
    const names = this.records().filter((r: ShareRecord) => this.isFile(r)).map((r: ShareRecord) => r.name || '未命名文件');
    if (!names.length) return '';
    const head = names.slice(0, 3).join('、');
    return names.length > 3 ? `${head} 等` : head;
  }
  private destinationName(): string { return (this.started ? this.targetName : this.macName) || '电脑'; }
  private destinationPlatform(): string { return this.started ? this.targetPlatform : this.computerPlatform; }
  private shortName(): string {
    const name = this.destinationName();
    return name.length > 12 ? `${name.substring(0, 11)}…` : name;
  }
  private platformTag(platform: string): string {
    if (platform === 'windows') return 'Windows';
    if (platform === 'macos') return 'Mac';
    return '';
  }
  private primaryLabel(): string {
    if (this.busy) return '正在发送…';
    if (this.finished) return `已存入 ${this.shortName()}`;
    if (this.paused) return `继续发送到 ${this.shortName()}`;
    if (this.shareError && this.completed > 0) return `继续发送到 ${this.shortName()}`;
    if (this.shareError) return `重试发送到 ${this.shortName()}`;
    return `发送到 ${this.shortName()}`;
  }
  private canSend(): boolean { return !this.busy && !this.finished && !this.switching && this.records().length > 0; }
  private canChangeTarget(): boolean {
    return this.paired && !this.busy && !this.finished && !this.started && this.completed === 0 && !this.switching && this.computers.length > 1;
  }
  /** 开始发送后显示目标已锁定的原因。 */
  private lockNote(): string {
    if (!this.started || this.finished || this.computers.length < 2) return '';
    const base = `已开始发到 ${this.destinationName()}，剩下的内容也会发到这台电脑。`;
    return this.completed === 0 && !this.busy ? `${base}如需改发其他电脑，请关闭此页后重新分享。` : base;
  }

  // ---------- 页面 ----------

  build() {
    Column() {
      Row({ space: 12 }) {
        Column() {
          Image(glyph('laptop')).width(24).height(24).fillColor(Color.White)
        }
        .width(46).height(46).borderRadius(14).justifyContent(FlexAlign.Center)
        .linearGradient({ angle: 160, colors: [[TINT_TOP, 0.0], [TINT_BOTTOM, 1.0]] })
        Column({ space: 3 }) {
          Text('发送到').fontSize(13).fontColor(this.c().text2)
          Row({ space: 6 }) {
            Text(this.paired || this.started ? this.destinationName() : '还没有电脑').fontSize(20).fontWeight(FontWeight.Bold).fontColor(this.c().text)
              .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).flexShrink(1)
            if (this.paired && this.platformTag(this.destinationPlatform())) {
              Text(this.platformTag(this.destinationPlatform()))
                .fontSize(11).fontWeight(FontWeight.Medium).fontColor(this.c().tint)
                .padding({ left: 6, right: 6, top: 2, bottom: 2 }).borderRadius(6).backgroundColor(this.c().tintSoft)
                .flexShrink(0)
            }
          }
          if (this.paired) {
            Row({ space: 4 }) {
              Image(this.useBluetooth ? glyph('bluetooth') : glyph('wifi')).width(12).height(12).fillColor(this.c().text2)
              Text(this.useBluetooth ? '蓝牙' : '局域网').fontSize(12).fontColor(this.c().text2)
            }
          }
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        if (this.canChangeTarget()) {
          Button(this.picking ? '收起' : '更换', { type: ButtonType.Capsule, stateEffect: true })
            .fontSize(14).fontWeight(FontWeight.Medium)
            .fontColor(this.c().tint).backgroundColor(this.c().tintSoft)
            .height(32).padding({ left: 14, right: 14 })
            .accessibilityText(this.picking ? '收起电脑列表' : '更换要发送到的电脑')
            .onClick(() => { this.picking = !this.picking; this.pickError = ''; })
        }
      }
      .width('100%')

      if (this.picking && this.canChangeTarget()) {
        this.targetPicker()
      }
      if (this.lockNote()) {
        Row({ space: 8 }) {
          Image(glyph('laptop')).width(14).height(14).fillColor(this.c().text3)
          Text(this.lockNote()).fontSize(12).fontColor(this.c().text2).layoutWeight(1)
        }
        .width('100%')
        .alignItems(VerticalAlign.Top)
        .margin({ top: 10 })
      }

      // 预览卡
      Column({ space: 12 }) {
        if (this.fan().length > 0) {
          Stack() {
            ForEach(this.fan(), (record: ShareRecord, index: number) => {
              Stack() {
                Image(glyph('photo')).width(28).height(28).fillColor(this.c().text3)
                Image(record.uri).width('100%').height('100%').objectFit(ImageFit.Cover)
              }
              .width(98).height(98)
              .borderRadius(16)
              .clip(true)
              .backgroundColor(this.c().fill)
              .border({ width: 3, color: this.c().card })
              .shadow({ radius: 10, color: '#26000000', offsetY: 4 })
              .rotate({ angle: this.fanAngle(index) })
              .translate({ x: this.fanOffset(index) })
              .zIndex(index)
            }, (record: ShareRecord, index: number) => `${index}|${record.uri}`)
          }
          .width('100%').height(136)
        } else if (this.firstText()) {
          Text(this.firstText())
            .fontSize(15).lineHeight(22).fontColor(Color.White)
            .maxLines(4).textOverflow({ overflow: TextOverflow.Ellipsis })
            .padding({ left: 14, right: 14, top: 10, bottom: 10 })
            .borderRadius(18)
            .linearGradient({ angle: 180, colors: [[TINT_TOP, 0.0], [TINT_BOTTOM, 1.0]] })
            .constraintSize({ maxWidth: '90%' })
        } else {
          Column() {
            Image(glyph('doc')).width(34).height(34).fillColor(this.c().tint)
          }
          .width(76).height(76).borderRadius(22).justifyContent(FlexAlign.Center).backgroundColor(this.c().tintSoft)
        }
        Text(this.summary()).fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.c().text)
        if (this.names()) {
          Text(this.names()).fontSize(12).fontColor(this.c().text2).maxLines(2).textAlign(TextAlign.Center)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
      .width('100%')
      .padding(20)
      .borderRadius(22)
      .backgroundColor(this.c().card)
      .margin({ top: 16 })

      // 状态
      if (!this.paired) {
        this.notice(this.c().warn, '还没添加电脑', '先打开 NearBridge，点“扫码添加电脑”，扫描 Windows 或 Mac 上的 NearBridge 配对码。添加后就能从这里直接发送。')
      } else if (this.finished) {
        Column({ space: 10 }) {
          Column() {
            Image(glyph('check')).width(34).height(34).fillColor(Color.White)
          }
          .width(72).height(72).borderRadius(36).justifyContent(FlexAlign.Center)
          .linearGradient({ angle: 160, colors: [[TINT_TOP, 0.0], [TINT_BOTTOM, 1.0]] })
          .shadow({ radius: 18, color: '#400A6CFF', offsetY: 6 })
          Text(`已存入 ${this.destinationName()}`).fontSize(22).fontWeight(FontWeight.Bold).fontColor(this.c().text)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(this.records().some((record: ShareRecord) => this.isFile(record))
            ? '文件在电脑收件目录中，文字在 NearBridge 互传页中。'
            : '在电脑的 NearBridge 互传页里查看文字和链接。').fontSize(13).fontColor(this.c().text2)
        }
        .width('100%')
        .margin({ top: 32 })
        .transition(TransitionEffect.OPACITY.combine(TransitionEffect.scale({ x: 0.9, y: 0.9 })))
      } else if (this.busy) {
        Column({ space: 10 }) {
          Row({ space: 10 }) {
            LoadingProgress().width(22).height(22).color(this.c().tint)
            Text(this.progress || '正在发送…').fontSize(14).fontColor(this.c().text).maxLines(2).layoutWeight(1)
            Text(`${Math.min(this.completed + 1, this.records().length)}/${this.records().length}`)
              .fontSize(13).fontColor(this.c().text2)
          }
          .width('100%')
          if (this.progressFraction >= 0) {
            Progress({ value: this.progressFraction * 100, total: 100, type: ProgressType.Linear })
              .color(this.c().tint).backgroundColor(this.c().fill).width('100%')
          }
        }
        .width('100%')
        .padding(16)
        .borderRadius(18)
        .backgroundColor(this.c().card)
        .margin({ top: 16 })
      } else if (this.shareError) {
        if (this.paused) {
          this.notice(this.c().tint, '已暂停', `已发 ${this.completed}/${this.records().length} 项，点“继续发送”从断点接着发。`)
        } else {
          this.notice(this.c().warn, this.completed > 0 ? `已发 ${this.completed}/${this.records().length} 项，剩下的没发出去` : '没有发出去', this.shareError)
        }
      }

      Blank()

      if (this.paired) {
        Button({ type: ButtonType.Capsule, stateEffect: true }) {
          Row({ space: 8 }) {
            if (this.finished) {
              Image(glyph('check')).width(18).height(18).fillColor(Color.White)
            } else if (!this.busy) {
              Image(glyph('up')).width(18).height(18).fillColor(Color.White)
            }
            Text(this.primaryLabel()).fontSize(17).fontWeight(FontWeight.Medium).fontColor(Color.White)
              .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .padding({ left: 16, right: 16 })
        }
        .width('100%')
        .height(54)
        .backgroundColor(this.c().tint)
        .opacity(this.canSend() ? 1 : 0.5)
        .enabled(this.canSend())
        .accessibilityText(this.primaryLabel())
        .onClick(() => { this.send(); })
        if (this.busy) {
          Button('暂停', { type: ButtonType.Capsule, stateEffect: true })
            .width('100%')
            .height(46)
            .fontSize(16)
            .fontColor(this.c().tint)
            .backgroundColor(this.c().tintSoft)
            .margin({ top: 10 })
            .onClick(() => { this.pause(); })
        }
      }
    }
    .width('100%')
    .height('100%')
    .padding({ left: 20, right: 20, top: 24, bottom: 28 })
    .backgroundColor(this.c().bg)
  }

  /** 内嵌电脑列表：只在开始发送前出现。 */
  @Builder targetPicker() {
    Column() {
      Text('发到哪台电脑').fontSize(13).fontColor(this.c().text2).width('100%')
        .padding({ left: 14, top: 12, bottom: 4 })
      ForEach(this.computers, (computer: ComputerSummary) => {
        Row({ space: 12 }) {
          Image(glyph('laptop')).width(20).height(20)
            .fillColor(computer.id === this.activeComputerId ? this.c().tint : this.c().text2)
          Row({ space: 6 }) {
            Text(computer.name).fontSize(16).fontColor(this.c().text)
              .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).flexShrink(1)
            if (this.platformTag(computer.platform)) {
              Text(this.platformTag(computer.platform)).fontSize(11).fontColor(this.c().text2).flexShrink(0)
            }
          }
          .layoutWeight(1)
          if (this.switching === computer.id) {
            LoadingProgress().width(18).height(18).color(this.c().tint)
          } else if (computer.id === this.activeComputerId) {
            Image(glyph('check')).width(16).height(16).fillColor(this.c().tint)
          }
        }
        .width('100%')
        .padding({ left: 14, right: 14, top: 12, bottom: 12 })
        .opacity(this.switching && this.switching !== computer.id ? 0.5 : 1)
        .accessibilityText(computer.id === this.activeComputerId ? `${computer.name}，当前目标` : `发到 ${computer.name}`)
        .onClick(() => { this.chooseTarget(computer); })
      }, (computer: ComputerSummary) => `${computer.id}|${computer.name}|${computer.platform}|${computer.id === this.activeComputerId}`)
      if (this.pickError) {
        Text(this.pickError).fontSize(12).fontColor(this.c().warn).width('100%')
          .padding({ left: 14, right: 14, bottom: 12 })
      }
    }
    .width('100%')
    .borderRadius(18)
    .backgroundColor(this.c().card)
    .margin({ top: 12 })
  }

  @Builder notice(color: string, title: string, detail: string) {
    Row({ space: 12 }) {
      Text('!').fontSize(14).fontWeight(FontWeight.Bold).fontColor(Color.White)
        .width(24).height(24).borderRadius(12).textAlign(TextAlign.Center).backgroundColor(color)
      Column({ space: 3 }) {
        Text(title).fontSize(15).fontWeight(FontWeight.Medium).fontColor(this.c().text)
        Text(detail).fontSize(13).fontColor(this.c().text2).maxLines(4)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .padding(16)
    .borderRadius(18)
    .backgroundColor(this.c().card)
    .margin({ top: 16 })
  }
}
