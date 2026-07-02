/**
 * Pure, in-memory rate-limit core (design 04 abuse controls). Sliding fixed-window counters
 * plus exponential-backoff lockout after repeated failures. No I/O, no clock — `now` is
 * passed in so it is deterministic and unit-testable. Best-effort and per-instance (a
 * stateless, horizontally-scaled deployment gets independent limits per node).
 */

export interface RlState {
  readonly windows: Map<string, { count: number; resetAt: number }>
  readonly locks: Map<string, { fails: number; until: number }>
}

export const newRlState = (): RlState => ({ windows: new Map(), locks: new Map() })

export interface Check {
  readonly ok: boolean
  readonly retryAfterMs: number
}

const OK: Check = { ok: true, retryAfterMs: 0 }

/** Consume one slot in a fixed window; fails when the window's limit is exhausted. */
export const hitWindow = (
  s: RlState,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): Check => {
  const w = s.windows.get(key)
  if (!w || now >= w.resetAt) {
    s.windows.set(key, { count: 1, resetAt: now + windowMs })
    return OK
  }
  if (w.count >= limit) return { ok: false, retryAfterMs: Math.max(0, w.resetAt - now) }
  w.count += 1
  return OK
}

/** True (ok) unless the key is currently within an active lockout. */
export const checkLock = (s: RlState, key: string, now: number): Check => {
  const l = s.locks.get(key)
  if (l && l.until > now) return { ok: false, retryAfterMs: l.until - now }
  return OK
}

export interface LockoutOpts {
  readonly threshold: number
  readonly baseMs: number
  readonly maxMs: number
}

/** Record a failure; once `threshold` consecutive failures accrue, apply an exponential lockout. */
export const recordFailure = (s: RlState, key: string, now: number, opts: LockoutOpts): void => {
  const l = s.locks.get(key) ?? { fails: 0, until: 0 }
  l.fails += 1
  if (l.fails >= opts.threshold) {
    const over = l.fails - opts.threshold
    l.until = now + Math.min(opts.maxMs, opts.baseMs * 2 ** over)
  }
  s.locks.set(key, l)
}

/** Clear the failure counter for a key (on a successful auth). */
export const recordSuccess = (s: RlState, key: string): void => {
  s.locks.delete(key)
}

/** Drop expired windows and long-idle locks to bound memory. */
export const sweep = (s: RlState, now: number): void => {
  for (const [k, w] of s.windows) if (now >= w.resetAt) s.windows.delete(k)
  for (const [k, l] of s.locks) if (l.until > 0 && now - l.until > 3_600_000) s.locks.delete(k)
}
