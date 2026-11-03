# 仓库审查问题与排查清单（2026-11-03）

本文件保留初次只读代码审查的发现，并记录后续逐项复核、修复和验收结果。问题描述与原始证据对应审查基线；当前处理状态以各条目的状态、复核结论和验证记录为准。

## 审查基线与使用说明

- 审查提交：`ca5fd3f`（`chore: release 0.26.0`）。
- 项目版本：根目录 `package.json` 的 `0.26.0`。
- SDK 依据：实际安装的 `@anthropic-ai/claude-agent-sdk@0.3.312` 的类型定义与实现，入口位于 `packages/server/node_modules/@anthropic-ai/claude-agent-sdk/`，实际文件由 pnpm 链接提供。
- 项目约定：根目录 [AGENTS.md](../AGENTS.md) 和 [docs/](./)，尤其是 [发布约定](./releasing.md) 与 [远程部署约定](./remote-deployment.md)。
- 确认问题：**14 项，其中高 3 项、中 10 项、低 1 项**；另有 **1 项待确认**。
- 本次审查没有修改业务代码。复现使用临时目录、真实生产函数、模拟 RPC/WebSocket 或可控组件时序，没有进行真实模型调用和生产部署验证。

以下行号对应审查提交，后续代码变动后应结合函数名定位。建议完成复核、修复及验收后勾选确认问题；待确认项在取得证据并记录结论后勾选。可直接在对应条目末尾补充复核结论、修复提交和验证结果。

临时复现脚本曾保存在 `/tmp`，不属于仓库交付物，也不保证长期存在。本文保留了复现条件、方法和观察结果，后续排查不应依赖这些临时文件。

## 复核与修复总结（2026-11-03）

15 项全部复核并修复，本批修复纳入 `v0.26.1`。Claude Code 会话 `f971827c-7cce-4774-b38d-871827b1f7dc` 记录了逐项复现、修复和验证，中断前最后一次完整验证为 `pnpm test` **341/341 通过**、`pnpm typecheck` 通过（原基线为 320 项）。前端相关项（BUG-002/005/006/010/011、PENDING-001）还在隔离实例（server 3091 + vite 5191 + 实际运行的 CLI 2.1.316 + 本地假 Messages API，不调用真实模型）中用 Playwright 做了端到端验证。

Codex 接续时补充修复 BUG-005 的“保存期间改回旧磁盘内容”边界，并新增 4 项组件回归测试。发布前已在权限恢复后的环境重新执行完整 `pnpm test`，**345/345 全部通过**，`pnpm typecheck` 三包通过；此前受限的 HTTP 与分享测试已补齐。最终验证结果与发布注意事项见根目录 [verification.md](../verification.md)。

与原记录不一致、需要注意的几点：

- **BUG-013 的范围**：`git checkout`/`git restore` 在字面同名文件存在于 tree 或 index 时会按字面匹配（git 2.43 实测），所以“取消暂存”和“放弃更改”在实际使用中不会误伤其他文件。确认受影响的是 `git add`（暂存），以及原文未提到的 diff 视图（`git diff`/`git show`）会混入其他文件的改动。修复对所有来自文件列表的路径统一加了 `:(literal)`。
- **BUG-002 还有第二个触发条件**：回合进行中连续发送的多条消息，会被 CLI 合并成一条，只保留最后一条的 uuid。这样即使没有发送失败，位置对齐也会把较早那条映射到更早的检查点。
- **PENDING-001 已确认**，并且发现 CLI 2.1.316 的 `new_conversation_id` 等于 reset 帧自身的 `uuid`，不是新会话的 id。新会话 id 要看 reset 之后各帧的 `session_id`，新 transcript 的文件名也是它。照 SDK 文档字面使用 `new_conversation_id` 会迁移到一个不存在的会话。
- **BUG-004 临时文件名**：写入串行化之后，同一进程同一时刻只有一个保存在进行，`${pid}.tmp` 已经唯一。所以没有改成随机名，与仓库中 `shares.ts`、`devices.ts` 的做法一致。
- **BUG-003/012 发布约束**：修复只对“装上这个版本之后的下一次更新”生效。把用户从旧版本更新到修复版本的，仍是旧 updater。旧 updater 只在“依赖有变化且首次安装失败后重试”时出错，所以发布修复的那个版本最好不改 `pnpm-lock.yaml`/`pnpm-workspace.yaml`。

## 排查进度

- [x] [BUG-001](#bug-001) · **高** · 取消下载泄漏文件描述符，公共静态资源可触发。
- [x] [BUG-002](#bug-002) · **高** · 发送失败导致文件回退映射到错误检查点。
- [x] [BUG-003](#bug-003) · **高** · 更新重试跳过未完成的依赖安装并宣告成功。
- [x] [BUG-004](#bug-004) · **中** · 设置与渠道并发保存互相覆盖，甚至写坏 JSON。
- [x] [BUG-005](#bug-005) · **中** · 文件保存期间继续输入，新输入被清除。
- [x] [BUG-006](#bug-006) · **中** · 多标签页权限模式显示与实际执行模式不一致。
- [x] [BUG-007](#bug-007) · **中** · 终端收到 JSON `null` 导致服务器退出。
- [x] [BUG-008](#bug-008) · **中** · FIFO 预览阻塞并可能耗尽文件操作线程池。
- [x] [BUG-009](#bug-009) · **中** · `!` 命令超时只终止 shell，前台子进程继续运行。
- [x] [BUG-010](#bug-010) · **中** · 断线期间完成的回复在重连后没有恢复。
- [x] [BUG-011](#bug-011) · **中** · 权限或问答提交失败后卡片消失，服务端继续等待。
- [x] [BUG-012](#bug-012) · **中** · 更新失败后，该进程不再发现后续修复版本。
- [x] [BUG-013](#bug-013) · **中** · 单文件暂存将文件名通配字符解释为 Git pathspec。
- [x] [BUG-014](#bug-014) · **低** · 活跃设备的使用时间未持久化，重启后被误判过期。
- [x] [PENDING-001](#pending-001) · **已确认，中** · `conversation_reset` 未处理，清空会话后发生身份与历史失配。

## BUG-001

**取消文件下载会泄漏文件描述符，未配对客户端也能触发。**

**严重程度：高。状态：已复核并修复，纳入 v0.26.1。**

**位置：** [packages/server/src/http/static.ts:77](../packages/server/src/http/static.ts#L77)、[packages/server/src/files/raw.ts:66](../packages/server/src/files/raw.ts#L66)。

**问题：** 两处使用 `createReadStream(...).pipe(res)`，只处理源流读取错误，没有在响应提前关闭时销毁读取流。目标流关闭后，`pipe()` 会解除连接，但不会自动销毁源流；未读完的源流可能暂停并一直持有文件描述符。

**触发场景：** 下载较大的静态资源、工作区文件或共享文件，在读取完成前取消请求、刷新页面或断开连接。重复操作会持续增加文件描述符占用。公共静态资源无需配对，远程未认证客户端也能触发，最终影响整个服务的文件操作和新连接。

**验证证据：** 调用真实 `serveStatic()`、`sendFile()`，以第一次收到写入就关闭的 `Writable` 模拟响应提前关闭；各执行 5 次，`/proc/self/fd` 中指向测试文件的 FD 数量从 **0 → 5 → 10**，强制 GC 后仍未释放。这是生产函数层面的复现，未对真实公开端口进行压测。

**修复建议：** 使用能够联动销毁两端的 `pipeline()`，或在 `res.close` 时显式销毁读取流，并清理对应监听器。

**建议验收：** 重复取消下载后，测试文件对应的 FD 数量回到基线；正常下载和 HEAD 请求仍可完成。

**复核结论：** 已确认，复现结果与原记录一致（重复 5 次后泄漏 10 个 FD）。

**修复：** `static.ts`、`raw.ts` 改用 `pipeline(createReadStream(...), res, () => {})`：客户端提前断开时会销毁读取流，读取出错时会销毁响应。

**验证：** `shares.test.ts`“a download cancelled halfway closes the file it was reading”统计 `/proc/self/fd`，回到 0。原有的分享和原始文件下载测试仍通过。

## BUG-002

**一次发送失败，可能让“回退文件”选错检查点。**

**严重程度：高。状态：已复核并修复，纳入 v0.26.1。**

**位置：** [packages/web/src/store/session.ts:1241](../packages/web/src/store/session.ts#L1241)；关联同文件 `startTurn()` 的 `:1544` 和 `rewindFiles()` 的 `:946`。

**问题：** 本地回显使用合成 ID。`resolveUserUuid()` 根据本地回显数量与磁盘提示消息列表的末尾位置对齐，推算真实 UUID；但 `startTurn()` 在发送失败时保留本地消息，破坏了“所有本地回显都已落盘”的前提。

**触发场景：** 在同一页面先成功发送 A、B，再发送 C；C 的 HTTP 请求在到达服务端前失败。页面有 3 条本地回显，磁盘只有 A、B。此时对 B 执行回退，会映射成 **A 的 UUID**，恢复到更早的文件检查点，撤销超出用户选择范围的修改。复制 B 的链接也会指向 A。

**验证证据：** 导入真实 store 和 RPC client，以可控 fetch 复现上述时序，点击第二条消息得到第一条 UUID。文件回退使用同一映射。实际 SDK 0.3.312 的 `sdk.d.ts:3210` 定义参数为用户消息检查点 UUID；`sdk.mjs` 原样发送 `user_message_id`，不会纠正前端的错误映射。验证没有对真实工作区执行破坏性回退。

**修复建议：** 为每次发送建立稳定 UUID，并让 SDK 持久化同一 ID；至少应排除未被服务端接受的回显，停止通过消息数量推算检查点。

**建议验收：** 成功、失败、重试及跨标签页发送后，每条消息的链接和回退目标都准确对应其 UUID；未落盘消息不能错误映射为其他消息。

**复核结论：** 已确认，另外发现排队消息被 CLI 合并这一触发条件（见上方总结）。实测 CLI 2.1.316 会沿用 stream-json 客户端给的 `uuid`：transcript 条目和 `file-history-snapshot.messageId` 都用它，`rewindFiles(该 uuid)` 返回 `canRewind: true`。未知 uuid 返回 `{ canRewind: false, error: 'No file checkpoint found for this message.' }`，不会退回到别的检查点。

**修复：** `store/session.ts` 的 `echoPrompt()` 改用 `crypto.randomUUID()` 作为回显节点 id，`startTurn()` 把它作为 `uuid` 随 `session.send` 发出。`runner.ts` 的 `send()` 校验 UUID 格式后写进 `SDKUserMessage.uuid`。`rewindFiles()`、`messageLink()` 直接使用节点 id。删除了按位置对齐的 `resolveUserUuid()` 和只为它服务的 `listUserPromptUuids()`。

**验证：** `session.test.mjs`“rewind and links name the very message sent…”。端到端测试：发送 A、B 成功，C 发送失败后，对 B 做回退预览，请求的正是 B 的 uuid，CLI 的 dry-run 返回可回退。

## BUG-003

**更新安装失败后，重试可能跳过依赖安装并宣告成功。**

**严重程度：高。状态：已复核并修复，纳入 v0.26.1。**

**位置：** [packages/server/src/update/updater.ts:158](../packages/server/src/update/updater.ts#L158)、[packages/server/src/update/updater.ts:224](../packages/server/src/update/updater.ts#L224)。

**问题：** 是否需要安装依赖由 `ORIG_HEAD` 与 `HEAD` 的 lockfile/workspace 差异决定。首次 merge 成功但安装失败后，HEAD 已是新版本；重试再次 merge 同一 tag，会将 `ORIG_HEAD` 改成当前 HEAD，导致后续比较错误地认为无需安装。

**触发场景：** 新版本改动依赖，第一次 `pnpm install` 失败。点击重试时依赖安装被跳过。若只变更服务端依赖、现有前端依赖足够完成构建，或部署没有前端构建步骤，更新会显示成功并进入重启流程，新服务可能因缺失依赖而无法启动。若前端构建确实需要缺失的新依赖，构建可能再次失败，因此不是每次重试都会伪成功。

**验证证据：** 使用临时 origin、开发仓库和安装仓库运行真实 `Updater`。第一次安装失败；第二次即使安装命令仍必然失败，进度也只有 `merge → restartRequired`，并记录更新成功。首次失败没有回滚 HEAD；重新创建 updater 后，又会因 HEAD 已包含新 tag 而返回 `latest: null`，无法识别未完成的安装。

**修复建议：** 保存升级前 commit 和各阶段完成状态，重试失败阶段时强制补完依赖安装；失败恢复不能依赖被后续 merge 改写的 `ORIG_HEAD`，并应明确恢复旧版本或继续完成安装的策略。

**发布约束：** 根据 [releasing.md](./releasing.md)，执行本次更新的是用户机器上的旧 updater。新版本中的修复无法改变旧 updater 正在执行的这一次更新；发布修复时需要考虑旧版本的恢复路径。

**建议验收：** 注入一次安装失败，重试必须再次安装，未完成安装时不能报告成功；重启后也能识别并恢复未完成的更新。

**复核结论：** 已确认。根因是 `git merge` 在判断 “Already up to date” 之前就写了 `ORIG_HEAD`，所以重试时 merge 虽然是空操作，也会把 `ORIG_HEAD` 改成 HEAD。

**修复：** `updater.ts` 的 `#install()` 采用“继续完成安装”的策略，不回滚。merge 真正移动 HEAD 后，把升级前的 commit 写入 `<git-dir>/ccw-update-base`；安装成功后推进到 HEAD，全部步骤完成后删除。`dependenciesChanged(root, base)` 改为与这个 base 比较。`#fetch()` 发现 HEAD 已包含最新 tag 但记录仍在时，把未完成的更新以失败状态继续提供重试（用于重启后识别）。`UpdateDialog` 对这种状态显示“vX 的更新没有完成”。

**验证：** `update.test.ts` 中“a retry after a failed install runs the install again”和“a server started again before its install finished still offers to finish it”。

## BUG-004

**并发保存设置或渠道会互相覆盖，甚至写坏 JSON。**

**严重程度：中。状态：已复核并修复，纳入 v0.26.1。**

**位置：** [packages/server/src/settings/user-settings.ts:47](../packages/server/src/settings/user-settings.ts#L47)、[packages/server/src/settings/channels.ts:35](../packages/server/src/settings/channels.ts#L35)；临时文件分别位于 `:55` 和 `:41`。

**问题：** revision 检查与写入没有串行化，同一进程的请求还共用 `${path}.${process.pid}.tmp`。并发请求可以同时通过相同 revision 的检查，再竞争截断、写入和重命名同一个临时文件。

**触发场景：** 两个标签页或两台已配对设备读取同一份设置，然后接近同时点击保存。可能丢失修改、返回另一请求的内容、报 `ENOENT`，或留下无法解析的设置/渠道文件。

**验证证据：** 在临时配置目录并发调用真实保存函数。设置保存出现一方 `rename ENOENT`，另一方成功却读回对方内容；渠道保存留下完整 JSON 后额外残留一个 `}` 的文件，后续读取持续报解析错误。

**修复建议：** 按目标文件串行执行“重新核验 revision → 写入 → rename”，并使用唯一临时文件名；渠道联动设置的保存也应协调处理。

**建议验收：** 两个相同 revision 的并发保存不能互相污染；冲突有明确反馈，磁盘文件始终是完整有效的 JSON，成功响应与实际保存内容一致。

**复核结论：** 已确认。复现结果与原记录一致：设置保存一方报 `rename ENOENT`，渠道保存两方都失败。

**修复：** `user-settings.ts` 新增 `writeQueue()`。`writeUserSettings()` 把“核验 revision → 写 .bak → 写临时文件 → rename → 读回”整段放在队列里串行执行；`writeChannels()` 用自己的队列，内部再进入设置队列，加锁顺序固定为“渠道 → 设置”，不会互相等待。临时文件名的取舍见上方总结。

**验证：** `settings.test.ts`、`channels.test.ts` 中“two saves from one revision at once…”：一个成功，另一个以 revision 冲突被拒，磁盘内容是完整 JSON 且与成功响应一致。

## BUG-005

**文件保存期间继续输入，新输入会被保存完成回调清除。**

**严重程度：中。状态：已复核并修复，纳入 v0.26.1。**

**位置：** [packages/web/src/components/details/FileView.tsx:138](../packages/web/src/components/details/FileView.tsx#L138)；关联同文件的 `:130`、`:295`。

**问题：** 保存函数捕获点击保存时的 `draft`，等待写入及重新读取后无条件执行 `setDraft(null)`。保存期间编辑器仍允许输入，因为 `readOnly` 只取决于文件是否可编辑。

**触发场景：** 输入 A 后按 Ctrl+S，在保存请求返回前继续输入 B。服务端只保存 A；回调完成时清空当前草稿，编辑器回到 A，B 消失，未保存标志也消失。

**验证证据：** 转译并运行真实 `FileView.tsx`，使用可控 hooks 和延迟 RPC。保存期间输入 `first edit plus new typing`，保存完成后值变为 `first edit`，且 `dirty=false`；保存期间 `readOnly=false`。

**修复建议：** 保存时记录草稿版本，仅当当前草稿仍对应本次提交内容时清除；有后续编辑则更新磁盘基线并保留新草稿。

**建议验收：** 延迟保存响应，期间继续编辑；完成后新输入仍存在且保持未保存状态，再次保存能够正确落盘。

**复核结论：** 已确认。

**修复：** `drafts.ts` 新增纯函数 `afterSave(saved, current)`。`FileView.tsx` 用 `draftRef` 读取保存完成时的最新缓冲区：只有缓冲区仍等于本次写入的内容时才清除；否则保留为未保存，基线改为本次写入的文本，并同步到 `drafts`。接续复核还确认：保存期间改回旧磁盘内容时，`onChange` 不能把草稿置空，否则保存完成仍会覆盖这次编辑；现已保留该缓冲区，等待保存结果再判断是否干净。用户明确按 Esc 放弃草稿的行为保留。

**验证：** `drafts.test.mjs`。原会话端到端测试：`files.write` 人为延迟 2 秒，期间继续输入。完成后新输入仍在编辑器中并标记未保存，磁盘上只有保存时的内容，再次保存后正确落盘。接续新增 `file-view.test.mjs`，转译真实组件并控制 hooks/RPC 时序，覆盖继续输入、改回旧磁盘文本、没有后续编辑、明确放弃草稿 4 种情况；不替代真实浏览器验证。补充边界修复前已复现覆盖，修复后 4 项均通过。

## BUG-006

**同一会话在不同标签页中的权限模式可能与实际执行模式不一致。**

**严重程度：中。状态：已复核并修复，纳入 v0.26.1。**

**位置：** [packages/web/src/store/session.ts:1388](../packages/web/src/store/session.ts#L1388)；关联 [packages/server/src/session/runner.ts:395](../packages/server/src/session/runner.ts#L395) 和 [packages/server/src/rpc/routes.ts:108](../packages/server/src/rpc/routes.ts#L108)。

**问题：** 前端忽略 SDK `system/init` 和 `system/status` 中的 `permissionMode`。服务端修改共享 CLI 的模式后，也没有同步该值的广播，`session.state` 不返回当前权限模式。

**触发场景：** 两个标签页已打开同一会话，原本都是 `plan` 或 `default`。A 切换为 `bypassPermissions`，B 仍显示旧模式；B 随后发送消息，实际使用共享 CLI 已切换的模式。即使下一轮 init 携带新模式，B 的显示也不纠正，用户可能误以为操作仍受计划模式或审批限制。

**验证证据：** 安装版 SDK 的 `sdk.d.ts:6204` 定义 status 可携带权限模式，`:6221` 定义每轮开始的 init，`:6246` 定义其必含 `permissionMode`。向真实 store 注入携带 `bypassPermissions` 的 status 和 init 后，前端仍保持 `plan`。这是合法客户端之间的状态失配，不是未授权用户绕过认证。

**修复建议：** 消费 SDK 返回的权威权限模式，并在状态快照和模式变更事件中同步，使其他标签页及重连客户端保持一致。

**建议验收：** 两个标签页打开同一会话，任一标签切换模式后，另一标签及断线重连后的显示都与服务端一致。

**复核结论：** 已确认。实测切换模式后 CLI 会立即推送 `system/status`（带 `permissionMode`，空闲时也会），每轮的 `init` 也带模式。

**修复：** `runner.ts` 从 `init`/`status` 和 `setPermissionMode()` 跟踪当前模式，`session.state` 返回 `permissionMode`。`store/session.ts` 新增 `setReportedMode()` 消费这两类消息和快照，并给快照加了 `mode` 版本号，避免旧快照覆盖读取期间收到的新模式。附带效果：用户批准计划后 CLI 自己退出 plan 模式，界面也会跟着更新。

**验证：** `session.test.mjs` 的两条模式测试。端到端测试：两个标签页互相切换模式都能同步；从服务端改模式后，新开的标签页显示 runner 的模式，而不是浏览器 localStorage 里记住的模式。

## BUG-007

**终端收到合法 JSON `null` 会导致整个服务器退出。**

**严重程度：中。状态：已复核并修复，纳入 v0.26.1。**

**位置：** [packages/server/src/terminal/pty.ts:121](../packages/server/src/terminal/pty.ts#L121)；退出路径为 [packages/server/src/bin.ts:25](../packages/server/src/bin.ts#L25)。

**问题：** 消息处理只捕获 `JSON.parse()` 的语法错误，没有验证结果是否为非空对象。`null` 可以成功解析，随后访问 `message.type` 会抛出未捕获异常。

**触发场景：** 已认证的终端 WebSocket 客户端，在 PTY 运行期间发送文本帧 `null`。异常逃出 message 回调，触发 `uncaughtException` 处理中的 `process.exit(1)`，中断所有连接和会话。此问题需要已认证终端连接。

**验证证据：** 保留真实 `attachTerminal()` 与消息监听器，仅将 PTY 替换为无副作用 stub。发送 `Buffer.from('null')` 后复现 `Cannot read properties of null (reading 'type')`。没有使真实服务退出。

**修复建议：** 访问字段前验证消息对象、类型和各字段，并将 PTY 操作异常限制在该终端连接内处理。

**建议验收：** `null`、数组、错误字段类型等输入不会导致进程退出；正常输入、调整尺寸和 ack 仍能处理。

**复核结论：** 已确认。

**修复：** `pty.ts` 先判断解析结果是非空对象再读取字段；PTY 调用的异常只关闭当前终端连接（1011），不再逃逸出监听器。

**验证：** `shell.test.ts`“a terminal frame that parses but is no message…”使用真实 PTY：`null`、数组、数字、错误字段类型都不会抛出；之后 resize（`stty size` 输出 `33 101`）和 input 仍正常。

## BUG-008

**预览命名管道会阻塞，多个请求可能耗尽文件操作线程池。**

**严重程度：中。状态：已复核并修复，纳入 v0.26.1。**

**位置：** [packages/server/src/files/explorer.ts:60](../packages/server/src/files/explorer.ts#L60)、[packages/server/src/files/explorer.ts:79](../packages/server/src/files/explorer.ts#L79)；文件树入口位于 `:46`。

**问题：** 文件树将非目录条目作为文件返回。预览只读取 `stat().size`，不检查是否普通文件，随后使用阻塞语义的 `open(path, 'r')` 打开。

**触发场景：** 工作区存在没有写端的 FIFO，例如本地工具的 IPC 文件。用户点击预览后请求一直等待；在默认线程池配置下，4 个这样的打开操作可能占满 libuv 工作线程，使其他文件系统请求也等待。

**验证证据：** 在临时目录创建真实 FIFO，调用真实 `readFilePreview()` 保持 pending；打开写端后立即完成。未对真实服务进行线程池耗尽测试。

**修复建议：** 拒绝非普通文件，并采用非阻塞打开及打开后的 `fstat()` 校验，避免文件在检查和打开之间被替换。

**建议验收：** 没有写端的 FIFO 能快速返回明确错误，不影响其他文件读取；普通文本和图片预览正常。

**复核结论：** 已确认。

**修复：** `explorer.ts` 的 `readFilePreview()` 改为用 `O_RDONLY | O_NONBLOCK` 只打开一次，再在句柄上 `fstat`，非普通文件直接拒绝（“不是普通文件”）。目录也给出明确错误，不再是 `EISDIR`。

**验证：** 新增 `scripts/explorer.test.ts`（已加入 `pnpm test`）：没有写端的 FIFO 立即返回错误，不再一直 pending；文本和图片预览不受影响。

## BUG-009

**`!` 命令超时只终止 shell，实际前台任务可能继续运行。**

**严重程度：中。状态：已复核并修复，纳入 v0.26.1。**

**位置：** [packages/server/src/session/shell.ts:26](../packages/server/src/session/shell.ts#L26)。

**问题：** 超时处理只调用 `child.kill('SIGKILL')`，终止直接启动的 shell，没有终止其正在等待的前台子进程。随后输出管道被关闭，调用方已收到超时结果，但任务可能仍在运行。

**触发场景：** 使用 `!` 执行 `python long_job.py; echo done` 这类前台复合命令。超过 120 秒后页面显示超时，Python 进程仍可能继续计算、写文件或占用资源。

**验证证据：** 直接导入原有 `runShellCommand()`，仅在测试进程内把 120000ms 定时器加速到 100ms，执行 `sh -c 'echo $$ > /tmp/…/pid; exec sleep 30'; echo done`。命令完全没有 `&`；函数返回超时后，对 sleep PID 的存活检查仍成功。测试子进程随后已显式清理。

**修复建议：** 为每次命令创建独立进程组，超时终止整个进程组；其他平台使用相应的进程树终止方案，并等待退出后再报告完成。

**建议验收：** 前台复合命令、流水线和脚本形成的子进程在超时后都被终止；不能只检查直接 shell 的退出状态。

**复核结论：** 已确认。

**修复：** `shell.ts` 用 `detached: true` 让 shell 成为独立进程组的组长，超时时 `process.kill(-pid, 'SIGKILL')` 杀掉整组。正常结束时定时器已被清除，`cmd &` 后台任务的现有语义不变。超时时间改为可选参数，方便测试。

**验证：** `shell.test.ts`“a timeout kills what the shell is running…”：用原记录的前台复合命令，超时后 `sleep` 进程已不存在。原有的后台任务测试仍通过。

## BUG-010

**断线期间完成的回复，重连后不会恢复。**

**严重程度：中。状态：已复核并修复，纳入 v0.26.1。**

**位置：** [packages/web/src/store/session.ts:1627](../packages/web/src/store/session.ts#L1627)，回放逻辑位于 `:1292`；关联 [packages/server/src/session/runner.ts:245](../packages/server/src/session/runner.ts#L245)。

**问题：** 重连只刷新项目列表，再读取 `session.state` 并回放 backlog，没有补读持久化历史。服务端收到 `result` 时立即清空 backlog，因此已结束但浏览器没收到的消息没有恢复来源。

**触发场景：** 会话生成过程中浏览器断线，离线期间服务器完成回复并发出 result。网络恢复后状态会变回 idle，但遗漏的助手回复和工具结果仍缺失；切回这个已经打开的会话也不会重新加载历史，通常需要刷新页面。

**验证证据：** 用真实 store 模拟磁盘已有离线完成的回复、服务器返回 `live: true / status: idle / backlog: []`。重连后没有调用 `history.messages`，回复节点仍缺失，状态已变为 idle。

**修复建议：** 重连时补读最后确认位置之后的持久化历史，再按 UUID 合并 backlog 与实时消息，处理去重和请求期间的新事件。

**建议验收：** 断线期间回合完成、跨多个回合、服务器重启等情况下，重连后消息和状态都能恢复，不重复或覆盖较新的事件。

**复核结论：** 已确认。

**修复：** `store/session.ts` 重连时改走 `resyncSession()`。先用 `missedSaved()` 读最新一小页，检查最新的非 system 条目是否已在页面上（看 `seen` 或用户气泡 id，后者依赖 BUG-002 的稳定 uuid）。有缺口时才像刷新页面那样重读最新窗口，再 `adoptRunner()` 把 backlog 重放在上面。没有选择按 UUID 增量合并：分页起点会回退到安全切点，与已有内容重叠；`appendTranscript` 不去重；补读起点还可能落在 tool_use 和 tool_result 之间。取舍是：确有缺口时，本地通知和已向上翻出的历史页会被重置。

**验证：** `session.test.mjs` 的两条重连测试，其中一条确认没有缺口时不重读、保留本地通知。端到端测试：用 `routeWebSocket` 切断事件流，期间回合完成；恢复后回复出现，状态回到空闲，提示气泡没有重复。

## BUG-011

**权限或问答提交失败后卡片消失，但服务端继续等待。**

**严重程度：中。状态：已复核并修复，纳入 v0.26.1。**

**位置：** [packages/web/src/store/session.ts:926](../packages/web/src/store/session.ts#L926)、[packages/web/src/components/chat/PermissionCard.tsx:35](../packages/web/src/components/chat/PermissionCard.tsx#L35)。

**问题：** `respondToPermission()` 在 RPC 成功之前就移除卡片并记录为已解决，请求失败时不恢复；调用组件也没有处理该 rejection。

**触发场景：** Claude 正等待工具权限或 `AskUserQuestion` 答案。用户点击允许或提交，HTTP 请求被临时代理错误或连接重置等阻止，但事件 WebSocket 仍保持连接。卡片消失，服务端权限 Promise 却继续 pending，没有后续事件自动恢复卡片，用户无法在当前界面重试。

**验证证据：** 真实 store 收到权限请求后，让 `permission.respond` 请求失败，待处理卡片从 1 变为 0。服务端 `PermissionBroker` 只有收到答复或 abort 才结束等待，没有独立重发机制。

**修复建议：** 提交期间禁用重复点击，成功或收到 `permission_resolved` 后再移除；失败时保留卡片并提供错误和重试入口。

**建议验收：** 保持 WebSocket 正常，单独使权限答复 HTTP 请求失败；卡片必须保留或恢复，且可重试，也要正确处理答复实际已送达但响应丢失的情况。

**复核结论：** 已确认。服务端对重复或过期的答复本来就静默接受，所以“已送达但响应丢失后重试”是安全的。

**修复：** `respondToPermission()` 改为 RPC 成功后再移除卡片。`PermissionCard.tsx` 新增 `useAnswer()`（`QuestionCard` 共用）：提交期间禁用按钮，失败时显示“回复没有送达，请重试：…”并恢复按钮。

**验证：** `session.test.mjs`“a permission answer that fails to send leaves the card up…”。端到端测试：第一次答复请求被中断，卡片保留且按钮可用，文件没有被写；再点允许后工具执行，另一个标签页的卡片也随之消失。

## BUG-012

**任何一次更新失败后，该服务进程不再发现后续修复版本。**

**严重程度：中。状态：已复核并修复，纳入 v0.26.1。**

**位置：** [packages/server/src/update/updater.ts:120](../packages/server/src/update/updater.ts#L120)、[packages/server/src/update/updater.ts:180](../packages/server/src/update/updater.ts#L180)。

**问题：** `#installing()` 只检查 `progress !== null`，将 `failed` 也当作安装中。失败后没有清空 progress 的路径，手动和定时检查都会直接返回，不执行 fetch；重试仍锁定原来的失败版本。

**触发场景：** 一次更新失败后，远端发布了修复版本。关闭弹窗、刷新浏览器或点击检查更新，都无法在当前服务进程中发现新版本。重启服务会解除这一状态，因此影响范围是该服务进程存续期间。

**验证证据：** 临时 origin 发布 `0.3.0` 后，对更新 `0.2.0` 失败的真实 updater 调用 `check()`，`latest` 仍为 `0.2.0`。

**修复建议：** 只在真正运行或重启中的状态阻止检查；失败状态允许发现较新版本，并明确管理重试目标。

**与 BUG-003 的区别：** BUG-003 是重试漏装依赖，可能导致部署无法启动；本项是失败状态封锁版本发现，阻碍获得后续补丁，修复点不同。同样需要遵守旧 updater 执行更新的发布约束。

**建议验收：** merge、安装、构建任一阶段失败后，远端新增 tag，当前服务进程仍能检查并展示新版本。

**复核结论：** 已确认。只改 `#installing()` 不够：放开检查后，失败状态下的定时检查会因为 HEAD 已包含该 tag 而把 `latest` 置空，连重试入口一起丢掉，所以和 BUG-003 一起修。

**修复：** `#installing()` 不再把 `failed` 算作安装中。`#fetch()` 对同一目标保留失败状态（以及重试入口），出现更新的版本时重置为可直接更新。新的更新仍以持久化的 base 判断依赖，即 node_modules 实际安装时的 commit。

**验证：** `update.test.ts`“a failed update keeps its retry, and a newer release still shows up”。

## BUG-013

**单文件暂存会把文件名中的通配字符解释为 Git 路径表达式。**

**严重程度：中。状态：已复核并修复，纳入 v0.26.1。**

**位置：** [packages/server/src/scm/repo.ts:213](../packages/server/src/scm/repo.ts#L213)。

**问题：** `git add -A -- ...paths` 中的 `--` 只结束选项解析，不会关闭 Git pathspec 匹配。来自文件列表的路径需要按字面文件名处理。

**触发场景：** 在允许此类文件名的文件系统中，仓库同时存在修改过的 `notes*.txt` 和 `notes-other.txt`。用户只暂存字面文件名 `notes*.txt`，实际会把匹配的其他文件也暂存，后续提交可能包含未选中的修改。

**验证证据：** 在临时仓库调用真实 `scmStage(root, ['notes*.txt'])`，暂存区同时出现两个文件。本次确认的是暂存路径，没有将其他 Git 操作未经验证地归为同样后果。

**修复建议：** 对来自文件列表的路径启用 Git literal pathspec 处理，例如 `--literal-pathspecs` 或逐项使用 `:(literal)`。

**建议验收：** 文件名含 `*`、`?`、`[]` 等字符时，单文件暂存只影响选中文件，普通路径仍正常。

**复核结论：** 暂存问题已确认，范围更正见上方总结。

**修复：** `git.ts` 新增 `literal()`。`repo.ts` 的暂存、取消暂存、`ls-files`、放弃更改、两种 diff，以及 `git.ts` 的 `scmDiff`、`scmDiscard`，所有来自文件列表的 pathspec 都加上 `:(literal)`。`--no-index` 的路径不是 pathspec，保持不变。

**验证：** `scm-repo.test.ts`、`scm.test.ts` 的通配符文件名测试，覆盖 `notes*.txt`、`[ab].txt`、`[fo]ile.txt`。

## BUG-014

**持续活跃的设备可能在服务重启后被误判过期。**

**严重程度：低。状态：已复核并修复，纳入 v0.26.1。**

**位置：** [packages/server/src/auth/devices.ts:58](../packages/server/src/auth/devices.ts#L58)。

**问题：** 是否落盘通过距上次请求是否超过一小时判断，但 `lastSeenAt` 每次请求都会更新。请求间隔持续小于一小时且 IP 不变时，活跃时间可能始终不写磁盘；比较的是上次请求时间，而不是上次持久化时间。

**触发场景：** 设备持续使用超过 30 天，每次请求间隔小于一小时，期间没有设备增删等额外写入。内存认证一直成功，但服务重启后读到旧时间，将仍活跃的设备判定过期，要求重新配对。

**验证证据：** 真实 `DeviceStore` 每 30 分钟模拟一次认证，持续超过 `DEVICE_IDLE_MS`。重启前认证一直成功，磁盘时间仍为初始值；重新打开 store 后，同一 token 认证失败。

**修复建议：** 单独维护最后持久化时间，或使用有最大延迟的定时落盘，避免用不断更新的上次请求时间作为节流基准。

**建议验收：** 持续高频请求期间活跃时间仍定期落盘，重启后活跃设备有效；真正超过 30 天未使用的设备仍应失效。

**复核结论：** 已确认。

**修复：** `devices.ts` 增加 `#savedSeenAt`，记录每台设备在文件中的 `lastSeenAt`；落盘节流改为与它比较，而不是与上次请求时间比较。

**验证：** `auth.test.ts`“a device in steady use stays paired across a restart”：每 30 分钟认证一次，重启后在“从配对算已超 30 天、从最后一次使用算未超”的时间点仍能认证。原有的“真正闲置的设备过期”测试仍通过。

## PENDING-001

**SDK `conversation_reset` 未被处理，清空会话后可能发生会话身份与历史失配。**

**严重程度：中。状态：复核后已确认并修复，纳入 v0.26.1；初次审查时列为待确认项。**

**位置：** [packages/server/src/session/runner.ts:92](../packages/server/src/session/runner.ts#L92)、同文件 `:214`；[packages/web/src/render/nodes.ts:317](../packages/web/src/render/nodes.ts#L317)，以及 store 中 SDK 消息的处理分支。

**已确认的代码事实：**

- SDK 0.3.312 的 `sdk.d.ts:5378` 定义 `SDKConversationResetMessage`，要求消费者挂载 `new_conversation_id` 并重置缓存标题。
- `sdk.mjs` 会将该事件转发给消费者；安装的 bundled CLI 2.1.312 中存在支持非交互 `/clear` 的实现，别名包括 `/reset`、`/new`，并存在 reset 事件发射分支。
- 前端没有拦截这些清空命令，也没有消费 reset 消息；服务端 `SessionRunner.sessionId` 在构造时固定，后续消息继续按该 ID 包装。

**潜在触发与结果：** 如果实际运行的 CLI 在 `/clear`、其别名或清空上下文退出计划模式时发出该事件，后续消息可能仍归入旧会话，导致标题、历史缓存及重新打开会话时的数据失配。

**还缺什么信息：** 实际启动的 CLI 版本及一次真实 `/clear` 的完整事件记录。`resolveClaudeExecutable()` 会优先使用 `CCW_CLAUDE_PATH` 或 PATH 中的 CLI，不一定运行 bundled CLI。两次隔离验证均在 initialize 阶段超时，没有取得端到端事件，不能宣称此路径已复现；测试 Query 均已关闭。

**建议确认步骤：** 在可控测试会话中记录执行清空命令前后的 session ID、reset 帧、后续消息 ID 和落盘 transcript 路径，再验证刷新及重新打开读取的是哪份会话。记录实际 CLI 路径与版本，避免仅按安装 SDK 的 bundled 版本推断。

**修复方向：** 确认实际事件后，统一迁移服务端和前端的会话身份及缓存，或将清空命令转换为受控的新会话创建流程。

**复核结论：** 已确认，严重程度中。用实际运行的 CLI 2.1.316（PATH 中的 `claude`）和隔离配置做了端到端记录：执行 `/clear` 后发出顶层 `conversation_reset`（`trigger: 'clear'`），之后各帧的 `session_id` 换成新 id，`/clear` 本身和后续消息都写进新 transcript 文件，旧文件停在清空之前。另外，`new_conversation_id` 不是新会话 id（见上方总结）。

**修复：** `runner.ts` 收到 reset 帧后只记一个标记；等到第一条 `session_id` 不同的帧，再迁移到那个 id（`#reset()`）：清空 backlog，重置标题和摘要，此后的标题读取和生成按新 id 进行，并发出新事件 `session_reset`。`manager.ts` 收到该事件后按新 id 重新登记 runner。`store/session.ts` 的 `resetSession()` 在新 id 下建立空 transcript 的会话，沿用同一进程的设置和当前回合，旧会话标为已关闭；如果它是当前会话，就切换过去，地址栏随之跳到新 id。没收到 reset 帧时行为不变。

**验证：** 用真实 `SessionManager`/`SessionRunner`/CLI 验证：reset 后 `manager.has(旧)` 为 false、`has(新)` 为 true；之后的帧（包括 init）都带新 id；新旧 transcript 的内容各自正确；关闭时 `session_closed` 用新 id。`session.test.mjs`“a cleared conversation goes on under its new id…”。端到端测试：`/clear` 后页面迁移到新 id 且 transcript 为空，刷新后读新 transcript，后退能回到旧对话。

## 初次审查的验证范围与未纳入的问题

以下保留初次只读审查的验证范围；修复后的结果见上方总结和 [verification.md](../verification.md)。初次审查已执行的基础验证：

- server、web、shared 三包的 `tsc --noEmit` 均通过。
- 更新机制现有 12 项测试通过。
- 选取的 4 个前端测试文件通过：`session.test.mjs`、`drafts.test.mjs`、`questions.test.mjs`、`permission-mode.test.mjs`。
- 上述确认问题通过临时 Git 仓库、临时配置与文件、真实生产函数或可控事件/RPC/组件时序进行隔离复现。现有测试通过不代表这些异常路径已经被覆盖。

SDK 核查覆盖 query 创建与 resume 参数、流式输入与消息类型、权限回调与中断信号、interrupt 返回值、模型/模式/flag 控制、命令与模型列表、上下文与回退、任务与 MCP 控制、运行时扩展方法，以及历史列表、消息读取、重命名、fork 和设置解析。依据均为安装版类型定义及实现，没有确认直接的 SDK 方法签名或返回值误用。

以下判断没有列为确认问题：

- **未配对认证绕过：** 本轮未确认可报告的绕过。已配对用户按项目文档拥有 shell 能力，不能仅因其能访问广泛路径就判定越权。
- **runner 的 finally 未显式 close：** 安装版 SDK 的消息迭代和异常路径内部会执行 cleanup，不能仅凭缺少显式调用认定子进程泄漏。
- **旧 runner 尾帧污染新实例：** 没有取得足够可靠的触发证据，未纳入问题清单。

初次审查没有执行完整生产端到端验证，也没有进行真实文件回退、公开服务攻击或真实模型调用。后续修复已按各条目补充回归验证；正式发布仍须按项目发布约定执行必要的完整测试。
