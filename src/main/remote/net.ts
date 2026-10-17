/**
 * Pure networking helpers for the Remote bridge: LAN address discovery,
 * constant-time token comparison and auth-header parsing. No Electron imports.
 */
import { createHash, timingSafeEqual } from 'crypto'
import os from 'os'
import { REMOTE_WS_TOKEN_PREFIX } from '@shared/ipc'

/** IPv4 RFC1918 + loopback ranges counted as "LAN/private" for ordering. */
function isPrivateRangeV4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

function ifaceRank(name: string): number {
  if (/^(utun|tun|tap|docker|br-|bridge|veth|vmnet|vbox|virbr|lo|awdl|llw|ap\d)/i.test(name)) {
    return 2
  }
  if (/^(en|eth|wl|wlan|wi-?fi|ethernet)/i.test(name)) return 0
  return 1
}

/** Non-internal IPv4 LAN addresses, best candidate first. */
export function lanAddresses(): { iface: string; address: string }[] {
  const out: { iface: string; address: string }[] = []
  const ifaces = os.networkInterfaces()
  for (const [iface, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue
    for (const addr of addrs) {
      const family = addr.family as string | number
      if (family !== 'IPv4' && family !== 4) continue
      if (addr.internal) continue
      if (addr.address.startsWith('169.254.')) continue
      out.push({ iface, address: addr.address })
    }
  }
  return out.sort((a, b) => {
    const pa = isPrivateRangeV4(a.address) ? 0 : 1
    const pb = isPrivateRangeV4(b.address) ? 0 : 1
    if (pa !== pb) return pa - pb
    return ifaceRank(a.iface) - ifaceRank(b.iface)
  })
}

/** True for loopback / private-range / CGNAT / link-local IPv4 and IPv6. */
export function isLanAddress(remote: string | undefined): boolean {
  if (!remote) return false
  let ip = remote
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  if (ip.includes('.')) return isPrivateV4(ip)
  if (ip === '::1') return true
  const lower = ip.toLowerCase()
  if (lower.startsWith('fe80:')) return true
  const first = parseInt(lower.split(':')[0], 16)
  if (Number.isInteger(first) && (first & 0xfe00) === 0xfc00) return true // fc00::/7
  return false
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = nums
  if (a === 127) return true
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/** Constant-time token comparison (sha256 then timingSafeEqual). */
export function tokensEqual(a: string, b: string): boolean {
  if (!a || !b) return false
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** Extract `<token>` from an `Authorization: Bearer <token>` header. */
export function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!m) return undefined
  const token = m[1].trim()
  return token || undefined
}

/** Extract the token from `Sec-WebSocket-Protocol: deltav.v1, auth.<token>`. */
export function parseWsTokenFromProtocols(header: string | undefined): string | undefined {
  if (!header) return undefined
  for (const raw of header.split(',')) {
    const proto = raw.trim()
    if (proto.startsWith(REMOTE_WS_TOKEN_PREFIX)) {
      const token = proto.slice(REMOTE_WS_TOKEN_PREFIX.length)
      if (token) return token
    }
  }
  return undefined
}
