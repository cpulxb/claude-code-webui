import { useEffect, useMemo, useSyncExternalStore } from 'react'

import { UploadQueue, uploadBlockReason } from '../../utils/attachments.ts'

export function useUploads(sessionId: string | null, cwd: string | undefined) {
  const queue = useMemo(() => new UploadQueue(cwd), [sessionId, cwd])
  const uploads = useSyncExternalStore(queue.subscribe, queue.getSnapshot)

  // Swapping queues isolates sessions immediately; cleanup also stops the old
  // network requests on session switches, unmounts and React's effect replay.
  useEffect(() => () => queue.clear(), [queue])

  return {
    uploads,
    blockReason: uploadBlockReason(uploads),
    addFiles: queue.add,
    cancelUpload: queue.cancel,
    retryUpload: queue.retry,
    removeUpload: queue.remove,
    clearUploads: queue.clear,
  }
}
