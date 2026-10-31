# 回复显示 JSON 包装或字面量 `\n`

## 现象与判断

如果一条回复开头出现 `[{"text":"…`，正文里显示字面量 `\n\n## 标题`，但粗体和行内代码仍然正常，优先检查**文本内容的包装/转义**，而不是 CSS。

正常 Markdown 的标题、列表、表格依赖真实换行。把正文序列化成 JSON 文本后，换行变成两个字符 `\` 和 `n`；Markdown 渲染器仍能识别行内的 `**粗体**` 和反引号，但无法把 `##` 放到新的一行，自然也无法识别表格。这种输入可以在当前真实渲染组件中复现该现象。

当前仓库的链路是：SDK 消息 → WebSocket JSON 事件 → 前端提取 `message.content` 中的 `text` → Markdown。服务端原样转发 SDK 消息，历史消息也读取 SDK 的会话记录；没有发现将整个 assistant content 再次序列化为正文的操作。

**这能解释截图，但不能只凭截图确定是谁产生了包装。** 可能是模型输出、复制进回复的工具结果、第三方 API/中转适配，或者远程运行的代码和当前仓库不同。需要查看异常消息已经解码的 `text` 字段来区分。

> 注意：网络事件 JSON 和磁盘 JSONL 本来就会使用 `\n` 表示换行。不能因为原始 JSON 里有 `\n` 就判断异常；必须先解析外层 JSON，再检查取出的正文。

## 远程取证：不修改会话、不需要 API 密钥

### 浏览器

1. 打开远程 WebUI 的开发者工具 → Network → WS → `/api/events`。
2. 在发生异常时找到 `type: "sdk"` 且内层 `message.type: "assistant"` 的最终消息。不要拿工具参数的 `input_json_delta` 当正文，也不要只检查某一个未完整的流式片段。
3. 解析该事件的外层 JSON 后，正文位置是 `packet.message.message.content` 内 `type: "text"` 块的 `text`。例如将复制的事件 JSON 字符串放入 `rawFrame` 后：

```js
const packet = JSON.parse(rawFrame)
if (packet.type !== 'sdk' || packet.message.type !== 'assistant') {
  throw new Error('请选择 sdk assistant 消息')
}
for (const block of packet.message.message.content) {
  if (block.type !== 'text') continue
  const text = block.text
  console.log({
    prefix: text.slice(0, 200),
    realNewlines: text.split('\n').length - 1,
    literalBackslashN: text.split('\\n').length - 1,
  })
}
```

- **取出的正文自己就以 `[{"text":…` 开头，真实换行很少或没有、字面量 `\n` 很多**：包装已经在 Markdown 渲染之前存在。继续查模型/工具/接口适配，而不是改样式。
- **最终正文是干净 Markdown，但浏览器仍显示包装**：核对同一条消息的 uuid，检查远程实际运行版本、是否加载旧前端、反向代理是否缓存了首页。
- **生成时异常，结束或刷新后正常**：比较 SDK 流式 `text_delta` 拼接结果与最终 assistant 文本，检查接口的流式与非流式输出是否一致。转义序列可能跨多个 delta，不能逐 token 全局反转义。
- **Elements 中已经有 `h2`/`table`，只是没有样式**：这是另一个问题，应检查 CSS 请求和构建产物；与正文里直接显示 `\n##` 的情况不同。

### 服务器的原始会话记录

用运行服务的同一用户，定位配置目录 `CLAUDE_CONFIG_DIR`（未设置时为 `~/.claude`）下 `projects/<编码后的项目目录>/<会话 ID>.jsonl`。以下脚本只读取记录，输出异常回复附近的正文前缀与换行数量；不要上传整份日志或凭据：

```bash
TRANSCRIPT='/实际路径/会话ID.jsonl'
python3 - "$TRANSCRIPT" <<'PY'
import json
import sys
from collections import deque

recent = deque(maxlen=5)
with open(sys.argv[1], encoding='utf-8') as records:
    for line in records:
        try:
            record = json.loads(line)
        except ValueError:
            continue  # 正在写入的尾行
        if record.get('type') != 'assistant':
            continue
        content = (record.get('message') or {}).get('content', [])
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get('type') != 'text':
                continue
            text = block.get('text', '')
            if not isinstance(text, str):
                continue
            recent.append({
                'uuid': record.get('uuid'),
                'prefix': text[:200],
                'realNewlines': text.count('\n'),
                'literalBackslashN': text.count('\\n'),
            })
for entry in recent:
    print(json.dumps(entry, ensure_ascii=False))
PY
```

如果会话记录解析后的正文已经带着包装，前端刷新或重新下载 CSS 不会改变原始内容。若需要继续定位，请只提供对应消息的**脱敏前缀、两种换行计数、远程版本，以及是否使用第三方 API/中转**。上述诊断输出本身也是 JSON，显示时再次转义是正常的；判断以计数和正文前缀的内容为准。

## 显示层兼容处理

当前兼容逻辑只对助手回复启用：

- 仅识别完整的对象/数组，其中每个块只有字符串 `text` 和可选的 `type: "text"`，且至少一块正文包含多行 Markdown 结构。
- 提取正文后再交给 Markdown；复制回复、Markdown 导出使用同一提取规则。
- 普通 Markdown、其他 JSON 结构、代码块示例、用户消息、文件预览和工具输出不做全局反转义。
- 支持 JSON-like 字符串中合法的 JavaScript `\u{…}` 码点转义这一有限扩展；不使用 `eval`，不接受任意 JavaScript、不递归解码正文里的示例。
- 不完整、无法解析或包含非文本块的数据保持原样。流式回复只有在完整包装到达后才会解包。
- 原始会话数据不被改写，恢复后的正文下面有“已还原序列化文本 · 查看原文”。如果模型本来就是刻意输出这种恰好匹配的 JSON 示例，仍然可以在这里查看原始内容。

这是可逆的显示兼容，不代表已经确认某个模型或网关有故障；产生错误包装的源头仍应根据原始记录排查。

## 部署与复查

先把补丁同步到**远程服务实际使用的仓库目录**，然后：

```bash
pnpm test
pnpm typecheck
pnpm --filter @ccw/web build
```

本次没有新增依赖或修改后端。标准部署由 server 每次请求读取 `packages/web/dist`，因此只需构建前端，再在原来的远程地址强制刷新页面；通常**不需要重启 server，不需要中断会话，也不需要新开一个 Vite 服务**。

复查旧异常回复是否恢复标题和表格，并能展开原文。如果使用 Docker、独立静态目录或额外 CDN，需更新实际部署的前端产物；若代理缓存了首页，还需让新首页和带新哈希的 JS/CSS 生效。只在另一个本地目录构建，不会更新远程实例。
