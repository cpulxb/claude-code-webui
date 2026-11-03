/**
 * Channels: named copies of the part of settings.json the channel and model
 * forms edit, saved apart so the user can switch between them. The active one
 * is always what settings.json holds now — whoever wrote it last.
 */

import type { Channel, ChannelLibrary } from '@ccw/shared'

import { applyForm, formProblems, LEGACY_ROLE, toForm, type SettingsForm } from './settings.ts'

type Json = Record<string, unknown>

/** A channel as the page edits it: as a form, so a model row still being typed is kept. */
export type ChannelDraft = { id: string; name: string; form: SettingsForm }

/** What a channel carries of settings.json: exactly the keys the forms write. */
export function channelFragment(form: SettingsForm): Json {
  return applyForm({}, form)
}

/**
 * The page's drafts for a saved list. The active entry takes its form from
 * settings.json. With no active entry — the first visit, or one deleted in
 * another tab — the saved channel settings.json matches becomes active, or
 * else settings.json becomes a channel of its own, unsaved until the page is.
 */
export function fromLibrary(library: Pick<ChannelLibrary, 'channels' | 'activeId'>, settings: Json): { drafts: ChannelDraft[]; activeId: string } {
  const current = toForm(settings)
  const drafts = library.channels.map(({ id, name, settings: saved }) => ({ id, name, form: toForm(saved) }))
  const fragment = JSON.stringify(channelFragment(current))
  const active =
    drafts.find(({ id }) => id === library.activeId) ??
    drafts.find(({ form }) => JSON.stringify(channelFragment(form)) === fragment)
  if (active) return { drafts: drafts.map((draft) => (draft === active ? { ...draft, form: current } : draft)), activeId: active.id }
  const own = { id: newChannelId(), name: defaultChannelName(current), form: current }
  return { drafts: [own, ...drafts], activeId: own.id }
}

/** The list to save: the active entry as the page's form has it. */
export function toLibrary(drafts: ChannelDraft[], activeId: string, activeForm: SettingsForm): { channels: Channel[]; activeId: string } {
  return {
    activeId,
    channels: drafts.map(({ id, name, form }) => ({
      id,
      name: name.trim(),
      settings: channelFragment(id === activeId ? activeForm : form),
    })),
  }
}

/** `settings` switched to `form`'s channel: every key a channel carries replaced, everything else kept. */
export function switchTo(settings: Json, form: SettingsForm): Json {
  const next = applyForm(settings, form)
  const env = next['env']
  // The forms only show the legacy role where it is set, so the other channel's would linger, naming its model.
  if (typeof env === 'object' && env !== null && !(LEGACY_ROLE in form.roles)) delete (env as Json)[LEGACY_ROLE]
  return next
}

/** What stops saving the inactive channels; the active one is checked as the page's own form. */
export function channelProblems(drafts: ChannelDraft[], activeId: string): string[] {
  return drafts.flatMap(({ id, name, form }) => {
    const label = name.trim() || '未命名渠道'
    return [
      ...(name.trim() ? [] : ['有渠道没填名称']),
      ...(id === activeId ? [] : formProblems(form).map((problem) => `渠道「${label}」：${problem}`)),
    ]
  })
}

/** A name for a channel nobody named: its address's host. */
export function defaultChannelName(form: SettingsForm): string {
  try {
    return new URL(form.baseUrl.trim()).host || '默认渠道'
  } catch {
    return form.baseUrl.trim() ? '默认渠道' : 'Anthropic 官方'
  }
}

/** Random, from `getRandomValues`, which unlike `randomUUID` also works outside a secure context. */
export function newChannelId(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
