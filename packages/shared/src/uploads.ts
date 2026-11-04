/**
 * Composer files are saved into `<cwd>/upload/` and referenced as
 * `@upload/<name>`, not sent as inline attachments. The server also checks
 * the bytes match the extension; accepting a video does not imply the model
 * can decode it.
 */
export const UPLOAD_DIR = 'upload'

/** Per file, streamed as a raw HTTP request body (without base64 expansion). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export const UPLOAD_KINDS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
  pdf: ['pdf'],
  video: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mpeg', 'mpg', 'ogv', '3gp', '3g2'],
  /** Macro-enabled variants (docm, xlsm, pptm) are deliberately absent. */
  office: ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'],
  zip: ['zip'],
  text: [
    // text and data
    'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'log', 'toml', 'ini', 'cfg', 'conf',
    // source code
    'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'java', 'kt', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs',
    'rb', 'php', 'swift', 'scala', 'lua', 'r', 'pl', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'html', 'htm',
    'css', 'scss', 'less', 'vue', 'svelte', 'gradle', 'proto', 'graphql', 'tex', 'ipynb',
  ],
} as const satisfies Record<string, readonly string[]>

export type UploadKind = keyof typeof UPLOAD_KINDS

/** The upload kind a file name's extension falls under, or null when it is not taken. */
export function uploadKind(filename: string): UploadKind | null {
  const ext = /\.([^./\\]+)$/.exec(filename)?.[1]?.toLowerCase()
  if (!ext) return null
  for (const [kind, extensions] of Object.entries(UPLOAD_KINDS) as [UploadKind, readonly string[]][]) {
    if (extensions.includes(ext)) return kind
  }
  return null
}
