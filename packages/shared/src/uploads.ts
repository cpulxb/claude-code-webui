/**
 * Files the composer cannot send inline (the Messages API only takes images,
 * PDF and plain text) are uploaded into `<cwd>/upload/` and referenced as
 * `@upload/<name>` instead. Only these extensions are taken; the server also
 * checks the bytes look like the kind the extension claims.
 */
export const UPLOAD_DIR = 'upload'

/**
 * Per file. Uploads travel base64 inside a JSON RPC body capped at 32MB
 * (`MAX_BODY_BYTES` on the server); 20MB inflates to ~26.7MB.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

export const UPLOAD_KINDS = {
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
