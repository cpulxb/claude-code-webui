import type { RpcMethod, RpcParams, RpcResult } from '@ccw/shared'

import { browseDirectory } from '../files/browse.ts'
import { listEntries, readFilePreview, writeTextFile } from '../files/explorer.ts'
import { registerRoot, resolveInWorkspace } from '../files/roots.ts'
import { suggestFiles } from '../files/suggest.ts'
import { listProjects, listSubagentMeta, readMessages, readPermissionMode, readSubagentMessages, readWorkflowRun } from '../history/sessions.ts'
import { scmDiff, scmDiscard, scmStatus, shadowBaseline } from '../scm/git.ts'
import type { SessionManager } from '../session/manager.ts'

export type RpcHandlers = {
  [M in RpcMethod]: (params: RpcParams<M>) => Promise<RpcResult<M>>
}

export function createRpcHandlers(manager: SessionManager): RpcHandlers {
  return {
    'session.create': async (config) => {
      // The picked cwd becomes a legitimate root for the file RPCs. Trusted:
      // the user chose this directory, even if it is `~` itself.
      registerRoot(config.cwd, { trusted: true })
      const runner = manager.create(config)
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

    'permission.respond': async ({ sessionId, requestId, decision }) => {
      // A stale click after the request was aborted is not an error.
      manager.require(sessionId).respondToPermission(requestId, decision)
      return {}
    },

    'history.projects': async () => ({
      projects: await listProjects(manager.liveSummaries()),
    }),

    'history.messages': async ({ sessionId, cwd }) => {
      const [messages, permissionMode] = await Promise.all([
        readMessages(sessionId, cwd),
        readPermissionMode(sessionId),
      ])
      return { messages, ...(permissionMode ? { permissionMode } : {}) }
    },

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
  }
}
