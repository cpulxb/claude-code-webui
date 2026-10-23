# 发布新版本

部署好的 server 启动时、之后每小时、以及用户点侧栏「检查更新」时，会对 `origin` 执行 `git fetch`，找出当前代码还不包含的 `vX.Y.Z` tag，提示用户更新。用户点「立即更新」后，server 执行 `git merge --ff-only` 合并到这个 tag，再按需安装依赖、构建前端、重启。

所以**发布新版本 = 往 master 推一个 `vX.Y.Z` tag**。只推提交、不打 tag，不会提示任何人更新。

## 步骤

```bash
# 1. 在 master 上，工作区干净，和 origin 同步
git switch master
git pull --ff-only
git status --short          # 应为空

# 2. 发布前检查
pnpm test
pnpm typecheck

# 3. 改根目录 package.json 的 version，例如 0.1.2 → 0.1.3，然后单独提交
git add package.json
git commit -m "chore: release 0.1.3"

# 4. 打附注 tag，和提交一起推送
git tag -a v0.1.3 -m v0.1.3
git push origin master v0.1.3
```

推送后，已部署的机器最迟一小时内会提示更新；点「检查更新」可以立即看到。

## 规则

### 版本号

- 版本号只有一个来源：根目录 `package.json` 的 `version`。侧栏显示的版本、更新后页面是否刷新，都读这个字段。`packages/*/package.json` 里的版本号不用改。
- tag 名必须是 `v` 加同一个版本号，例如 `version` 是 `0.1.3`，tag 就是 `v0.1.3`。
- 只有 `vX.Y.Z` 形式的 tag 会提示更新。`v0.2.0-beta.1` 这类预发布 tag 会被忽略，可以用来做不对外的测试。
- 版本号只能递增。server 按版本号排序取最新的 tag，比已发布版本小的 tag 永远不会提示。
- 修 bug 加最后一位（`0.1.2` → `0.1.3`）；新功能或行为变化加中间一位，最后一位归零（`0.1.3` → `0.2.0`）。

### tag 和历史

- 用附注 tag（`git tag -a`），打在已经推到 master 的版本号提交上。不要在其他分支上打 tag。
- **已推送的 tag 不能移动、删除或重新指向。** 已经装上这个版本的机器会再次收到同一个版本号的更新提示；tag 改指到分叉的提交时，`--ff-only` 合并还会失败。发布出了问题，修好后发下一个补丁版本。例如 v0.1.1 更新时构建失败，就是修复后用 v0.1.2 解决的。
- **master 不能改写历史**：不要 force push，也不要 rebase 已推送的提交。用户的机器只能快进合并，历史一改，它们就再也更新不了了。

### 提交信息

- 更新弹窗里的「更新内容」，就是上一个版本到这个 tag 之间所有提交的标题（不含 merge 提交），会原样展示给用户。提交标题沿用 `feat(scope): …` / `fix(scope): …` 的格式，写清楚改了什么。
- 版本号单独一个提交，标题固定为 `chore: release X.Y.Z`。

### 依赖

- 这个版本改动了 `pnpm-lock.yaml` 或 `pnpm-workspace.yaml` 时，用户更新会多执行一步 `pnpm install --frozen-lockfile`；没改动就跳过。只改版本号的发布不会触发安装。
- 改了依赖的话，发布前确认 `pnpm-lock.yaml` 已经提交，并且 `pnpm install --frozen-lockfile` 在本地能通过。

### 改动更新流程本身

用户机器上执行这次更新的，是**它正在运行的旧版本**里的更新代码，不是这次发布的代码。所以：

- 改动 `packages/server/src/update/` 后，新的更新逻辑要等用户装上这个版本之后，从**下一次**更新才开始生效。
- 如果旧的更新逻辑装不上这个版本，已部署的机器要先手动同步一次：`git pull --ff-only`，必要时重新构建前端，然后重启 server。
