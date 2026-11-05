# AGENTS.md — 给 AI / 自动化用

这个仓库是 **arena.ai Agent 模式的终端客户端**。两层：

- `arena-lite/`：Rust 单文件 CLI / TUI，零第三方依赖
- `installer/bridge/`：Node 桥的快照，正本在 [arena-bridge](https://github.com/Therenery/arena-bridge)。桥跑在电脑上，用 CDP 驱动真实 Chrome 打开 arena.ai

## 最短路径

```bash
arena-lite health                 # 桥通不通、Chrome 连没连、队列几格
arena-lite "只回一个字：好"        # 单发，走桥
arena-lite                        # 进 TUI，连续对话
arena-lite resume                 # 列出网页左侧栏的会话
arena-lite resume 3               # 打开第 3 个，带终端就进 TUI
arena-lite history                # 打印当前标签页的对话（只读）
```

装完在 PATH 里的命令是 `arena`，`arena-lite` 是同一个 exe。

## 会话模型（最容易踩的坑）

- **每次直接 `arena` 都新开一个会话**：`main`、`main-2`、`main-3`……屏幕是空的，不会自动接上次。
- 要接着网页上的旧对话，用 `/resume`（TUI 内）或 `arena-lite resume <编号|URL>`。
- `/session <名字>` 只换标签页，不把旧对话读进屏幕；读历史用 `/resume`。
- 切仓库（`/repo <owner/name>`）等于开新对话，桥会清掉该会话的服务端历史。

## TUI 里常用

| 命令 | 作用 |
|---|---|
| `/resume` | 弹出网页会话列表，↑↓ 选、Enter 打开 |
| `/upload` | 不带参数弹系统选文件窗口；带路径直接上传 |
| `/upload <路径[,路径]>` | 上传本地文件到当前会话 |
| `/repo` | 列仓库；`/repo owner/name` 直接切 |
| `/config` | 设置：语言、渲染、思考链/工具块、选文件方式 |
| `/battle` | 双栏对战；`/vote a\|b\|tie\|both` 投票 |
| `/health` | 体检桥 |
| `/new` | 清空服务端会话 |

`/upload` 的选文件方式在 `/config` →「选文件方式」里切：`文件管理器`（Windows 资源管理器 / Linux zenity）或 `手动输路径`。Linux 没有 zenity/kdialog 时会提示改用路径。

## 给程序调（桥的 HTTP 接口）

桥默认监听 `127.0.0.1:17892`，无第三方依赖。

| 接口 | 说明 |
|---|---|
| `GET /health` | 桥状态、Chrome、会话、队列 |
| `POST /ask` | 简化提问，返回答案 |
| `POST /v1/chat/completions` | OpenAI 形状的子集，支持 `stream: true`；**不要当通用 OpenAI 后端** |
| `GET /history?session=main` | 读当前标签页的对话 |
| `GET /conversations?session=main` | 读网页左侧栏的会话列表 |
| `POST /upload` | `{session, files:[绝对路径]}`，把文件挂到输入框 |
| `GET /repos` / `GET /repo?name=owner/name` | 读 / 切仓库 |
| `GET /new?session=main` | 清空会话 |

`/v1/chat/completions` 的 `model` 传 `arena-agent` / `arena-direct`，`user` 字段是会话名。`tools` / function calling 不映射成 `tool_calls`。

## 常见错误

| 现象 | 处理 |
|---|---|
| `NEED_VERIFY` / 409 | 撞人机验证。桥会把 Chrome 拉到前台，手动过一下，再重发 |
| `chrome unavailable` | 桥找不到 Chrome/Edge；设 `ARB_CHROME` 指到 exe 全路径 |
| 连接被拒 | 桥没起。双击桌面 Arena，或跑 `bridge\launch.cmd` |
| 队列满 429 | 最多 4 个任务，同一会话两次提问至少隔 3 秒 |
| 上传 403 | 桥设了 `ARB_UPLOAD_ROOTS` 白名单；把文件放进白名单目录，或清掉这个变量 |

## 协作：欢迎子智能体 / 子代理

本项目欢迎设子智能体和子代理。检索、调研、找素材、比对候选、并行验证这类彼此独立的子任务，直接拆给子代理并行跑，不要在主线程里串行查。主线程负责判断、整合、验收；子代理的产出要回收核对，不能直接当结论。同时最多 2 路重型子代理。

## 不要做

- 不要把 `arena-lite` 当通用 OpenAI 客户端接别的模型；它只对接 arena.ai 的 Agent/Direct 页面。
- 不要绕过桥直接改 Chrome 的 cookie / 伪造请求；桥的设计是驱动真实页面。
- 不要在仓库里加第三方依赖；`[dependencies]` 必须为空。
