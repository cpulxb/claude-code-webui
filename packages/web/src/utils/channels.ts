/**
 * Channels: named copies of the part of settings.json the channel and model
 * forms edit, saved apart so the user can switch between them. The active one
 * is always what settings.json holds now — whoever wrote it last.
 */

import { ROUTE_PATH, type ApiFormat, type Channel, type ChannelLibrary, type ChannelRoute, type RpcParams } from '@ccw/shared'

import { applyForm, formProblems, LEGACY_ROLE, toForm, type SettingsForm } from './settings.ts'

type Json = Record<string, unknown>

/**
 * A channel as the page edits it: as a form, so a model row still being
 * typed is kept. A routed channel's upstream is its `route`; its form's
 * address and key stand for nothing then, settings.json getting the route's.
 */
export type ChannelDraft = { id: string; name: string; form: SettingsForm; route: ChannelRoute | null }

export const FORMAT_LABELS: Record<ApiFormat, string> = {
  anthropic: 'Anthropic Messages（原生）',
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses API',
  gemini: 'Gemini 原生 generateContent',
}

/** Where settings.json sends the CLI for routed channel `id`. */
export const routeUrl = (routeBase: string, id: string): string => `${routeBase}/${id}`

/**
 * The form settings.json is written from for a channel: a routed one points
 * the CLI at the route, with the route token for its key. Without a route
 * base (no route this server can offer) the form is left as it is.
 */
export function settingsForm(form: SettingsForm, id: string, route: ChannelRoute | null, routeBase: string | null): SettingsForm {
  if (!route || !routeBase) return form
  return { ...form, baseUrl: routeUrl(routeBase, id), authField: 'ANTHROPIC_AUTH_TOKEN', key: route.token }
}

/** What 获取模型列表 asks: the upstream itself, in its own format. */
export function connection(form: SettingsForm, route: ChannelRoute | null): RpcParams<'settings.fetchModels'> {
  if (route) return { baseUrl: route.baseUrl, authField: 'ANTHROPIC_AUTH_TOKEN', key: route.key, format: route.format }
  return { baseUrl: form.baseUrl, authField: form.authField, key: form.key, format: 'anthropic' }
}

/**
 * A channel moved to `format`. Into a routed one the address and key move
 * from the form to the route, which gets a fresh token; back out, they move
 * back.
 */
export function withFormat(form: SettingsForm, route: ChannelRoute | null, format: ApiFormat): { form: SettingsForm; route: ChannelRoute | null } {
  if (format === 'anthropic') {
    return route ? { form: { ...form, baseUrl: route.baseUrl, authField: 'ANTHROPIC_AUTH_TOKEN', key: route.key }, route: null } : { form, route }
  }
  if (route) return { form, route: { ...route, format } }
  return { form: { ...form, baseUrl: '', key: '' }, route: { format, baseUrl: form.baseUrl.trim(), key: form.key, token: newRouteToken() } }
}

/** What a channel carries of settings.json: exactly the keys the forms write. */
export function channelFragment(form: SettingsForm): Json {
  return applyForm({}, form)
}

/**
 * The page's drafts for a saved list. The active entry takes its form from
 * settings.json. With no active entry — the first visit, or one deleted in
 * another tab — the saved channel settings.json matches becomes active, or
 * else settings.json becomes a channel of its own, unsaved until the page is.
 *
 * A routed active channel stays routed while settings.json points at its
 * route, on whatever port: saving moves it to this server's. Pointed
 * elsewhere by hand, settings.json wins and the channel is direct again.
 */
export function fromLibrary(
  library: Pick<ChannelLibrary, 'channels' | 'activeId'> & { routeBase?: string | null },
  settings: Json,
): { drafts: ChannelDraft[]; activeId: string } {
  const current = toForm(settings)
  const drafts = library.channels.map(({ id, name, settings: saved, route }) => ({ id, name, form: toForm(saved), route: route ?? null }))
  const fragment = JSON.stringify(channelFragment(current))
  const active =
    drafts.find(({ id }) => id === library.activeId) ??
    drafts.find(({ id, form, route }) => JSON.stringify(channelFragment(settingsForm(form, id, route, library.routeBase ?? null))) === fragment)
  if (active) {
    const route = active.route && current.baseUrl.endsWith(`${ROUTE_PATH}/${active.id}`) ? active.route : null
    return { drafts: drafts.map((draft) => (draft === active ? { ...draft, form: current, route } : draft)), activeId: active.id }
  }
  const own = { id: newChannelId(), name: defaultChannelName(current), form: current, route: null }
  return { drafts: [own, ...drafts], activeId: own.id }
}

/** The list to save: the active entry as the page's form has it, each routed one's settings pointing at its route. */
export function toLibrary(
  drafts: ChannelDraft[],
  activeId: string,
  activeForm: SettingsForm,
  routeBase: string | null = null,
): { channels: Channel[]; activeId: string } {
  return {
    activeId,
    channels: drafts.map(({ id, name, form, route }) => ({
      id,
      name: name.trim(),
      settings: channelFragment(settingsForm(id === activeId ? activeForm : form, id, route, routeBase)),
      ...(route ? { route: { ...route, baseUrl: route.baseUrl.trim().replace(/\/+$/, ''), key: route.key.trim() } } : {}),
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

/** What stops saving the inactive channels; the active one is checked as the page's own form. A route is checked for each. */
export function channelProblems(drafts: ChannelDraft[], activeId: string, routeBase: string | null = null): string[] {
  return drafts.flatMap(({ id, name, form, route }) => {
    const label = name.trim() || '未命名渠道'
    return [
      ...(name.trim() ? [] : ['有渠道没填名称']),
      ...(id === activeId ? [] : formProblems(form).map((problem) => `渠道「${label}」：${problem}`)),
      ...(route ? routeProblems(route, routeBase).map((problem) => `渠道「${label}」：${problem}`) : []),
    ]
  })
}

/** What is wrong with a route as given: an upstream it needs, and a server that can route. */
export function routeProblems(route: ChannelRoute, routeBase: string | null): string[] {
  const url = route.baseUrl.trim()
  if (!routeBase) return ['这个 WebUI 直接以 HTTPS 提供服务，CLI 连不上它的路由，只能用 Anthropic 格式']
  if (!url) return [`${FORMAT_LABELS[route.format]} 格式要填请求地址`]
  return /^https?:\/\/\S+$/i.test(url) ? [] : ['请求地址要以 http:// 或 https:// 开头']
}

/** A name for a channel nobody named: its address's host. */
export function defaultChannelName(form: SettingsForm): string {
  try {
    return new URL(form.baseUrl.trim()).host || '默认渠道'
  } catch {
    return form.baseUrl.trim() ? '默认渠道' : 'Anthropic 官方'
  }
}

const hex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/** Random, from `getRandomValues`, which unlike `randomUUID` also works outside a secure context. */
export function newChannelId(): string {
  return hex(8)
}

/** The key the CLI shows the route for one channel; whoever has it spends the channel's upstream key. */
export function newRouteToken(): string {
  return `ccw-route-${hex(24)}`
}
