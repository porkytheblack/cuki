import { describe, expect, it } from "@effect/vitest"
import { ipInCidrs, parseIp } from "../src/util/cidr"
import {
  checkLock,
  hitWindow,
  newRlState,
  recordFailure,
  recordSuccess,
} from "../src/util/ratelimit-core"

describe("cidr — IPv4", () => {
  it("matches within a CIDR and rejects outside", () => {
    expect(ipInCidrs("10.1.2.3", ["10.0.0.0/8"])).toBe(true)
    expect(ipInCidrs("10.1.2.3", ["192.168.0.0/16"])).toBe(false)
    expect(ipInCidrs("192.168.1.5", ["192.168.1.0/24"])).toBe(true)
    expect(ipInCidrs("192.168.2.5", ["192.168.1.0/24"])).toBe(false)
  })
  it("supports exact host (no prefix) and /0", () => {
    expect(ipInCidrs("127.0.0.1", ["127.0.0.1"])).toBe(true)
    expect(ipInCidrs("127.0.0.2", ["127.0.0.1"])).toBe(false)
    expect(ipInCidrs("8.8.8.8", ["0.0.0.0/0"])).toBe(true)
  })
  it("rejects malformed", () => {
    expect(ipInCidrs("999.1.1.1", ["0.0.0.0/0"])).toBe(false)
    expect(parseIp("nope")).toBeNull()
  })
})

describe("cidr — IPv6", () => {
  it("matches IPv6 CIDRs (:: compression)", () => {
    expect(ipInCidrs("2001:db8::1", ["2001:db8::/32"])).toBe(true)
    expect(ipInCidrs("2001:db9::1", ["2001:db8::/32"])).toBe(false)
    expect(ipInCidrs("::1", ["::1"])).toBe(true)
    expect(ipInCidrs("fe80::abcd", ["fe80::/10"])).toBe(true)
  })
  it("strips zone id and handles IPv4-mapped IPv6", () => {
    expect(ipInCidrs("fe80::1%eth0", ["fe80::/10"])).toBe(true)
    expect(ipInCidrs("::ffff:192.168.1.1", ["::ffff:192.168.0.0/112"])).toBe(true)
    expect(ipInCidrs("::ffff:10.0.0.1", ["::ffff:192.168.0.0/112"])).toBe(false)
  })
  it("does not cross address families", () => {
    expect(ipInCidrs("10.0.0.1", ["2001:db8::/32"])).toBe(false)
    expect(ipInCidrs("2001:db8::1", ["10.0.0.0/8"])).toBe(false)
  })
})

describe("ratelimit — sliding window", () => {
  it("allows up to the limit, then blocks until the window resets", () => {
    const s = newRlState()
    expect(hitWindow(s, "k", 2, 1000, 0).ok).toBe(true)
    expect(hitWindow(s, "k", 2, 1000, 100).ok).toBe(true)
    const blocked = hitWindow(s, "k", 2, 1000, 200)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThan(0)
    // new window
    expect(hitWindow(s, "k", 2, 1000, 1000).ok).toBe(true)
  })
})

describe("ratelimit — lockout with backoff", () => {
  const opts = { threshold: 3, baseMs: 100, maxMs: 1000 }
  it("locks after threshold failures and clears on success", () => {
    const s = newRlState()
    recordFailure(s, "ip", 0, opts)
    recordFailure(s, "ip", 0, opts)
    expect(checkLock(s, "ip", 0).ok).toBe(true) // below threshold
    recordFailure(s, "ip", 0, opts)
    expect(checkLock(s, "ip", 0).ok).toBe(false) // locked
    expect(checkLock(s, "ip", 100).ok).toBe(true) // lockout (100ms) elapsed
    recordSuccess(s, "ip")
    expect(checkLock(s, "ip", 0).ok).toBe(true)
  })
  it("escalates the backoff exponentially up to the cap", () => {
    const s = newRlState()
    for (let i = 0; i < 3; i++) recordFailure(s, "ip", 0, opts) // until = 100
    expect(checkLock(s, "ip", 0).retryAfterMs).toBe(100)
    recordFailure(s, "ip", 0, opts) // 4th → 100*2 = 200
    expect(checkLock(s, "ip", 0).retryAfterMs).toBe(200)
    recordFailure(s, "ip", 0, opts) // 5th → 400
    expect(checkLock(s, "ip", 0).retryAfterMs).toBe(400)
    for (let i = 0; i < 5; i++) recordFailure(s, "ip", 0, opts) // beyond cap
    expect(checkLock(s, "ip", 0).retryAfterMs).toBe(1000) // capped at maxMs
  })
})
