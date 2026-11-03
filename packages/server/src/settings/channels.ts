import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

import type { Channel, ChannelLibrary, UserSettings } from '@ccw/shared'

import { configDir } from '../auth/pairing.ts'
import { hash, readIfExists, validate as validateSettings, writePrivate, writeUserSettings } from './user-settings.ts'

const FILE = 'channels.json'
const MAX_CHANNELS = 100
const ID = /^[\w-]{1,64}$/

/** The saved channels; an empty list while the file does not exist. */
export async function readChannels(): Promise<ChannelLibrary> {
  const path = join(configDir(), FILE)
  const raw = (await readIfExists(path)) ?? ''
  return { ...parse(raw, path), revision: hash(raw) }
}

/**
 * Replaces the channel list, unless it changed after `revision` was read —
 * another tab saving its own. With `settings`, settings.json is written
 * first, through its own revision check, so a refusal there leaves both files
 * as they were. The file holds API keys, so it is private to the user.
 */
export async function writeChannels(
  channels: unknown,
  activeId: unknown,
  revision: string,
  settings?: { settings: unknown; revision: string; cwd?: string },
): Promise<{ library: ChannelLibrary; settings: UserSettings | null }> {
  validate(channels, activeId)
  const dir = configDir()
  const path = join(dir, FILE)
  if (hash((await readIfExists(path)) ?? '') !== revision) {
    throw new Error('渠道列表在打开设置之后被改过（可能是另一个标签页保存的），请重新载入后再保存')
  }
  const written = settings ? await writeUserSettings(settings.settings, settings.revision, settings.cwd) : null
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // Rename is atomic: a read mid-save sees the old list or the new one.
  const temp = `${path}.${process.pid}.tmp`
  await writePrivate(temp, `${JSON.stringify({ activeId, channels }, null, 2)}\n`, 0o600)
  await rename(temp, path)
  return { library: await readChannels(), settings: written }
}

function parse(raw: string, path: string): Omit<ChannelLibrary, 'revision'> {
  if (!raw.trim()) return { channels: [], activeId: null }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${path} 不是合法的 JSON，请修好或删除它：${(error as Error).message}`)
  }
  const { channels, activeId } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  try {
    validate(channels, activeId ?? null)
  } catch (error) {
    throw new Error(`${path} 的内容有误，请修好或删除它：${(error as Error).message}`)
  }
  return { channels, activeId: (activeId as string | null | undefined) ?? null }
}

function validate(channels: unknown, activeId: unknown): asserts channels is Channel[] {
  if (!Array.isArray(channels)) throw new Error('channels 必须是数组')
  if (channels.length > MAX_CHANNELS) throw new Error(`最多保存 ${MAX_CHANNELS} 个渠道`)
  const ids = new Set<string>()
  channels.forEach((channel: unknown, index) => {
    const at = `第 ${index + 1} 个渠道`
    if (typeof channel !== 'object' || channel === null) throw new Error(`${at}不是对象`)
    const { id, name, settings } = channel as Record<string, unknown>
    if (typeof id !== 'string' || !ID.test(id)) throw new Error(`${at}的 id 无效`)
    if (ids.has(id)) throw new Error(`${at}的 id 重复`)
    ids.add(id)
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error(`${at}的名称不能为空，也不能超过 100 个字符`)
    try {
      validateSettings(settings)
    } catch (error) {
      throw new Error(`渠道「${name}」：${(error as Error).message}`)
    }
  })
  if (activeId !== null && (typeof activeId !== 'string' || !ids.has(activeId))) throw new Error('当前渠道不在列表里')
}
