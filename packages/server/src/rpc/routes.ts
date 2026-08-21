import type { RpcMethod, RpcParams, RpcResult } from '@ccw/shared'

import { browseDirectory } from '../files/browse.ts'
import { suggestFiles } from '../files/suggest.ts'
import { listProjects, readMessages } from '../history/sessions.ts'
import type { SessionManager } from '../session/manager.ts'

export type RpcHandlers = {
  [M in RpcMethod]: (params: RpcParams<M>) => Promise<RpcResult<M>>
}

export function createRpcHandlers(manager: SessionManager): RpcHandlers {
  return {
    'session.create': async (config) => {
      const runner = manager.create(config)
      return { sessionId: runner.sessionId }
    },

    'session.close': async ({ sessionId }) => {
      manager.close(sessionId)
      return {}
    },

    'session.send': async ({ sessionId, text, attachments }) => {
      manager.require(sessionId).send(text, attachments)
      return {}
    },

    'session.interrupt': async ({ sessionId }) => {
      await manager.require(sessionId).interrupt()
      return {}
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

    'session.commands': async ({ sessionId }) => ({
      commands: await manager.require(sessionId).commands(),
    }),

    'session.models': async ({ sessionId }) => ({
      models: await manager.require(sessionId).models(),
    }),

    'session.contextUsage': async ({ sessionId }) => ({
      usage: await manager.require(sessionId).contextUsage(),
    }),

    'permission.respond': async ({ sessionId, requestId, decision }) => {
      // A stale click after the request was aborted is not an error.
      manager.require(sessionId).respondToPermission(requestId, decision)
      return {}
    },

    'history.projects': async () => ({
      projects: await listProjects(new Set(manager.liveIds())),
    }),

    'history.messages': async ({ sessionId, cwd }) => ({
      messages: await readMessages(sessionId, cwd),
    }),

    'files.suggest': async ({ sessionId, query }) => ({
      suggestions: await suggestFiles(manager.require(sessionId).config.cwd, query),
    }),

    'files.browse': async ({ path, showHidden }) => browseDirectory(path, showHidden ?? false),
  }
}
