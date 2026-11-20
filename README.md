# 摸鱼派聊天室 for WPS

在 WPS 文字顶部选择 **摸鱼派 → 打开聊天室**，即可在当前窗口右侧聊天。点击聊天图片可弹出大图，用左右按钮或方向键切换图片，按 `Esc` 关闭。顶部的 **访问摸鱼派** 会在默认浏览器打开摸鱼派网站。

## 安装

先安装并打开过支持 **JS 加载项** 的 WPS Office。Windows 和 Linux 的 WPS 客户端需要包含 JS 加载项功能，具体取决于版本和发行渠道。[WPS 加载项可用性](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/addin-api/wps-addin-availability)

在 [GitHub Releases](https://github.com/FishPiOffical/fishpi-wps/releases/latest) 下载对应系统和架构的 `fishpi-wps-<版本>-<系统>-<架构>.zip`，完整解压到打算长期保留的目录。**ZIP 已包含运行时，使用者无需安装 Node.js、npm 或其他开发工具。** Intel / AMD 的 64 位电脑选 `x64`，Apple 芯片或 ARM 的 64 位电脑选 `arm64`。

| 系统 | 安装方法 |
| --- | --- |
| macOS | 下载 `macos` 包。双击 `install-mac.command`，或者在终端运行 `zsh install-mac.command`。如果 macOS 提示 Terminal 访问 WPS 的 App 数据，选择允许。 |
| Windows | 下载 `windows` 包。双击 `install-windows.cmd`，也可以在解压目录的命令提示符里运行它。 |
| Linux | 下载 `linux` 包。在解压目录用当前桌面用户运行 `sh install-linux.sh`。使用 glibc 2.28 或更新版本的桌面 Linux。 |

安装完成后保存文档并完全退出 WPS，再打开 **WPS 文字**。如果 WPS 提示允许加载摸鱼派，选择允许。随后在顶部选择 **摸鱼派 → 打开聊天室**，使用摸鱼派账号登录。

安装器会注册 WPS 加载项并启动仅监听 `127.0.0.1` 的本地服务。服务随当前用户登录启动，账号数据存放在用户主目录下的 `.fishpi-wps`。若移动了解压目录，在新目录里再运行一次安装脚本。

在 Windows 上可直接把图片粘贴到聊天输入框。如果 Mac 上的 `⌘V` 把图片插进了文档，请点击聊天室输入框旁的 **粘贴**，由本地服务读取系统剪贴板图片。macOS 若弹出权限提示，可以在允许后重试。也可以用 **+** 选择图片文件。

## 升级

保存文档并完全退出 WPS。从 [GitHub Releases](https://github.com/FishPiOffical/fishpi-wps/releases/latest) 下载新版 ZIP，解压到新目录，再运行对应的安装脚本即可覆盖注册。升级会保留已有账号和设置。重新打开 WPS 文字确认可用后，可删除旧版解压目录。

也可以使用命令升级。若从 `0.1.0` 升级，先把 [update.mjs](https://raw.githubusercontent.com/FishPiOffical/fishpi-wps/v0.1.1/scripts/update.mjs) 保存到现有解压目录，与 `runtime` 文件夹并列。新版 ZIP 已附带此脚本。脚本会从 GitHub Releases 下载相应架构的 ZIP、校验 SHA-256，并在用户主目录的 `.fishpi-wps/releases` 中安装。Linux 命令升级需要系统有 `unzip`。

| 系统 | 升级到 `0.1.2` |
| --- | --- |
| macOS / Linux | `./runtime/bin/node ./update.mjs v0.1.2` |
| Windows（PowerShell） | `.\runtime\node.exe .\update.mjs v0.1.2` |

省略版本参数会安装 GitHub 上最新的正式版本。

## 卸载

先保存文档并完全退出 WPS。用平时运行 WPS 的账号，在 `0.1.1` 或更新版本的解压目录运行对应命令。即使当前安装的是 `0.1.0`，也可以直接用新版卸载，无需先安装新版。`0.1.0` 的脚本会忽略 `--uninstall`，继续执行安装。

| 系统 | 卸载命令 |
| --- | --- |
| macOS | `zsh install-mac.command --uninstall` |
| Windows（PowerShell） | `.\install-windows.cmd --uninstall` |
| Linux | `sh install-linux.sh --uninstall` |

卸载会移除摸鱼派的 WPS 注册和登录启动项，并停止本地服务。重新打开 WPS 文字后，顶部入口会消失。账号和设置默认保留，方便重装。

### 同时删除文件

从 `0.1.2` 或更新版本的解压目录运行卸载命令，把 `--remove-files` 后面的路径换成要删除的旧安装目录。

```powershell
.\install-windows.cmd --uninstall --remove-files "D:\Apps\fishpi-wps-0.1.0-windows-x64"
```

macOS 和 Linux 可以在上表的卸载命令后加同样的参数。安装器会核对目录属于摸鱼派，再清理其中的安装文件。还想清除本机登录信息、设置和日志，可以再加 `--purge-data`。通过升级脚本下载的旧版本也可用 `--remove-files` 指定其解压路径。

使用已发布的 `0.1.1` 安装器时，先用 `--uninstall` 完成卸载，随后可以手动删除旧解压目录。若要清除本机账号和设置，也可在卸载后手动删除用户主目录下的 `.fishpi-wps`。

## 从源码安装

安装 Node.js 22.16 或更新版本后，使用对应系统的安装脚本。脚本会安装项目依赖并构建加载项。可以用 `npm test` 构建并运行测试。

## 发布

推送与 `package.json` 版本一致的 `v<版本>` Git 标签后，GitHub Actions 会分别生成三种系统的 x64 和 arm64 ZIP，检查包内运行时与安装脚本，然后创建 GitHub Release。在 macOS 或 Linux 上，可以用 `npm run package -- linux-x64` 等命令为指定平台构建 ZIP。

## WPS 接口

- [WPS 自定义功能区](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/addin-api/customize-ribbon/overview)
- [WPS 任务窗格](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/addin-api/TaskPane/task-pane-overview)
- [WPS ShowDialog](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/addin-api/Application/member/ShowDialog)
- [WPS 加载项发布与部署](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/wps-addin-development-instructions)
- [WPS 技术支持的 Mac 加载项说明](https://forum.wps.cn/topic/50515)
