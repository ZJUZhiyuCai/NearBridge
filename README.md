# NearBridge

**Windows、Mac 与 HarmonyOS 的本地互联工具。文件、文字、快捷指令，直接在你的设备之间流动。**

Windows 托盘 / WebView2 · Mac 菜单栏 / SwiftUI · HarmonyOS ArkUI · 局域网 HTTPS · 实验性 BLE · MIT

[Windows 使用与构建](windows/README.md) · [鸿蒙工程](harmony/README.md) · [架构](docs/ARCHITECTURE.md) · [贡献](CONTRIBUTING.md) · [安全](SECURITY.md) · [更新记录](CHANGELOG.md)

0.8 保留 Windows 和 Mac 两种电脑端，统一互传与快捷指令体验。手机“我的电脑”可同时保存多台电脑，选择当前收发目标；添加第二台不再替换第一台。每台电脑分别保存配对凭据、蓝牙选择、待发队列和已收文件，切换不会把原来的待确认操作发到另一台。私有 CA、公钥固定、显式批准、断点续传、SHA-256 回执和自动选路继续沿用。

## 当前能力

| 能力 | 状态 |
| --- | --- |
| 托盘、窗口宿主、Ctrl+Alt+空格、拖放、“发送到”、文件夹 ZIP | 已实现；需先构建 Windows 客户端 |
| 鸿蒙扫码、照片/文件选择、图库分享、手机快捷指令 | 保留；提示改为电脑，分享入口为“发送到电脑” |
| 手机保存 Windows 和 Mac、切换当前电脑 | 最多 8 台；首页和系统分享页明确显示目标，各台凭据与记录分开 |
| 双向文件、断点续传、SHA-256 收件回执 | 保留；Windows 编译客户端有丢响应/重启续传回归 |
| 文字、工作流可靠重试 | 两端持久化操作编号，七天内复用回执 |
| 增量同步、即时通知、自动/仅蓝牙/仅局域网 | 保留；Windows 使用同一 delta-v1 协议 |
| BLE 文字、小文件与工作流 | Windows GATT / Mac CoreBluetooth 使用相同协议；0.7 Windows 小文件自检已有记录，大文件与长期稳定性待验收 |
| 锁屏手机后台常驻、投屏、通知镜像、Wi-Fi Direct/AWDL | 仍未实现 |

0.7 的 Windows 真机基线见 [Windows 验证记录](docs/WINDOWS-VERIFICATION.md)。早期 Mac 真机记录保留在[历史验证记录](docs/VERIFICATION.md)和[蓝牙记录](docs/BLUETOOTH.md)；旧版本记录不代表新版所有交互都已真机验收。

## 在 Windows 开始

需要 Windows 10 2004+ / Windows 11、Node.js 22.13+、Git for Windows、.NET 10 SDK 和 Edge WebView2 Runtime。Git for Windows 中的 OpenSSL 用来生成本地证书。产物包含 Node 与 .NET 运行时。

```powershell
git clone https://github.com/ZJUZhiyuCai/NearBridge.git
cd NearBridge
npm ci --ignore-scripts
npm run build:windows
npm run check
npm test
npm run start:windows
```

产物为 `dist/windows/NearBridge.exe`。可选运行 `npm run install:windows`，安装到 `%LOCALAPPDATA%\Programs\NearBridge`，添加开始菜单和资源管理器“发送到”入口。更新前先退出托盘程序。Windows 产物目前没有商业代码签名。详细要求与路径覆盖见 [Windows 说明](windows/README.md)。

## 在 Mac 开始

需要 macOS 13+、Node.js 22.13+、Xcode Command Line Tools（Swift），以及 OpenSSL。

```sh
npm ci --ignore-scripts
npm run build:mac
npm run install:mac
```

Mac 保留 SwiftUI 窗口、菜单栏、Finder 分享/拖放和本机 Shortcuts。它与 Windows 使用同一套服务和手机端；可分别配对到手机“我的电脑”，无需移除另一台。Mac 安装器会保留已有应用目录身份和用户数据。

### HarmonyOS

在 Windows 安装官方 DevEco Studio，配置自己的华为开发者账号、设备调试授权与签名。手机工程仍兼容 HarmonyOS 6，应用包名保留，覆盖安装可保留原数据。

```powershell
# 默认搜索 Program Files\Huawei\DevEco Studio 等位置；自定义安装位置可设置：
$env:NEARBRIDGE_DEVECO_APP = 'D:\Huawei\DevEco Studio'
npm run build:phone
```

构建脚本识别 Windows 的 `node.exe`、`jbr`、`sdk` 和 Hvigor 路径，也继续兼容 macOS 的 DevEco 安装。只有签名完成的 `harmony/entry/build/default/outputs/default/entry-default-signed.hap` 能用于真机，详见[鸿蒙工程说明](harmony/README.md)。仓库不包含个人签名材料。

## 日常使用

1. 两端连接同一局域网，在目标 Windows 或 Mac 打开原生配对码，手机“我的电脑 → 添加电脑”扫码，再在目标电脑批准。多个网卡时先选择手机可达的地址。
2. **选目标**：手机首页或“我的电脑”切换当前电脑；系统分享页也能在开始发送前选择目标。升级会保留当前配对；旧版曾被替换的另一台电脑需要再扫码一次，之后即可来回切换。
3. **手机 → 电脑**：图库或文件管理 → 分享 → **发送到电脑**；也可在 NearBridge 首页选择文件、照片或发送文字。确认页面显示的是期望目标。
4. **电脑 → 手机**：Windows 拖入文件、使用互传页文件/文件夹按钮，或资源管理器“发送到”；Mac 使用窗口拖放或 Finder 分享。手机保持 NearBridge 前台并选择这台电脑，完成后可“另存为”。
5. **手机快捷指令**：内置“打开收件目录”“保存文字便签”一致。Windows 自定义项来自本机明确加入的 `.lnk`，Mac 来自本机 Shortcuts；只显示当前电脑已启用的项目。
6. **连接方式**：每台电脑分别选择自动、仅蓝牙或仅局域网。自动优先局域网，失败时尝试该电脑已选的蓝牙设备；传输期间保持线路。电脑端先开启“允许手机用蓝牙连接”，手机再选择对应设备。
7. **结果未确认**：切回对应电脑点“重试确认”继续原操作。先检查结果，再决定是否“结束重试”；结束重试不会撤销已执行动作。

关闭 Windows 窗口后继续驻留托盘；Ctrl+Alt+空格或托盘图标可唤出。退出使用托盘菜单。电脑需要保持唤醒，鸿蒙当前需要前台运行。

文件可先进入电脑待发队列。“手机已收取”表示手机已保存并验证，不能与“加入队列”混淆。蓝牙适合文字、工作流和小文件；照片合集和视频优先局域网。防火墙如有提示，由机主允许可信专用网络上的应用 `node.exe`，无需开放回环管理端口。

## 开发与检查

```powershell
npm start                  # 仅开发服务；不要和客户端服务重复启动
npm run check              # 语法、版本、仓库文件与文档链接
npm test                   # 服务、鸿蒙业务、Windows 状态/系统适配/编译客户端
npm run build:windows      # 构建后 npm test 会包含原生 Windows 回归
npm run benchmark          # 隔离的本机变更通知基准
npm run benchmark:active   # 完整快照与增量响应对照
```

CI 包含 Windows + .NET 编译与原生客户端测试、Linux Node 22/24/26，以及 macOS Swift 构建与签名检查。Windows 和 Mac 都继续维护，鸿蒙签名与真机验收独立进行，见[测试矩阵](docs/TESTING.md)。本次 Claude 协作、数据迁移和实测范围见 [0.8 统一体验验证记录](docs/UNIFIED-0.8.md)。

## 数据与边界

| 项目 | Windows 默认位置 / 限制 |
| --- | --- |
| 收件文件 | `%USERPROFILE%\Downloads\NearBridge` |
| 配对、证书、历史、发件副本 | `%LOCALAPPDATA%\NearBridge` |
| Windows 队列与待确认操作 | `%LOCALAPPDATA%\NearBridge\windows` |
| 管理服务 | `127.0.0.1:53318`，仅回环地址 |
| 原生手机服务 | HTTPS `53320`，私有 CA、公钥固定与会话认证 |
| 网页备用服务 / mDNS | HTTPS `53319` / UDP `5353` |
| 单文件 / 服务暂存配额 | 512 MiB / 2 GiB |
| 记录 / 状态窗口 | 最多 1000 条 / 200 条且至多 8 MiB JSON |
| 文件分块 | 局域网至多 4 MiB，BLE 64 KiB |

二维码五分钟、单次有效；手机会话三十天，可在电脑撤销。工作流只接受已启用的 ID，不接受手机命令。兼容性的内部 `mac` 角色、来源字段和 `/api/mac/*` 仍表示电脑管理端，名称不影响 Windows 运行。服务依赖本机账户与目录访问权限，不提供应用层磁盘加密。详见[协议](docs/PROTOCOL.md)和[安全边界](SECURITY.md)。

源码采用 [MIT](LICENSE)。第三方依赖、Microsoft WebView2 与华为 SDK 按各自许可使用。签名材料、配对凭据、私人日志及收发文件不得提交。
