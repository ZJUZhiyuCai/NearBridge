# NearBridge · HarmonyOS 原生端

目标设备：Mate 70 Pro+，最低兼容 HarmonyOS 6 / API 20。此目录为 Stage 模型 ArkTS 工程，含主 UIAbility 和系统 ShareExtensionAbility。当前源码为 **0.4.0 / 400**；新版真机回归仍待进行。2026-10-26 安装并通过扫码、工作流、自动收件、图库分享和 BLE 小文件验证的是 **0.2 基线**，不能视作 0.4 已验收。

## 打开与构建

1. 本机已安装 `~/Applications/DevEco-Studio.app`，版本 **26.0.0.851 / ARM**，使用自带 **26.0.0.105** SDK。2026-10-26 已通过 Finder 移动到此位置，解决临时路径运行时无法连接 IDE 窗口的问题。省略 `compileSdkVersion` 以使用 IDE 自带编译 SDK；`compatibleSdkVersion` 和 `targetSdkVersion` 仍为 **6.0.0(20)**，无需额外下载旧 SDK。
2. DevEco Studio → Open，选择本目录 `harmony`，等待工程同步。
3. 可在仓库根目录运行 `npm run build:phone`，或使用 Build → Build Hap(s)/APP(s) → Build Hap(s)。脚本自动定位 DevEco 自带 Node、Java、SDK 和 Hvigor，不修改全局环境。安装在其他位置时设置 `NEARBRIDGE_DEVECO_APP`。
4. 真机运行需要使用已实名认证的华为开发者账号签名。可用下面的官方 CLI 流程，也可在项目 Signing Configs 中自动签名。手机开启开发者选项/调试后，自己确认该 Mac 的调试授权。
5. 安装运行后，Mac NearBridge 左上角手机卡片 → 重新配对手机（首次使用为“显示配对码”）；手机点“扫码连接 Mac”，再在 Mac 确认。更新已有安装时保留原配对，不必重新扫码。

USB 未被系统识别时，可以按[华为 HDC 文档](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides-V13/hdc-V13)使用无线调试：手机与 Mac 连接同一 Wi-Fi，在手机开发者选项中打开“无线调试”，按手机显示的实际 IP 和端口执行 `hdc tconn IP:PORT`，并由机主确认调试授权。调试连接仅用于开发安装，NearBridge 日常互传不依赖它。

可安装产物：`entry/build/default/outputs/default/entry-default-signed.hap`。构建也会生成 `entry-default-unsigned.hap`，后者不能直接用于真机安装。其他机器需完成自己的华为账号登录及项目签名。签名材料与 `local.properties` 不应提交，自动签名生成的私有路径和密码也不要放入版本库。构建配置兼容 HarmonyOS 6；不要仅因 IDE 较新就把 compatibleSdkVersion 升到手机不支持的版本。

### 官方命令行登录与签名

在仓库根目录执行：

```sh
npm install --prefix .runtime/deveco-cli --ignore-scripts --no-audit --no-fund --save-exact @deveco/deveco-cli@1.3.0-stable
npm run phone:tools -- device list
npm run phone:login
npm run phone:sign
npm run build:phone
```

工具来源为[华为官方 DevEco 页面](https://developer.huawei.com/consumer/cn/deveco-studio/)公布的 `@deveco/deveco-cli`。安装仅作用于本项目 `.runtime`，不改变全局 npm 工具；忽略的安装钩子用于后台初始化离线文档，不影响登录、签名及构建。包装脚本使用 DevEco 自带 Node 和工具链，并为这些进程关闭可选 CLI 遥测。

`build-profile.template.json5` 保存可提交的通用配置。构建/CLI 包装脚本会在缺少配置时生成本机 `build-profile.json5`，已有文件不会被覆盖。后者会被官方签名工具写入私有材料路径和加密密码，已加入 `.gitignore`。调整通用构建参数时同步修改模板；不要把本机签名字段复制到模板。

### 开发机 0.2 安装历史

2026-10-26：无线调试识别到 Mate 70 Pro+，真机报告 API 26，当前 HAP 仍保持 API 20 兼容性。机主完成实名认证后，重新登录以刷新 CLI 缓存的认证状态。首次签名又遇到 CLI 1.3.0 的设备预检查问题：账号尚无云端设备时，预检查只接受模拟器，导致其后续已有的真机注册流程无法执行。

本机仅在忽略目录 `.runtime` 创建一次性 CLI 副本：允许预检查放行已通过 HDC 核对的指定真机，并把后续设备收集限制为同一调试地址。保留官方登录、实名认证、云端授权和证书校验流程；原版工具文件未修改。该副本成功完成设备注册及签名后，已用**未修改的** `npm run phone:sign` 再次确认成功。日常继续使用原版命令，无需兼容副本。

签名构建成功，HDC 安装返回 `install bundle successfully`。包名 `local.nearbridge.phone`，版本 `0.2.0 / 200`。首次命令启动被手机锁屏拦截；机主解锁后完成扫码配对，手机触发“打开收件目录”成功。随后修复 CoreFileKit 哈希值大小写差异，覆盖安装保留配对和历史；应用启动成功，4 个 Mac 文件均收到落盘校验回执。机主从图库通过“发送到 Mac”发出一张 7.2 MB JPEG，Mac 实际文件大小和 SHA-256 与传输记录一致。调试连接只用于开发安装，日常互联无需一直开启无线调试。

## 实现内容

- `entry/src/main/ets/core/BridgeClient.ets`：私有 CA + SPKI pin、配对迁移、Bearer 会话、mDNS 发现、分块收发、SHA-256、收件回执。
- `pages/Index.ets`：单首页互传和快捷指令，连接设置弹层，系统文件和照片选择器、粘贴安全控件、工作流结果、文件导出。
- `shareability/ShareAbility.ets` 与 `pages/SharePage.ets`：系统分享面板内选定内容发送。按实际完成的记录位置重试，文件 UUID 去重。
- `module.json5` 的分享类型声明含必填 `scheme`、`utd` 和 `maxFileSupported`。分别声明图片、视频、音频、压缩包、复合文档、文字及通用文件；`general.file` 与媒体类型属于不同继承分支，不能只声明它就假定照片也能分享。
- 分享页面使用 `@Entry({ useSharedStorage: true })`，接收 ShareExtensionAbility 传入的 LocalStorage；文字和链接内容均可发送。

自动接收目前仅在前台工作。收到的文件进入应用私有收件箱，点“另存为”导出；不会直接写入图库或扫描整台手机。退出分享页会暂停上传；重新选择同一文件可尝试恢复；其他应用提供的临时 URI 权限可能已经失效，需要重新分享。

## BLE 实验通道

`core/BluetoothTunnel.ets` 使用公开 BLE GATT API，转发现有 TLS 字节流，保留证书和配对验证。连接与设置中的“蓝牙”只发现广播 NearBridge 服务的 Mac；异常后停止自动重试。旧 RFCOMM 配置下次启动恢复局域网。**已通过纯 BLE 小文件双向传输及手机工作流真机验收**，大文件和长期稳定性仍待验证。连接与设置中的“检查蓝牙连接”使用正常文件上传及下载链路校验 32 KB 测试文件；前台传输期间保持窗口亮屏，结束或退后台后释放。前期系统蓝牙死锁及恢复过程、完整验收证据见 [蓝牙记录](../docs/BLUETOOTH.md)。

## 真机验收

- 已验证扫码配对、保留原设备 ID 与历史，以及覆盖安装后的配对持久化。错误证书/公钥和旧网页凭证失效已有服务端测试；手机侧负向操作未另测。
- 已验证从图库系统分享一张 7.2 MB 照片到 Mac，跨 4 MB 分块并校验落盘；文件管理、浏览器的系统分享入口仍待分别验证。
- 已验证 Mac 发出的 TXT、两个 ZIP 和 SVG 自动接收，完成后 Mac 原生窗口显示“手机已收取”。
- 已验证手机“遥控 Mac → 打开收件目录”，服务端记录 `source: phone / status: succeeded`，机主确认 Finder 弹出。

其余待验证：

- 上传/下载中切换前后台、断开 Wi-Fi、杀进程：恢复不重复、不损坏。
- 更换局域网 IP：mDNS 找回设备，CA + pin 保持一致。
- 只运行 Mac 启用的工作流；禁用后手机不能触发。
- 大文件磁盘不足、撤销配对、文件 URI 权限失效均应给出明确失败。

## 0.3 更新包（待真机验收）

2026-10-26：Claude 设计的单首页、蓝白灰主题、深浅色、快捷指令磁贴、系统分享预览已集成。`npm run build:phone` 完成签名，版本 `0.3.0 / 300`，更新包位于 `../dist/NearBridge-0.3.0.hap`。机主已带走手机，本轮没有真机安装或设备侧体验验收。新版本需覆盖安装，保留配对和已有文件。详见 [更新记录](../docs/REDESIGN-0.3.md)。

## 0.4 响应与可靠性更新

前台通过带 revision 的变更请求同步，空闲时仅接收心跳；传文件不阻塞通知。切换网络或退后台立即取消旧 HTTP 任务。重复接收同一条目合并为一次；文件已保存但回执丢失时重试回执。源码业务测试不能代替系统 API 和真机行为验证，见 [0.4 测试矩阵](../docs/TESTING.md)。
