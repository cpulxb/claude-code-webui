import { useSyncExternalStore } from 'react'

/** Phone widths, where the side panels become drawers. Matches the 640px media queries in the CSS modules. */
export const NARROW = window.matchMedia('(max-width: 640px)')

function subscribeNarrow(onChange: () => void): () => void {
  NARROW.addEventListener('change', onChange)
  return () => NARROW.removeEventListener('change', onChange)
}

export function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, () => NARROW.matches)
}
