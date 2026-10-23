# AGENTS.md

写给在这个仓库里工作的 AI 代理（Claude Code、Codex、Cursor 等）。项目介绍、运行和部署方式见 [README.md](README.md)。

## 发布新版本

已部署的 server 会把 `origin` 上的 `vX.Y.Z` tag 当作新版本，提示用户一键更新。推送这样一个 tag 就是对外发布。完整步骤和每条规则的原因见 [docs/releasing.md](docs/releasing.md)，以下几条必须遵守：

- 只有用户明确要求发版时才打 tag 并推送，事先告诉用户版本号和要发布的提交。普通改动不要顺手打 tag。
- 版本号只改根目录 `package.json` 的 `version`。单独提交，标题为 `chore: release X.Y.Z`。tag 用附注 tag，名字是 `v` 加同一个版本号：`git tag -a vX.Y.Z -m vX.Y.Z`，然后执行 `git push origin master vX.Y.Z`。
- 版本号只能递增。`-beta` 之类的预发布 tag 不会提示更新。
- 已推送的 tag 不能移动、删除或重新指向；master 不能 force push，也不能 rebase 已推送的提交。发布有问题，就修好后发下一个补丁版本。
- 发布前 `pnpm test` 和 `pnpm typecheck` 必须通过，工作区必须干净。
- 提交标题会原样显示在用户的更新弹窗里，写成用户看得懂的 `feat(scope): …` / `fix(scope): …`。
- 改动 `packages/server/src/update/` 时要记住：执行更新的是用户机器上正在运行的旧版本代码，新逻辑从下一次更新才开始生效。
