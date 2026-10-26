# NearBridge 实现说明

日常路径以原生端为主：Finder 分享/拖拽 → Mac 发送队列 → 已配对手机收件箱。Mac 使用 SwiftUI + AppKit，手机使用 ArkTS + ArkUI。网页继续兼容已有会话。

## Mac

`macos/Models.swift` 定义协议模型；`BridgeModel.swift` 管理状态、文件/文件夹队列和续传；`BridgeView.swift` 与 `BridgeDesign.swift` 实现侧边栏、对话式互传、快捷指令磁贴、分组设备设置；`NearBridge.swift` 负责窗口、菜单栏、全局快捷键、Finder Services、Bonjour 和本地服务生命周期。

用户选择的目录通过系统 `ditto` 打包，参数数组调用，不拼接 shell。实际发送前检查源文件大小与修改时间。进度代表已经提交到 Mac 发件暂存的字节；手机保存回执单独显示，避免把暂存成功当作远端收件成功。

## 传输

`src/transfers.mjs` 维护持久化清单和 `.part` 文件。每个传输由 UUID 标识，4 MB 分块、期望 offset 校验、单文件互斥、最多 3 个并发分块。分块完整收到后写入并 fsync，再提交清单偏移；重启截去未提交尾部。完成时流式计算 SHA-256，转入原 Store。已完成 UUID 返回原 item，重试不会生成第二份记录。

上传配额包含未完成传输的保留字节。下载支持单段 HTTP Range。手机落盘、SHA-256 一致后提交收件回执。文件在手机私有目录内按 UUID 隔离，导出需经过系统文件选择器。

## 身份和网络

网页端继续使用 53319 和原证书。原生端独立使用 53320；二维码传递本机私有 CA、公钥 SHA-256、一次性 token 和当前地址。原生 HTTP 同时启用 CA 校验和公钥固定。mDNS 仅提供候选地址，连接身份取决于 TLS；凭据不依赖广播的名称。

Mac 每 8 秒检查网络地址，必要时重新签发叶证书、热更新原生 TLS。私有 CA 与叶公钥不变。旧网页证书不随原生证书更新而改变。Mac 原生 App 发布 `_nearbridge._tcp.`，手机前台断线时重新发现。所有接口仍限制到本机私有 IPv4/回环 Host。

从旧网页升级到原生端必须在 Mac 主动生成原生配对码，再批准新请求。沿用 device ID 保留历史，换发 token 使旧网页会话失效。尚未批准时旧配对继续有效。

## 鸿蒙生命周期

UIAbility 管理主页面，ShareExtensionAbility 在系统分享面板中展示发送页。默认扫码使用 Scan Kit 的系统 UI；粘贴使用 PasteButton。主页面前台轮询与自动接收，进入后台停止轮询，未完成下载保留 `.part`。不以空音频、无限后台服务等方式保活。

手机工程需要官方 SDK 编译、账号签名和真机测试；未通过这些阶段前，其系统集成能力只算源码实现。

## 0.3 界面与状态契约

Claude 原稿与 Codex 适配记录见 [0.3 更新](REDESIGN-0.3.md)。手机采用首页和连接设置弹层；`linkPhase` 提供结构化连接状态，`progressFraction` 提供进度，`transferPhase` 区分发送、接收、完成、暂停、失败。过期网络回调不能覆盖切换后的状态；Mac 已接受的发送或工作流不会因随后刷新失败被报告为操作失败。
