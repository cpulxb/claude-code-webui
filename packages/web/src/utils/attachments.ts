import type { Attachment } from '@ccw/shared'

/** Image types the Messages API accepts; anything else is rejected up front. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
/** Document types the Messages API accepts as a `document` block. */
const DOCUMENT_TYPES = new Set(['application/pdf', 'text/plain'])

/** Whether the API would accept this file at all. */
export function isSupportedAttachment(file: File): boolean {
  return IMAGE_TYPES.has(file.type) || DOCUMENT_TYPES.has(file.type)
}

/**
 * Reads a picked or pasted file into the base64 content block shape the
 * Messages API expects. Images become `image` blocks, everything else becomes
 * a `document` block. Callers must filter with `isSupportedAttachment` first.
 */
export async function fileToAttachment(file: File): Promise<Attachment> {
  return {
    kind: IMAGE_TYPES.has(file.type) ? 'image' : 'document',
    mediaType: file.type,
    data: await fileToBase64(file),
    ...(file.name ? { filename: file.name } : {}),
  }
}

/** The file's bytes as base64, as `files.upload` takes them. */
export async function fileToBase64(file: File): Promise<string> {
  return base64(await file.arrayBuffer())
}

/**
 * Encoded chunk by chunk so a large file never materialises as one giant
 * binary string. The chunk size is a multiple of 3 so each `btoa` call ends on
 * a whole base64 group and the pieces can simply be concatenated.
 */
function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 30000
  const parts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))))
  }
  return parts.join('')
}
