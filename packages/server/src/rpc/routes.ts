import { stat } from 'node:fs/promises'

import type { RpcMethod, RpcParams, RpcResult } from '@ccw/shared'

import { browseDirectory } from '../files/browse.ts'
import { listEntries, readFilePreview, writeTextFile } from '../files/explorer.ts'
import { registerRoot, resolveInWorkspace } from '../files/roots.ts'
import { suggestFiles } from '../files/suggest.ts'
import {
  forkSavedSession,
  hasTranscript,
  listProjects,
  listSubagentMeta,
  locateSession,
  readMessagePage,
  readMessages,
  readPermissionMode,
  readSubagentMessages,
  readWorkflowRun,
  renameSavedSession,
} from '../history/sessions.ts'
import { scmDiff, scmDiscard, scmStatus, shadowBaseline } from '../scm/git.ts'
import type { SessionManager } from '../session/manager.ts'
import { fetchUpstreamModels } from '../settings/upstream-models.ts'
import { readUserSettings, writeUserSettings } from '../settings/user-settings.ts'
import type { Updater } from '../update/updater.ts'

export type RpcHandlers = {
  [M in RpcMethod]: (params: RpcParams<M>) => Promise<RpcResult<M>>
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory(), () => false)
}

export function createRpcHandlers(manager: SessionManager, updater: Updater): RpcHandlers {
  return {
    'session.create': async (config) => {
      // Checked before the CLI starts: a missing directory makes its spawn fail
      // with ENOENT, and the SDK reports that as a missing native binary.
      if (!(await isDirectory(config.cwd))) throw new Error(`工作目录不存在：${config.cwd}`)
      // The picked cwd becomes a legitimate root for the file RPCs. Trusted:
      // the user chose this directory, even if it is `~` itself.
      registerRoot(config.cwd, { trusted: true })
      // A session opened and never sent to has no JSONL, so `--resume` exits
      // with "No conversation found" — e.g. reopened after a server restart.
      // Starting it fresh under the same id is what it still is.
      let effective = config
      if (config.resume && !(await hasTranscript(config.resume))) {
        const { resume, ...fresh } = config
        effective = { ...fresh, sessionId: resume }
      }
      const runner = manager.create(effective)
      return { sessionId: runner.sessionId }
    },

    'session.close': async ({ sessionId }) => {
      manager.close(sessionId)
      return {}
    },

    'session.send': async ({ sessionId, text, attachments }) => {
      await manager.require(sessionId).send(text, attachments)
      return {}
    },

    'session.interrupt': async ({ sessionId }) => {
      await manager.require(sessionId).interrupt()
      return {}
    },

    // Unknown ids are the normal case here, not a client bug: the browser asks
    // about every session it opens, and most have no runner behind them.
    'session.state': async ({ sessionId }) => {
      if (!manager.has(sessionId)) return { live: false, status: 'idle', pendingPermissions: [], backlog: [] }
      const runner = manager.require(sessionId)
      return {
        live: true,
        status: runner.status,
        pendingPermissions: runner.pendingPermissions,
        backlog: runner.backlog,
      }
    },

    'session.setPermissionMode': async ({ sessionId, mode }) => {
      await manager.require(sessionId).setPermissionMode(mode)
      return {}
    },

    'session.setModel': async ({ sessionId, model }) => {
      await manager.require(sessionId).setModel(model)
      return {}
    },

    'session.setEffort': async ({ sessionId, effort }) => {
      await manager.require(sessionId).setEffort(effort)
      return {}
    },

    'session.setUltracode': async ({ sessionId, on }) => manager.require(sessionId).setUltracode(on),

    'session.flags': async ({ sessionId }) => manager.require(sessionId).flags(),

    'session.commands': async ({ sessionId }) => ({
      commands: await manager.require(sessionId).commands(),
    }),

    'session.models': async ({ sessionId }) => manager.require(sessionId).models(),

    'session.contextUsage': async ({ sessionId }) => ({
      usage: await manager.require(sessionId).contextUsage(),
    }),

    'session.rewindFiles': async ({ sessionId, userMessageId, dryRun }) => ({
      rewind: await manager.require(sessionId).rewindFiles(userMessageId, dryRun ?? false),
    }),

    'session.stopTask': async ({ sessionId, taskId }) => {
      await manager.require(sessionId).stopTask(taskId)
      return {}
    },

    'session.backgroundTask': async ({ sessionId, toolUseId }) => ({
      backgrounded: await manager.require(sessionId).backgroundTask(toolUseId),
    }),

    'session.shell': async ({ sessionId, command }) => manager.require(sessionId).shell(command),

    'session.mcpStatus': async ({ sessionId }) => ({ servers: await manager.require(sessionId).mcpStatus() }),

    'session.mcpToggle': async ({ sessionId, name, enabled }) => ({
      servers: await manager.require(sessionId).toggleMcp(name, enabled),
    }),

    'session.mcpReconnect': async ({ sessionId, name }) => ({
      servers: await manager.require(sessionId).reconnectMcp(name),
    }),

    'session.skills': async ({ sessionId }) => ({ skills: await manager.require(sessionId).skills() }),

    'session.setSkillState': async ({ sessionId, name, state }) => ({
      skills: await manager.require(sessionId).setSkillState(name, state),
    }),

    'session.plugins': async ({ sessionId }) => ({ plugins: await manager.require(sessionId).plugins() }),

    'session.pluginAction': async ({ sessionId, id, scope, action }) =>
      manager.require(sessionId).pluginAction(id, scope, action),

    'session.account': async ({ sessionId }) => ({ account: await manager.require(sessionId).account() }),

    'session.rename': async ({ sessionId, title, cwd }) => {
      await renameSavedSession(sessionId, title, cwd)
      return {}
    },

    'session.fork': async ({ sessionId, cwd, title }) => ({ sessionId: await forkSavedSession(sessionId, cwd, title) }),

    'permission.respond': async ({ sessionId, requestId, decision }) => {
      // A stale click after the request was aborted is not an error.
      manager.require(sessionId).respondToPermission(requestId, decision)
      return {}
    },

    'history.projects': async () => ({
      projects: await listProjects(manager.liveSummaries()),
    }),

    'history.messages': async ({ sessionId, cwd, limit, before, after, around }) => {
      // A running turn's figures come with its live `result`.
      const running = manager.has(sessionId) && manager.require(sessionId).status === 'running'
      const [page, permissionMode] = await Promise.all([
        limit === undefined
          ? readMessages(sessionId, cwd).then((messages) => ({ messages, hasMore: false, hasNewer: false }))
          : readMessagePage(sessionId, cwd, limit, { before, after, around }, running),
        // Pages next to one shown only add to it; the one opened at set the mode.
        before === undefined && after === undefined ? readPermissionMode(sessionId) : null,
      ])
      return { ...page, ...(permissionMode ? { permissionMode } : {}) }
    },

    // A runner writes no transcript before its first message, so only the
    // manager knows where a fresh one runs.
    'history.locate': async ({ sessionId }) => ({
      cwd: manager.has(sessionId) ? manager.require(sessionId).config.cwd : await locateSession(sessionId),
    }),

    'history.subagents': async ({ sessionId }) => ({ agents: await listSubagentMeta(sessionId) }),

    'history.workflow': async ({ sessionId, runId }) => ({ run: await readWorkflowRun(sessionId, runId) }),

    'history.subagent': async ({ sessionId, agentId }) => ({
      messages: await readSubagentMessages(sessionId, agentId),
    }),

    'files.suggest': async ({ cwd, query }) => ({
      suggestions: await suggestFiles(await resolveInWorkspace(cwd), query),
    }),

    'files.browse': async ({ path, showHidden }) => browseDirectory(path, showHidden ?? false),

    'files.list': async ({ path }) => ({ entries: await listEntries(await resolveInWorkspace(path)) }),

    'files.read': async ({ path }) => ({ preview: await readFilePreview(await resolveInWorkspace(path)) }),

    'files.write': async ({ path, content }) => ({
      bytesWritten: await writeTextFile(await resolveInWorkspace(path), content),
    }),

    'scm.status': async ({ cwd }) => ({ status: await scmStatus(await resolveInWorkspace(cwd)) }),

    'scm.diff': async ({ cwd, path }) => scmDiff(await resolveInWorkspace(cwd), path),

    // `scm.discard` runs `git restore` and deletes untracked files, so an
    // unchecked cwd here is a destructive arbitrary-directory write, not just a
    // read.
    'scm.discard': async ({ cwd, path }) => {
      await scmDiscard(await resolveInWorkspace(cwd), path)
      return {}
    },

    'scm.shadowBaseline': async ({ cwd }) => {
      await shadowBaseline(await resolveInWorkspace(cwd))
      return {}
    },

    'update.status': async () => updater.status,

    'update.check': async () => {
      await updater.check()
      return updater.status
    },

    'update.apply': async () => updater.apply(),

    // `cwd` only says whose project settings to check for overrides; one
    // outside the workspaces is ignored rather than read.
    'settings.read': async ({ cwd }) => readUserSettings(await workspaceOrNothing(cwd)),

    'settings.write': async ({ settings, revision, cwd }) =>
      writeUserSettings(settings, revision, await workspaceOrNothing(cwd)),

    'settings.fetchModels': async (channel) => ({ models: await fetchUpstreamModels(channel) }),
  }
}

function workspaceOrNothing(cwd: string | undefined): Promise<string | undefined> {
  return cwd ? resolveInWorkspace(cwd).catch(() => undefined) : Promise.resolve(undefined)
}
