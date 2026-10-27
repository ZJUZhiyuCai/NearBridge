# NearBridge 0.8 宣传素材

2026-10-27 制作。当前主宣传稿采用蓝、暖白、黄色，大标题与抽象连接图形突出 GitHub Star 入口。

| 文件 | 尺寸 | 用途与来源 |
| --- | --- | --- |
| [nearbridge-hero-star.png](nearbridge-hero-star.png) | 1774 × 887 | 当前 README 横幅；平面图形与 Star 入口 |
| [nearbridge-poster-star.png](nearbridge-poster-star.png) | 1024 × 1536 | 当前竖版海报；项目地址、二维码与 Star 引导 |
| [nearbridge-github-qr.svg](nearbridge-github-qr.svg) | 可缩放 | 直接编码 GitHub 项目地址，不包含配对凭据 |
| [demo-transfer.svg](demo-transfer.svg) | 1600 × 960，可缩放 | 文件互传场景；可编辑 SVG，使用虚构设备与文件 |
| [demo-workflows.svg](demo-workflows.svg) | 1600 × 960，可缩放 | 多电脑与手机工作流场景；可编辑 SVG，使用演示数据 |
| [nearbridge-hero.png](nearbridge-hero.png) | 1774 × 887 | 首版写实横幅，保留存档 |
| [nearbridge-poster-0.8.png](nearbridge-poster-0.8.png) | 1024 × 1536 | 首版写实海报，保留存档 |

这些图片均不是实际设备截图。场景 SVG 表达当前已实现的操作路径，不保证与每个平台的控件排布逐像素一致。没有使用真实传输记录、设备地址、配对二维码、签名材料或私人文件。Star 宣传稿由内置 `image_gen` 重制，项目二维码由 `qrcode` 库生成后作为输入。

海报成图中的二维码已通过 macOS Vision 独立识别，解码结果准确为 `https://github.com/ZJUZhiyuCai/NearBridge`，与程序生成的二维码源一致。

图中文字与 README 保持一致：蓝牙为实验通道，面向小文件、文字和工作流；不宣传后台常驻、投屏、无限容量或未经测量的速度。当前能力和真机验证范围见 [项目说明](../../README.md)与 [0.8 验证记录](../UNIFIED-0.8.md)。

当前稿的最终生成提示词见 [PROMPTS-STAR.md](PROMPTS-STAR.md)，首版提示词保留在 [PROMPTS.md](PROMPTS.md)。SVG 可直接编辑，无外部图片、字体下载、脚本或网络请求。字体优先使用系统中文字体。

仓库内自制素材随项目采用 [MIT](../../LICENSE)。平台名称用于说明兼容性，不表示获得平台厂商背书。
