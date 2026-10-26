import { common } from '@kit.AbilityKit';
import { BridgeClient } from '../core/BridgeClient';
import { ShareRecord } from '../core/Types';
import { Palette, palette, watchTheme, glyph, isImageName, TINT_TOP, TINT_BOTTOM } from '../design/Theme';

@Entry({ useSharedStorage: true })
@Component
struct SharePage {
  @LocalStorageLink('shareJSON') private shareJSON: string = '[]';
  @LocalStorageLink('shareError') private shareError: string = '';
  @StorageLink('paired') private paired: boolean = false;
  @StorageLink('macName') private macName: string = '我的 Mac';
  @StorageLink('progress') private progress: string = '';
  @StorageLink('useBluetooth') private useBluetooth: boolean = false;
  @StorageProp('nbDark') private dark: boolean = false;
  // 可选结构化进度（见 BACKEND-REQUESTS.md）；-1 表示未知，只显示文字
  @StorageProp('progressFraction') private progressFraction: number = -1;
  @State private busy: boolean = false;
  @State private finished: boolean = false;
  @State private paused: boolean = false;
  // 已完成条数：重试 / 继续时从这里接着发（原语义不变，改为 @State 以便显示）
  @State private completed: number = 0;

  aboutToAppear(): void {
    watchTheme(this.getUIContext().getHostContext() as common.Context);
  }

  private async send(): Promise<void> {
    if (!this.paired || !this.canSend()) return;
    this.busy = true; this.shareError = ''; this.paused = false;
    try {
      const records = JSON.parse(this.shareJSON) as ShareRecord[];
      for (let i = this.completed; i < records.length; i++) {
        if (this.paused) throw new Error('发送已暂停，进度已保留');
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
  private primaryLabel(): string {
    if (this.busy) return '正在发送…';
    if (this.finished) return '已发送';
    if (this.paused) return '继续发送';
    if (this.shareError && this.completed > 0) return '继续发送';
    if (this.shareError) return '重试';
    return '发送到 Mac';
  }
  private canSend(): boolean { return !this.busy && !this.finished && this.records().length > 0; }

  // ---------- 页面 ----------

  build() {
    Column() {
      Row({ space: 12 }) {
        Column() {
          Image(glyph('laptop')).width(24).height(24).fillColor(Color.White)
        }
        .width(46).height(46).borderRadius(14).justifyContent(FlexAlign.Center)
        .linearGradient({ angle: 160, colors: [[TINT_TOP, 0.0], [TINT_BOTTOM, 1.0]] })
        Column({ space: 2 }) {
          Text('发送到').fontSize(13).fontColor(this.c().text2)
          Text(this.macName).fontSize(20).fontWeight(FontWeight.Bold).fontColor(this.c().text)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        if (this.paired) {
          Row({ space: 4 }) {
            Image(this.useBluetooth ? glyph('bluetooth') : glyph('wifi')).width(13).height(13).fillColor(this.c().tint)
            Text(this.useBluetooth ? '蓝牙' : '局域网').fontSize(12).fontColor(this.c().tint)
          }
          .padding({ left: 10, right: 10, top: 5, bottom: 5 })
          .borderRadius(14)
          .backgroundColor(this.c().tintSoft)
        }
      }
      .width('100%')

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
      .margin({ top: 20 })

      // 状态
      if (!this.paired) {
        this.notice(this.c().warn, '还没连接 Mac', '先打开 NearBridge，扫描 Mac 上的配对码。配对后就能从这里直接发送。')
      } else if (this.finished) {
        Column({ space: 10 }) {
          Column() {
            Image(glyph('check')).width(34).height(34).fillColor(Color.White)
          }
          .width(72).height(72).borderRadius(36).justifyContent(FlexAlign.Center)
          .linearGradient({ angle: 160, colors: [[TINT_TOP, 0.0], [TINT_BOTTOM, 1.0]] })
          .shadow({ radius: 18, color: '#400A6CFF', offsetY: 6 })
          Text('已存入 Mac').fontSize(22).fontWeight(FontWeight.Bold).fontColor(this.c().text)
          Text(this.records().some((record: ShareRecord) => this.isFile(record))
            ? '文件在 Mac 收件目录中，文字在 NearBridge 互传页中。'
            : '在 Mac 的 NearBridge 互传页里查看文字和链接。').fontSize(13).fontColor(this.c().text2)
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
          }
        }
        .width('100%')
        .height(54)
        .backgroundColor(this.c().tint)
        .opacity(this.canSend() ? 1 : 0.5)
        .enabled(this.canSend())
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
