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

安装器会注册 WPS 加载项并启动仅监听 `127.0.0.1` 的本地服务。服务随当前用户登录启动，账号数据存放在用户主目录下的 `.fishpi-wps`。若移动了解压目录，或下载了新版 ZIP，在新目录里再运行一次安装脚本。

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
