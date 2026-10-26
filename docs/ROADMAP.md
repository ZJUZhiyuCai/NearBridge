# 对标与后续

## 0.5 当前优先级

1. 即时变更通知和生命周期取消已实现；回归新版手机的真实响应时间、蓝牙自检、系统分享与断线恢复。验证要求见 [测试矩阵](TESTING.md)。
2. 条目增量同步与有界快照回退已实现。真机测量大文本历史下的 BLE 开销；继续评估首次完整同步、UI 序列化和批量接收延迟。
3. 验证大文件、多分块、低存储和长时间蓝牙稳定性，再考虑后台传输与更多系统入口。

最新的 [性能测量](PERFORMANCE.md) 与 [对抗性审查](ADVERSARIAL-REVIEW.md) 单独记录。下方为早期对标和已有真机基线，不能替代新版设备验收。

## 体验基准

| 官方入口 | 对标的操作体验 | NearBridge 0.2 |
| --- | --- | --- |
| [Apple AirDrop](https://support.apple.com/zh-cn/guide/mac-help/mh35868/mac) | 从分享菜单或 Finder 拖入文件；同账号设备自动接受 | Mac 原生窗口、拖拽、Finder 右键入口已实现；手机前台自动收件已真机验证 |
| [华为分享连接 Mac](https://consumer.huawei.com/cn/support/content/zh-cn16093657/) | 手机分享页选设备；Mac App 接收/发出文件 | 鸿蒙 ShareExtensionAbility + Mac 常驻服务；不冒充华为私有互传协议 |
| [荣耀互联](https://www.honor.com/cn/tech/connect/) | 提供 Mac 原生互联客户端，把传输和跨设备操作集中到应用 | Mac 传输/工作流/设备三页；统一配对和历史 |
| [华为接收端场景](https://developer.huawei.com/consumer/cn/doc/connectivity-Guides/dev-scenario-design-receiving-0000001051898439) | 进度、完成状态、同名处理、中断恢复 | 分块续传、校验回执、同名编号、持久化队列 |

上述是交互和可靠性目标。局域网模式要求同一网络；首次配对后已可选择 BLE 小文件/工作流直传。没有实现 AirDrop 的 AWDL、华为碰一碰、Wi-Fi Direct 或系统级后台特权。

## 当前阶段

- 0.3 体验重塑已实现：Claude 产品与前端设计，Codex 集成；Mac 新界面运行通过，手机签名包待傍晚真机验收。详见 [0.3 更新](REDESIGN-0.3.md)。

- Mac 原生收发、Finder Services、菜单栏、全局快捷键：已构建并实际运行。
- 服务端续传、收件回执、原生配对迁移、双 TLS 入口：已实现及自动化验证。
- 鸿蒙原生端：2026-10-26 完成调试签名及 Mate 70 Pro+ 安装。扫码配对、手机一键工作流、Mac 发出的 4 个文件自动接收、图库系统分享一张 7.2 MB 照片均已真机验证；修复哈希大小写导致的收件校验失败。
- 文件管理/浏览器分享、传输中断恢复、切换 Wi-Fi 后发现、大文件边界：待验证；当前未实现锁屏后台常驻。

- 蓝牙：BLE 版已通过 16 KB Mac → 手机、32 KB 手机 → Mac → 手机双向文件校验，以及手机触发 Mac 工作流验收；记住设备、更新后重连、前台传输亮屏和连接自检已实现。前期系统服务死锁恢复后，本轮验证未再复现，保留异常后暂停重试保护。见 [蓝牙记录](BLUETOOTH.md)。

下一步验证 BLE 多分块大文件与长期稳定性，并完善中断恢复、前后台切换与网络切换的真机验证。后续体验升级包括合规的后台传输、手机桌面工作流卡片、相册导出和通知提醒；这些尚未实现。

## 关键官方接口

- [系统分享扩展接入](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/share-sec-panel)
- [Share Kit 数据接口](https://developer.huawei.com/consumer/cn/doc/doccenter-references/api/share-system-share)
- [系统扫码 UI](https://developer.huawei.com/consumer/en/doc/harmonyos-guides-V14/scan-scanbarcode-V14)
- [OpenHarmony HTTP 类型定义](https://github.com/openharmony/interface_sdk-js/blob/master/api/@ohos.net.http.d.ts)
- [OpenHarmony mDNS 类型定义](https://github.com/openharmony/interface_sdk-js/blob/master/api/@ohos.net.mdns.d.ts)
- [DevEco 自动签名](https://developer.huawei.com/consumer/cn/doc/doccenter-deveco-studio/ide-signing-auto)
- [Apple 快捷指令命令行](https://support.apple.com/zh-cn/guide/shortcuts-mac/apd455c82f02/mac)
