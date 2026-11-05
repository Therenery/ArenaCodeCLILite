# ArenaCodeCLILite

`arena_bridge` 的纯自研终端客户端：Rust 写，**零第三方依赖**（只有 std），Windows 优先，单二进制。

只做桥接这一件事——常驻模式对话（agent / direct / side / battle）、双栏对战与投票、网页端历史载入、桥体检。

**没有**渠道（微信/QQ/飞书/钉钉）、**没有**沙箱、**没有** MCP、**没有**扩展 / skills / 子代理 / 批量任务。

```
 arena │ agent │ arena-agent │ main │ 127.0.0.1:17892 ●                  ⠋ 12s
──────────────────────────────────────────────────────────────────────────────────
你 › 帮我看看这个仓库的结构
arena ❯ 好的，我先看一下目录树……
· 思考（12 行，Ctrl+R 展开）
▸ 工具 read_file  src/main.rs
──────────────────────────────────────────────────────────────────────────────────
› 输入问题，Enter 发送，Ctrl+C 退出
```

## 安装

到 [Releases](https://github.com/Therenery/ArenaCodeCLILite/releases/latest) 下载 `arena-setup-<版本>.zip`：

1. 解压到任意目录
2. 双击 `install.cmd`
3. 完事

安装程序会把这些放到 `%LOCALAPPDATA%\Programs\Arena`：

- `arena-lite.exe` —— 客户端
- `bridge\` —— 桥（Node，随包附带）
- `scripts\` —— 浏览器最小化 / 抢焦点
- `install.ps1`、`uninstall.ps1`

然后加进用户 PATH，建桌面和开始菜单快捷方式。**不需要管理员权限**，不写注册表启动项，不装服务。

卸载：开始菜单 → Arena → 卸载 Arena。

依赖：Node.js ≥ 21（[nodejs.org](https://nodejs.org/)）和 Chrome / Edge。安装程序会检查。

## 组成

| 路径 | 作用 |
|---|---|
| `arena-lite/` | Rust 客户端源码，`Cargo.toml` 的 `[dependencies]` 为空 |
| `installer/` | 安装包内容（脚本、桥的副本、说明），`build-installer.ps1` 把它和 exe 打成 zip |
| `dist/` | 打好的安装包，不进版本库 |

桥的正本在 [arena-bridge](https://github.com/Therenery/arena-bridge)（`node arena_bridge.js`，监听 `127.0.0.1:17892`，同样零第三方依赖）。`installer/bridge/` 是发版时的快照，升级桥要两边同步。

## 编译

```powershell
cd arena-lite
cargo build --release        # 产物 target\release\arena-lite.exe
```

零依赖，不会去 crates.io 拉任何东西。没有 cargo 的环境用等价脚本直编：

```bash
cd arena-lite
bash scripts/check.sh        # 编 release + 跑全部单测 + 交叉编出 Windows exe
```

打安装包：

```powershell
powershell -ExecutionPolicy Bypass -File build-installer.ps1
# 产物 dist\arena-setup-<版本>.zip
```

## 从源码跑

```cmd
rem 1. 起桥（在 arena-bridge 仓库里；会自己找 Chrome，带 --remote-debugging-port=9222 拉起来）
git clone https://github.com/Therenery/arena-bridge
cd arena-bridge
node arena_bridge.js

rem 2. 第一次：在弹出的窗口里登录 arena.ai，切到 Agent 模式（之后一直复用这个 profile）
rem 3. 起客户端
arena-lite
```

`arena-lite health` 检查桥通不通，`arena-lite --help` 看全部子命令。

## 已验证

| 项 | 结果 |
|---|---|
| 交叉编译 | `rustc 1.93.1` → `x86_64-pc-windows-gnu`，722 KB 单文件 |
| 版本 | `arena-lite --version` → `arena-lite 2.0.7` |
| 体检 | `arena-lite health` → 桥通、Chrome 已连接、队列 0/4 |
| 单发 | `arena-lite '只回一个字：好'` → `好`（真走桥） |
| 单测 | 140 个全绿 |
| 安装 | 解压 → `install.cmd` → 桌面图标能起客户端；`uninstall.ps1` 能清干净 |

## 详细文档

`arena-lite/README.md` 里有完整的键位表、模式说明、SSE 事件映射和实现约束。

## 相关

- [arena-bridge](https://github.com/Therenery/arena-bridge) — 配套的 Node 桥（正本）
