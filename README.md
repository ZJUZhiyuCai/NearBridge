# NearBridge

**Mac 与 HarmonyOS 的原生互联工具。文件、文字、快捷指令，直接在两台设备之间流动。**

SwiftUI / AppKit · ArkTS / ArkUI · 局域网 HTTPS · 实验性 BLE · MIT

[使用](#日常使用) · [构建](#从源码开始) · [架构](docs/ARCHITECTURE.md) · [贡献](CONTRIBUTING.md) · [安全](SECURITY.md) · [更新记录](CHANGELOG.md)

NearBridge 为 Mac 和华为手机提供系统分享、双向文件收发及手机触发 Mac 工作流。不需要微信或云端中转。项目目前处于实验阶段，以 Mate 70 Pro+ / HarmonyOS 6 和 Apple Silicon Mac 为主要验证环境。

## 当前能力

| 能力 | 状态 |
| --- | --- |
| Mac 菜单栏、原生窗口、Finder 服务、文件夹打包 | 已实现；原生交互已有本机验证 |
| 鸿蒙系统扫码、照片/文件选择、图库分享、手机快捷指令 | 0.2 已有真机证据；新版本需回归 |
| 双向文件、断点续传、SHA-256 收件回执 | 已实现；小文件真机通过，完整故障矩阵待测 |
| BLE 文字、小文件及 Mac 工作流 | 测试版；0.2 已有真实双向校验和工作流证据 |
| 苹果风格界面、即时状态通知、0.5 增量同步 | 两端原生实现；手机新版体验和无线性能待真机验收 |
| 锁屏后台常驻、投屏、通知镜像、Wi-Fi Direct/AWDL | 未实现 |

**0.5 继续降低同步开销并修复对抗性用例。** 原生两端只接收变化的历史条目；工作流状态变化不再重发整段文字历史。旧客户端仍可使用完整快照。上传分块异步写盘并保留 fsync，重复回执不再重复写入，撤销授权会中止在途下载。可复现的合成基准和测量边界见 [性能记录](docs/PERFORMANCE.md)；本机回环结果不代表手机或蓝牙延迟。

## 日常使用

首次在 Mac 显示配对二维码，用手机 NearBridge 扫描，再在 Mac 批准。证书与公钥随配对绑定，日常使用无需打开网页。

- **手机 → Mac**：图库或文件 App → 分享 → **发送到 Mac**；也可在 NearBridge 首页选照片、文件或发文字。
- **Mac → 手机**：拖文件到 NearBridge，或 Finder 右键 → 服务 → **发送到 NearBridge**。手机保持 NearBridge 前台即可自动收件，之后可“另存为”。
- **手机控制 Mac**：首页“快捷指令”中点 **打开收件目录**，或运行你在 Mac 明确启用的快捷指令。
- **唤出 Mac 窗口**：菜单栏 **NB**，或 **Control + Option + 空格**。
- **蓝牙**：首次扫码配对后，在 Mac 设置开启蓝牙；手机右上角 **··· → 连接与设置 → 蓝牙** 选择 Mac。不会在失败时暗中改用 Wi-Fi。

Mac 离线或手机未打开时，文件可先进入 Mac 待发队列。“手机已收取”表示手机已保存并验证文件，不等于“加入队列”。手机当前需要前台运行，Mac 需要保持唤醒。蓝牙适合小文件和操作指令；照片合集和视频优先用局域网。

## 从源码开始

### Mac

需要 macOS 13+、Apple Command Line Tools、Node.js 22.13+。构建目标为当前机器架构，Apple Silicon 已实际使用；其他架构及旧系统仍需各自验收。App 当前依赖 `/opt/homebrew/bin/node` 或 `/usr/local/bin/node`，不内置 Node 运行时。

```sh
git clone https://github.com/ZJUZhiyuCai/NearBridge.git
cd NearBridge
npm ci --ignore-scripts
npm run check
npm test
npm run build:mac
npm run install:mac
```

安装到 `~/Applications/NearBridge.app`。旧 App 会保留为同目录隐藏备份，用户数据不会清除。Mac 产物使用本机 ad-hoc 签名，尚未提供公证后的通用安装包。

### HarmonyOS

需要官方 DevEco Studio、支持的手机，以及自己的华为开发者账号和调试签名。详细步骤见 [鸿蒙工程说明](harmony/README.md)。

```sh
npm run build:phone
```

默认查找 `/Applications/DevEco-Studio.app` 或 `~/Applications/DevEco-Studio.app`；其他位置用 `NEARBRIDGE_DEVECO_APP` 指定。构建脚本会从通用模板生成本机配置，不覆盖已有签名。安装包在 `harmony/entry/build/default/outputs/default/`，只有完成签名的 HAP 才能用于真机。

仓库不包含签名材料、设备授权、配对凭据、运行时日志、收发文件、私人截图或安装包。克隆后需要自行配置；开发机的历史验证记录不是你的设备已经通过验证。

### 开发与检查

```sh
npm start                 # 开发服务；不要与已运行的 Mac App 服务重复启动
npm run check             # 语法、版本、仓库文件和文档链接
npm test                  # HTTP/TLS、客户端业务、Swift BLE 与状态合并回归
npm run benchmark         # 隔离的本机变更通知基准
npm run benchmark -- --poll # 对照旧的 2/3 秒轮询策略
npm run benchmark:active  # 大历史下完整快照与增量响应对照
```

CI 在 Linux 上覆盖 Node 22/24/26，在 macOS 上运行测试、编译原生 App 并核对签名。鸿蒙编译与签名使用本机官方 SDK，真机检查独立记录。见 [测试矩阵](docs/TESTING.md) 和 [对抗性审查](docs/ADVERSARIAL-REVIEW.md)。

## 数据与边界

| 项目 | 位置 / 限制 |
| --- | --- |
| Mac 收件文件 | `~/Downloads/NearBridge/` |
| 配对、证书、历史、发件副本、队列 | `~/Library/Application Support/NearBridge/` |
| Mac 管理服务 | `127.0.0.1:53318`，仅回环地址 |
| 原生手机服务 | HTTPS `53320`；私有 CA、公钥固定和会话认证 |
| 网页备用服务 | HTTPS `53319` |
| 文件与存储 | 单文件 512 MiB；总文件暂存/保留配额 2 GiB |
| 记录 | 最多 1000 条；状态窗口最多 200 条、历史 JSON 最多 8 MiB，单条文字不截断 |
| 传输分块 | 局域网至多 4 MiB，BLE 使用 64 KiB |

配对二维码五分钟、单次有效；手机会话三十天，可在 Mac 撤销。工作流只接受 Mac 已启用的 ID，不接受手机发来的命令或脚本。服务依赖本机账户及文件权限，不提供应用层磁盘加密。完整约束见 [协议说明](docs/PROTOCOL.md) 和 [安全边界](SECURITY.md)。

可用环境变量：`NEARBRIDGE_DATA_DIR`、`NEARBRIDGE_INBOX`、`NEARBRIDGE_PORT`、`NEARBRIDGE_PHONE_PORT`、`NEARBRIDGE_NATIVE_PORT`。测试均使用临时目录与假的系统操作适配器。

## 参与项目

请先读 [贡献指南](CONTRIBUTING.md)。问题反馈请提供版本、系统、连接方式和最小复现；漏洞按 [安全策略](SECURITY.md) 私下报告。当前优先事项是新版真机回归、蓝牙长时间稳定性、网络切换和传输故障恢复，见 [路线图](docs/ROADMAP.md)。

源码采用 [MIT 许可证](LICENSE)。第三方依赖仍遵循各自许可证；华为 SDK 和个人签名材料不属于本仓库的发行内容。
