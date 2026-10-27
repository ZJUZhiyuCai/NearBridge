# Windows 客户端

Windows 10 2004 / Windows 11，.NET 10 WinForms 宿主 + Microsoft Edge WebView2。沿用 NearBridge 的蓝白灰界面和 Node / HarmonyOS 协议，提供托盘、Ctrl+Alt+空格、文件与文件夹选择、拖放、资源管理器“发送到”、Windows 剪贴板、可靠操作、持久化待发队列和 BLE GATT 中继。

## 在 Windows 构建与使用

需要 Node.js 22.13+、Git for Windows（提供 OpenSSL）、.NET 10 SDK，以及 Microsoft Edge WebView2 Runtime。后者通常随 Windows / Edge 安装。构建产物内含 Node 与 .NET 运行时，但仍需本机 WebView2 和 OpenSSL。

```powershell
npm ci --ignore-scripts
npm run build:windows
npm run check
npm test
npm run start:windows
# 可选：安装到当前用户，无需管理员；添加开始菜单和“发送到”入口
npm run install:windows
```

直接运行 `dist/windows/NearBridge.exe`。关闭窗口后仍驻留托盘；从托盘菜单退出会停止本客户端启动的服务。终端单独启动的服务不会被客户端结束。全局快捷键被占用时仍可使用托盘。

安装位置 `%LOCALAPPDATA%\Programs\NearBridge`。程序尚未做商业代码签名；当前不是签名 MSIX 安装包。已有安装需先退出，再执行安装。用户数据与程序文件分开保存。

## 配对与文件

1. 电脑与鸿蒙手机连接同一局域网，运行两端 NearBridge。
2. Windows 点“设备连接”；多个网卡时选择手机可达的 Wi-Fi / 以太网地址。
3. 在手机 NearBridge 扫码，再在 Windows 点击“允许配对”。原生二维码包含私有 CA 和公钥 pin；不用在浏览器跳过证书警告。
4. Windows 选择、拖入文件或发送整个文件夹。文件夹打包为 ZIP；不会跟随符号链接/联接目录，单次最多 10000 项、原始内容 512 MiB。
5. 资源管理器右键 → 显示更多选项（Windows 11）→ 发送到 → NearBridge。它把本次选中的路径交给当前用户已运行的客户端。

窗口顶部“重试队列 / 确认”恢复上次中断。待发副本保存在私有目录，服务返回偏移后从该位置续传；完成后比对 SHA-256。加入服务队列后释放本地待发副本，只有手机落盘并校验、回执成功后才显示“手机已收取”。文字和工作流先持久化请求 ID，回执丢失和重启后复用同一 ID。结束重试不会撤销已经发生的操作。

## Windows 工作流

两个内置工作流“打开收件目录”“保存文字便签”保持原行为。自定义工作流改用 Windows `.lnk` 快捷方式：

- 点窗口顶部“快捷方式目录”，把自己选定的 `.lnk` 放入 `%LOCALAPPDATA%\NearBridge\Workflows`。
- 在工作流页“载入本机快捷指令”，明确选择并加入手机面板，可随时关闭“手机可用”。
- 手机只提交已启用的固定 ID，不能传入命令、路径或脚本参数。移走快捷方式后原 ID 无法运行。
- Windows 的回执表示已请求启动快捷方式，不能证明所启动程序的业务操作已经完成。原 macOS Shortcuts 的具体流程需要自行在 Windows 配置对应快捷方式。

## 蓝牙与网络

在窗口顶部“开启蓝牙”。手机首次使用时，在连接设置先选“自动”→“选择蓝牙电脑作为备用”→点选附近的电脑，再按需选“仅蓝牙”或运行“检查蓝牙连接”。保留原服务 UUID、4 路 TLS 字节流、MTU 分帧、有回应写入和 indication 背压。中继只能连接 `127.0.0.1:53320` 手机 TLS 服务，不能连接管理端口；纯蓝牙不回退局域网，手机的自动/仅蓝牙/仅局域网选择逻辑保持原样。

Windows 蓝牙适配器及驱动必须支持 BLE peripheral role；仅有蓝牙 5.x 字样不能证明支持。客户端会检测并显示错误。2026-10-27 已完成本机与 Mate 70 Pro+ 的配对、局域网接收回执及 BLE 32 KB 双向自检；记录了 Windows 落盘文件与 SHA-256，手机自检通过由机主确认。蓝牙自检较慢，日常使用“自动”优先选择局域网；大文件与长期稳定性尚未验收，详见 [Windows 验证记录](../docs/WINDOWS-VERIFICATION.md)。

局域网服务使用 TCP 53319（备用网页）、53320（原生手机），Windows 服务通过 UDP 5353 发布 mDNS 以支持 IP 变化后的重新发现。管理端口 53318 只监听回环地址。如果 Windows 防火墙提示，请由机主对可信的专用网络允许本应用目录中的 `node.exe`；不要关闭整个防火墙，也不需要开放管理端口。

## 路径与工具覆盖

| 内容 | 默认位置 |
| --- | --- |
| 收件文件 | `%USERPROFILE%\Downloads\NearBridge` |
| 配对、证书、历史、服务发件副本 | `%LOCALAPPDATA%\NearBridge` |
| Windows 待发副本与待确认操作 | `%LOCALAPPDATA%\NearBridge\windows` |
| 客户端日志 | `%LOCALAPPDATA%\NearBridge\windows-app.log` |

原有 `NEARBRIDGE_DATA_DIR`、`NEARBRIDGE_INBOX` 及三种端口变量仍有效。可以用 `NEARBRIDGE_OPENSSL` 指向 `openssl.exe`，`NEARBRIDGE_DOTNET` 指向构建用的 `dotnet.exe`。`NEARBRIDGE_DISCOVERY=0` 可在隔离测试中关闭 mDNS。这些变量需在启动客户端前设置。

实现依据：[Microsoft WebView2 WinForms](https://learn.microsoft.com/en-us/microsoft-edge/webview2/get-started/winforms)、[Windows GATT Server](https://learn.microsoft.com/en-us/windows/apps/develop/devices-sensors/gatt-server)。
