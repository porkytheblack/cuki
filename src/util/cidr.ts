/**
 * Minimal IP allowlist matching for the retrieval plane (design 04). IPv4 CIDRs are matched
 * by prefix; IPv6 is matched by normalized exact string. Good enough for a secondary control.
 */

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const b = Number(p)
    if (!Number.isInteger(b) || b < 0 || b > 255) return null
    n = (n << 8) | b
  }
  return n >>> 0
}

const matchIpv4Cidr = (ip: string, cidr: string): boolean => {
  const [range, bitsStr] = cidr.split("/")
  const bits = bitsStr === undefined ? 32 : Number(bitsStr)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const ipInt = ipv4ToInt(ip)
  const rangeInt = ipv4ToInt(range!)
  if (ipInt === null || rangeInt === null) return false
  if (bits === 0) return true
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0
  return (ipInt & mask) === (rangeInt & mask)
}

export const ipInCidrs = (ip: string, cidrs: ReadonlyArray<string>): boolean => {
  for (const cidr of cidrs) {
    if (cidr.includes(".")) {
      if (matchIpv4Cidr(ip, cidr)) return true
    } else if (ip === cidr) {
      return true
    }
  }
  return false
}
