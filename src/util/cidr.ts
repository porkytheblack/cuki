/**
 * IP allowlist matching for the retrieval plane (design 04). Supports IPv4 and IPv6 CIDRs
 * (including `::` compression and IPv4-mapped IPv6), matched by 128/32-bit prefix.
 */

export interface ParsedIp {
  readonly version: 4 | 6
  readonly value: bigint
}

const parseIpv4 = (s: string): bigint | null => {
  const parts = s.split(".")
  if (parts.length !== 4) return null
  let n = 0n
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const b = Number(p)
    if (b > 255) return null
    n = (n << 8n) | BigInt(b)
  }
  return n
}

const parseIpv6 = (raw: string): bigint | null => {
  let s = raw
  // A zone id (fe80::1%eth0) is not meaningful for matching — strip it.
  const zone = s.indexOf("%")
  if (zone >= 0) s = s.slice(0, zone)

  // Embedded IPv4 in the last 32 bits (e.g. ::ffff:1.2.3.4).
  let tailV4 = 0n
  let hasV4 = false
  if (s.includes(".")) {
    const lastColon = s.lastIndexOf(":")
    if (lastColon < 0) return null
    const v4 = parseIpv4(s.slice(lastColon + 1))
    if (v4 === null) return null
    tailV4 = v4
    hasV4 = true
    s = s.slice(0, lastColon + 1) + "0:0" // placeholder for the two 16-bit groups
  }

  const dbl = s.split("::")
  if (dbl.length > 2) return null

  const toGroups = (part: string): number[] | null => {
    if (part === "") return []
    const gs = part.split(":")
    const out: number[] = []
    for (const g of gs) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }

  let groups: number[]
  if (dbl.length === 2) {
    const head = toGroups(dbl[0]!)
    const tail = toGroups(dbl[1]!)
    if (head === null || tail === null) return null
    const missing = 8 - head.length - tail.length
    if (missing < 0) return null
    groups = [...head, ...Array(missing).fill(0), ...tail]
  } else {
    const g = toGroups(s)
    if (g === null || g.length !== 8) return null
    groups = g
  }
  if (groups.length !== 8) return null

  let n = 0n
  for (const g of groups) n = (n << 16n) | BigInt(g)
  if (hasV4) {
    // Overwrite the low 32 bits with the parsed IPv4 value.
    n = (n & ~0xffffffffn) | tailV4
  }
  return n
}

export const parseIp = (s: string): ParsedIp | null => {
  const t = s.trim()
  if (t.includes(":")) {
    const v6 = parseIpv6(t)
    return v6 === null ? null : { version: 6, value: v6 }
  }
  const v4 = parseIpv4(t)
  return v4 === null ? null : { version: 4, value: v4 }
}

const matchCidr = (ip: ParsedIp, cidr: string): boolean => {
  const slash = cidr.lastIndexOf("/")
  const rangeStr = slash >= 0 ? cidr.slice(0, slash) : cidr
  const net = parseIp(rangeStr)
  if (net === null || net.version !== ip.version) return false
  const width = ip.version === 6 ? 128 : 32
  const prefix = slash >= 0 ? Number(cidr.slice(slash + 1)) : width
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) return false
  if (prefix === 0) return true
  const shift = BigInt(width - prefix)
  return ip.value >> shift === net.value >> shift
}

export const ipInCidrs = (ip: string, cidrs: ReadonlyArray<string>): boolean => {
  const parsed = parseIp(ip)
  if (parsed === null) return false
  for (const cidr of cidrs) {
    if (matchCidr(parsed, cidr.trim())) return true
  }
  return false
}
