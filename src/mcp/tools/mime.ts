/** Map common file extensions to MIME types. Used when the server's
 *  Content-Type is missing or generic (Overleaf's filestore returns no
 *  Content-Type and sets `x-content-type-options: nosniff`, so the path
 *  extension is the only signal we have). */
export const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  md: 'text/markdown',
  html: 'text/html',
}

/**
 * Return a refined MIME for a path: trust an explicit non-generic server
 * MIME if present; otherwise fall back to extension lookup; finally default
 * to application/octet-stream.
 */
export function effectiveMime(serverMime: string, path: string): string {
  if (serverMime && serverMime !== 'application/octet-stream') return serverMime
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  if (ext && EXT_TO_MIME[ext]) return EXT_TO_MIME[ext]
  return serverMime || 'application/octet-stream'
}
