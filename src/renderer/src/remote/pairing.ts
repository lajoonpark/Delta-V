/** localStorage key under which the remote pairing token is persisted. */
export const TOKEN_STORAGE_KEY = 'deltav.remote.token'

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/

/** Extract a pairing token from a raw token, "#token" or a full pairing URL (http://ip:port/#token). Returns null when invalid. */
export function extractToken(input: string): string | null {
  let s = input.trim()
  const hash = s.lastIndexOf('#')
  if (hash >= 0) s = s.slice(hash + 1)
  if (s.startsWith('#')) s = s.slice(1)
  return TOKEN_RE.test(s) ? s : null
}
