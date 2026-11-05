# Arena

在终端里跟 arena.ai 的 Agent 模式对话。两个组件：

- **arena-lite** — 终端界面，单文件 exe
- **arena-bridge** — 本地桥，用 Chrome 远程调试接口把网页接进命令行

装完双击桌面上的 **Arena** 就能用。

## 安装

1. 解压这个压缩包到任意目录
2. 双击 `install.cmd`
3. 按提示走完

装到 `%LOCALAPPDATA%\Programs\Arena`，加进用户 PATH，建桌面和开始菜单快捷方式。**不需要管理员权限**。

需要 Node.js 21 或更新的版本（[nodejs.org](https://nodejs.org/)），以及 Chrome 或 Edge。安装程序会检查，缺了会告诉你。

## 使用

```
arena                 进交互界面
arena "问题"           单发一条
arena -d "问题"        Direct 模式
arena --version       版本
```

第一次启动会自己拉起一个独立的 Chrome 窗口（专用 profile，不碰你日常用的那个）和桥。稍等几秒。

## 卸载

开始菜单 > Arena > 卸载 Arena。

登录态和会话记录留在 `%USERPROFILE%\.arena-bridge`，想一起清掉：

```
powershell -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\Programs\Arena\uninstall.ps1" -Purge
```

## 常见问题

**敲 arena 提示找不到命令** — 装完要开个新终端，PATH 才生效。

**连不上桥** — 看 `%LOCALAPPDATA%\Programs\Arena\bridge.log`。多半是 node 没装或者版本太旧。

**撞上人机验证** — 浏览器窗口会自动弹到最前，手动过一下验证码，回来重发这条消息。

**Chrome 打不开** — 桥会自己找 Chrome/Edge。装在非常规位置的话，设个用户环境变量 `ARB_CHROME` 指向 exe 全路径。

## 目录结构

```
Arena\
├── arena-lite.exe        终端界面
├── arena.cmd             启动器（PATH 里就是它）
├── bridge\
│   ├── arena_bridge.js   桥
│   ├── lib\parse.js
│   ├── launch.cmd
│   └── bridge.log        运行时日志
├── scripts\
│   ├── restore-chrome.ps1
│   └── minimize-chrome.ps1
├── install.ps1 / uninstall.ps1
└── VERSION
```
