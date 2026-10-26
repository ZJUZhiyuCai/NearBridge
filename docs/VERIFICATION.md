# 0.3 验证记录

2026-10-26，机主带走手机后的本机集成。原 0.2 真机记录保留在下方。

- `npm test`：29 项通过、0 失败、0 跳过；含 7 项手机客户端状态/重配对/提交成功后的刷新失败/暂停回归。客户端使用真实 ArkTS 业务源码，经 Node 类型擦除加载，平台 API 为内存适配器；它们不代替真机测试。
- `npm run check`、`npm run build:mac`、`codesign --verify --deep --strict`、`npm run install:mac`：通过。
- Mac 原生窗口实际检查了侧边栏、互传搜索及文件卡片、快捷指令、设备设置；在新界面点击“打开收件目录”后服务端返回 `source: mac / status: succeeded`。
- 同一设备配对仍在，10 条历史保留，自动复制手机文字设置仍为开启。手机不在，页面如实显示离线。
- `npm run build:phone`：严格 ArkTS 编译、资源打包、SignHap 成功，`0.3.0 / 300`。构建存在原 SDK 潜在异常、PasteButton 权限分析和 BLE API 兼容性提示；未关闭检查。新 UI 的 EnvironmentCallback 类型问题已按官方回调对象用法修正。
- **未验收**：0.3 手机端布局、系统分享、深浅色切换、双端文件/蓝牙/工作流回归。手机待机主傍晚带回后覆盖安装。
- Mac 更新后 TCC 再次等待蓝牙授权。最终界面显示“等待 macOS 允许使用蓝牙，请查看系统提示”；本轮不声称 0.3 蓝牙业务已通，待机主确认系统提示后验收。
- 交付及来源见 [0.3 更新](REDESIGN-0.3.md)。

---

# 0.2 验证记录

2026-10-25 至 2026-10-26，Apple Silicon Mac / macOS 26.5.2。

## 已验证

- `npm test`：20 组通过。覆盖原有配对/隔离/文件/工作流，以及分块断点续传、崩溃尾部回滚、完成幂等、保留配额、取消释放、撤销配对清理续传、原生配对迁移、Bearer 权限、HTTP Range、校验回执、证书跨 IP 更新。
- 原生 TLS 使用真实 HTTPS 握手，正确私有 CA 可连接，错误 CA 被拒绝；叶证书更新后原 CA 仍可连接。
- `npm run check`：通过。
- `npm run build:mac`：SwiftUI/AppKit/Carbon 原生应用编译成功。
- `npm run install:mac`：签名严格检查通过，安装至 `~/Applications/NearBridge.app` 并注册 Finder Services。
- 最终安装版已重启；原生手机端口 53320 使用私有 CA 的真实 HTTPS 健康检查通过。
- `npm audit --omit=dev --audit-level=high`：0 vulnerabilities。
- 实际原生 UI：已有 Mate 70 Pro+ 配对和历史保留；通过原生文件选择器发送 `原生互传验证.txt`，进入 Mac 发件副本并显示“等待手机收取”。
- 实际原生 UI：选择 `folder-sample` 目录，生成 ZIP 并发送。
- 实际 Finder UI：右键菜单出现“发送到 NearBridge”；点击后成功发送自建测试 ZIP，同名文件自动编号。
- 原生工作流页可显示现有允许列表；内置“打开收件目录”已从新界面触发并收到成功回执。
- DevEco Studio for Mac ARM **26.0.0.851** 已安装，当前路径为 `~/Applications/DevEco-Studio.app`。安装包为 Huawei Device 签名；`codesign --verify --strict` 通过，`spctl --assess` 返回 `accepted / Notarized Developer ID`。
- 鸿蒙官方工具链：Node **24.14.1**、Hvigor **6.26.8**、HarmonyOS SDK **26.0.0.105**。`npm run build:phone` 返回 `BUILD SUCCESSFUL`，编译主页面及 ShareExtensionAbility，生成 `harmony/entry/build/default/outputs/default/entry-default-unsigned.hap`。
- HAP ZIP 完整性检查通过；包含 `ets/modules.abc`、页面和资源。实际 `pack.info` 中 compatible/target 均为 **API 20**；`module.json` 保留两个 Ability、INTERNET/GET_NETWORK_INFO 权限。
- 修正 ArkTS 对对象展开和异常类型的限制、分享按钮括号、分享页面 LocalStorage 绑定及必填 scheme；补充媒体 UTD 类型，移除重复字符串资源和废弃解码方法。
- 构建仍有 SDK 的潜在异常/权限静态警告和模块包版本警告；没有关闭编译检查。剪贴板读取由用户点击 PasteButton 后进行，不申请后台剪贴板权限。上述行为仍需真机确认。
- 2026-10-26：使用用户提供的无线调试地址建立 HDC 连接。清除一次失效 TCP 会话后，`list targets -v` 持续显示 `Connected`，设备型号 `PLA-AL10`，真实设备返回 API **26**。DevEco 与官方 CLI 均识别为 **HUAWEI Mate 70 Pro+**。
- 官方 `@deveco/deveco-cli@1.3.0-stable` 已安装在 `.runtime/deveco-cli`，未安装为全局工具。初次网页登录回调未完成，重发登录流程复用已有浏览器登录状态后，浏览器显示登录成功，CLI 返回 `Login successful`。
- 新增 `phone:tools`、`phone:login`、`phone:sign` 及共用工具链定位；三个脚本的 `node --check` 通过，`phone:tools -- device list` 通过，重构后的 `build:phone` 再次返回 `BUILD SUCCESSFUL`。本机 `build-profile.json5` 和工具目录已由 `git check-ignore` 验证排除，通用模板不含签名字段。
- 机主完成实名认证后，退出并重新登录官方 CLI，认证检查通过。首次设备注册遇到 CLI 1.3.0 的预检查缺陷：无云端设备时只放行模拟器。使用忽略目录内的一次性兼容副本，限定已核对 HDC 身份的那台真机，执行官方后续设备注册与签名流程。原版 CLI 未修改；账号、云端授权和证书检查均保留。随后使用未修改的 `npm run phone:sign` 再次返回 `Signature generation completed successfully`。
- `npm run build:phone` 完成签名构建，`SignHap` 执行成功。产物 `harmony/entry/build/default/outputs/default/entry-default-signed.hap`，SHA-256：`64c0f322ef7148fdfbf2dfaeaa39cd01fac9657d8c194d277c85b6317c1d7a9f`。本机签名材料存在，私有配置仍被 Git 忽略。
- HDC 向真实 Mate 70 Pro+ 安装该签名包，返回 `install bundle successfully`。未卸载或清除现有应用数据。包名 `local.nearbridge.phone`，版本 `0.2.0 / 200`。
- 机主完成原生扫码配对，服务端设备 ID 和原有 6 条记录保留。机主在手机“遥控 Mac”点击“打开收件目录”，2026-10-26 12:06:03（北京时间）服务端记录 `source: phone / status: succeeded`；机主确认 Finder 弹出。
- 首次自动收件未发回回执。核对[官方 FileHash 接口](https://github.com/openharmony/docs/blob/master/en/application-dev/reference/apis-core-file-kit/js-apis-file-hash.md)和本机 SDK 后定位：CoreFileKit 返回大写十六进制，协议使用小写。修复目标文件恢复校验及新下载校验两处比较，保留 SHA-256 完整性检查。
- 修复版 `build:phone` 返回 `BUILD SUCCESSFUL` 并执行 `SignHap`。该次签名 HAP SHA-256：`1808010b60bb11d4464dcb5f0949e10d65e639777c3f8372e05cfea046ccf7aa`。无线调试地址变化后核对仍为同一台设备，覆盖安装成功；`aa start` 返回 `start ability successfully`。
- 更新后原生配对保留；2026-10-26 12:08:08 至 12:08:09，两个 ZIP、TXT 和 SVG 共 4 个 Mac 文件获得手机保存并校验后的 `receivedAt`。Mac 原生 UI 实际显示“手机已收取”。
- 机主从手机图库选择“分享 → 发送到 Mac”，收到一张 **7,244,375 字节 JPEG**，跨两个 4 MB 传输块。Mac 收件目录实际文件的字节数、SHA-256 均与服务端记录一致；Mac 原生传输页显示“手机 → Mac 7.2 MB”。未打开或分析照片内容。

## 蓝牙实验更新（2026-10-26）

详见 [蓝牙记录](BLUETOOTH.md)。经典 RFCOMM 已替换为 BLE，`npm test` **22 项通过**，`npm run check` 通过；新增测试覆盖实际 Swift 帧编码/MTU 拆分及 TLS 字节中继身份隔离。

前期两种蓝牙连接尝试期间，Mac `bluetoothd` 曾死锁退出；系统服务恢复、授权完成后，纯 BLE 真机验证成功：

- 16,415 字节 Mac 文件在约 5 秒后获得手机落盘哈希回执。
- 32,771 字节手机测试文件存入 Mac，实际字节数和 SHA-256 与记录一致；手机再经同一蓝牙通道下载回去校验，机主确认自检通过。
- 13:13:08 手机调用“打开收件目录”，服务端 `source: phone / status: succeeded`，机主确认 Finder 打开。
- Mac 观察到应用自己的回环 TLS 转发连接、蓝牙计数增长；手机日志确认 GATT、MTU 517、订阅及 TLS 隧道就绪。业务请求没有走局域网回退。HDC 调试仍走 Wi-Fi，不计业务数据传输证据。
- 更新保留配对与蓝牙选择，应用重新启动后自动重连。前台上传/下载/自检保持应用窗口亮屏，结束或退后台后释放；没有修改全局锁屏设置。
- 验证期间 Mac 蓝牙 PID 和启动计数保持稳定，没有再次崩溃。大文件、长期稳定性及主动故障恢复矩阵尚未验收。

两端最新构建及覆盖安装通过，Mac 签名检查通过；当前签名 HAP SHA-256：`50f8939904ce499f14a141316d64eb532959cc7d0102d57f8a19a1add86e32ea`。证据保存于 `.runtime/ble-real-transfer.json` 和 `.runtime/ble-roundtrip-verification.json`。此前名为“蓝牙直传验证.bin”的旧文件实际经局域网送达，不能算作蓝牙验证。

## 尚未验证

鸿蒙工程已签名并安装，首次配对、手机工作流、Mac 文件自动接收和图库系统分享已验收。首次启动的锁屏阻塞已由机主正常解锁解决；未调整手机安全设置。

DevEco 启动窗口读取问题已经解决：通过 Finder 将应用从 `/Applications` 移至 `~/Applications` 后，进程直接从安装路径运行，不再从 AppTranslocation 临时路径运行。用户已确认两份初始化协议，工程已打开并完成同步，可选统计数据共享已关闭。项目结构签名弹窗仍无法被当前自动化工具正确读取，因此改用官方 CLI；未修改系统安全设置。

初始化期间 app-analyzer 插件在应用包内产生了 166 个 Python 缓存文件，并改写了 3 个原有缓存，导致一次严格资源签名检查失败。已将这 169 个缓存移到 `.runtime/deveco-python-cache-backup` 备份，并从原始只读 DMG 还原 3 个文件；随后 `codesign --verify --strict --verbose=2` 再次通过。未重签名应用或放宽校验。

尚未完成：文件管理与浏览器各自的系统分享入口、mDNS 在更换局域网后的重新连接、传输中切换前后台/断网/杀进程的恢复、大文件和磁盘不足场景，以及错误证书和禁用工作流的手机侧负向验证。已有服务端测试不能替代这些真机场景。

Mac 的原生选择器与 Finder Service 已实测；跨窗口鼠标拖拽未单独端到端模拟。未读取或执行用户已有快捷指令，没有测试锁屏后台常驻，也没有实现该能力。

## 历史

0.1 的 14 组测试和浏览器界面验证仍由回归测试覆盖。原网页兼容入口继续存在；本轮不把网页备用端包装成原生手机体验。

原生界面截图在本机 `screenshots/native-transfer.png` 留存。截图含个人传输历史，未纳入 Git 仓库。
