# Claude Code WebUI

在浏览器里使用 Claude Code。server 通过 [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 驱动本机的 `claude` CLI，会话和 CLI 共用 `~/.claude/projects` 下的记录：CLI 里的会话能在 WebUI 里接着聊，WebUI 的会话也能用 `claude --resume <id>` 接回终端。

## 功能

- **会话**：侧栏按项目切换，按时间分组，支持搜索；刷新页面或断线重连时，进行中的回合不会丢失。
- **输入框**：`/` 命令面板、`@` 引用文件、模型切换、effort 滑杆，权限模式可选 default / acceptEdits / plan / bypassPermissions。上下文占用以圆环显示在发送按钮旁。
- **对话渲染**：工具调用和权限请求以卡片形式展示；子 agent 可以展开成独立对话，也可以切到像素办公室视图；还支持 workflow 视图，以及从任意一条用户消息回退文件改动。
- **右侧面板**：文件树、CodeMirror 编辑器、Markdown 预览、git 改动与 diff、xterm.js 终端（node-pty）、会话详情和 MCP 管理。
- **补齐 SDK 缺少的命令**：`/rename`、`/branch`、`/export`、`/copy`、`/mcp`、`/status` 在浏览器端实现。
- **远程访问**：支持 TLS 和设备配对码；本机访问免配对。

## 结构

pnpm monorepo，三个包：

| 包 | 内容 |
| --- | --- |
| `packages/server` | Node server：会话管理（Agent SDK）、HTTP API 与 WebSocket 事件流、终端、git、文件、鉴权 |
| `packages/web` | React + Vite 前端 |
| `packages/shared` | 两端共用的类型和常量 |

## 环境要求

- Node.js 22 或更高版本，pnpm 11（`corepack enable` 会按 `packageManager` 字段自动装上）。
- 已安装并登录的 `claude` CLI。server 优先使用 PATH 上的 `claude`，这样 WebUI 和终端跑的是同一个版本；找不到时退回 SDK 自带的版本。
- 终端功能依赖 node-pty，它在 `pnpm install` 时编译，Linux 上需要 `python3`、`make` 和 `g++`。

## 本地运行

```bash
pnpm install
pnpm dev      # server（:3090，tsx watch）+ Vite（:5190）
```

打开 http://127.0.0.1:5190 。本机访问不需要配对。

`pnpm dev` 下改动 `packages/server` 或 `packages/shared` 的源码会触发 server 重启，所有正在运行的会话都会中断。如果要用 WebUI 里的会话修改 WebUI 自身的代码，改用不带 watch 的 `pnpm start`。

## 远程部署

```bash
pnpm install
pnpm --filter @ccw/web build      # server 会直接托管 packages/web/dist
pnpm --filter @ccw/server start   # UI 和 API 同在 :3090
pnpm pair --url https://你的地址    # 生成新设备的配对码和二维码
```

server 监听非 loopback 地址时必须配置 TLS，否则拒绝启动。只有 IP、没有域名也可以部署。TLS 的各种方案、配对规则和本机免配对的判定条件见 [docs/remote-deployment.md](docs/remote-deployment.md)。

不要把 Vite dev server（5190）暴露到网络上。

## 配置

| 变量 | 作用 |
| --- | --- |
| `CCW_HOST` / `CCW_PORT` | 监听地址和端口，默认 `127.0.0.1:3090` |
| `CCW_CLAUDE_PATH` | 指定 `claude` 可执行文件的路径 |
| `CLAUDE_CONFIG_DIR` | Claude Code 配置目录，会话记录从这里读取，默认 `~/.claude` |
| `CCW_TLS_CERT` / `CCW_TLS_KEY` | PEM 证书和私钥路径，远程部署时使用 |
| `CCW_REQUIRE_PAIRING=1` | 本机访问也要求配对 |
| `CCW_CONFIG_DIR` | 设备和配对码的存放目录，默认 `~/.config/claude-code-webui` |
| `CCW_PUBLIC_URL` | `pnpm pair` 生成二维码时使用的地址 |

## 开发

```bash
pnpm test                         # 单元测试
pnpm typecheck                    # 三个包的类型检查
pnpm --filter @ccw/server smoke   # 冒烟测试：起一个真实会话跑一个回合，会消耗 API 额度
```

## 安全提示

WebUI 能打开终端，也能以跳过权限模式运行 Claude，所以能访问它就等于拿到了这台机器的 shell。暴露到网络之前，请先读完 [docs/remote-deployment.md](docs/remote-deployment.md)。建议用专门的普通用户运行服务，不要用 root。
