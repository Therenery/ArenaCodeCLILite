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

## 组成

| 路径 | 作用 |
|---|---|
| `arena-lite/` | Rust 客户端源码，18 个源文件，`Cargo.toml` 的 `[dependencies]` 为空 |
| `bridge/` | 配套的 Node 桥，监听 `127.0.0.1:17892`，同样无第三方依赖 |

桥放在这里是为了克隆下来就能跑；它和 [ArenaCodeCLI-Simplify](https://github.com/Therenery/ArenaCodeCLI-Simplify) 里的那份是同一个。

## 编译

```powershell
cd arena-lite
cargo build --release        # 产物 target\release\arena-lite.exe
```

零依赖，不会去 crates.io 拉任何东西。没有 cargo 的环境用等价脚本直编：

```bash
cd arena-lite
bash scripts/check.sh        # 编 release + 跑全部单测 + 顺手做一次 Windows 目标编译检查
```

## 跑起来

```cmd
rem 1. 起 Chrome（带调试端口，登录 arena.ai，切 Agent 模式）
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%USERPROFILE%\.arena-bridge\chrome-profile" ^
  --no-first-run --no-default-browser-check

rem 2. 起桥
cd bridge
node arena_bridge.js

rem 3. 起客户端
arena-lite
```

`arena-lite health` 检查桥通不通，`arena-lite --help` 看全部子命令。

## 已验证

| 项 | 结果 |
|---|---|
| 交叉编译 | `rustc 1.93.1` → `x86_64-pc-windows-gnu`，638 KB 单文件 |
| 版本 | `arena-lite --version` → `arena-lite 2.0.0` |
| 体检 | `arena-lite health` → 桥通、Chrome 已连接、队列 0/4 |
| 单发 | `arena-lite '只回一个字：好'` → `好`（真走桥） |
| 单测 | `cargo test` 全绿 |

## 详细文档

`arena-lite/README.md` 里有完整的键位表、模式说明、SSE 事件映射和实现约束。

## 相关

- [ArenaCodeCLI-Simplify](https://github.com/Therenery/ArenaCodeCLI-Simplify) — 同一套桥的 Qwen Code 改造版 CLI
