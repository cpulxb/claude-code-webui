import type { Attachment } from '@ccw/shared'

/**
 * Reads a picked or pasted file into the base64 content block shape the
 * Messages API expects. Images become `image` blocks, everything else becomes
 * a `document` block.
 */
export async function fileToAttachment(file: File): Promise<Attachment> {
  const buffer = await file.arrayBuffer()
  return {
    kind: file.type.startsWith('image/') ? 'image' : 'document',
    mediaType: file.type || 'application/octet-stream',
    data: base64(buffer),
    ...(file.name ? { filename: file.name } : {}),
  }
}

/** Chunked so a large file cannot blow the argument limit of String.fromCharCode. */
function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
