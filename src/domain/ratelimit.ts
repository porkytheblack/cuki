import { Effect } from "effect"
import { AppConfig } from "../config"
import { RateLimited } from "../errors"
import {
  checkLock,
  hitWindow,
  newRlState,
  recordFailure,
  recordSuccess,
  sweep,
  type LockoutOpts,
} from "../util/ratelimit-core"

const secs = (ms: number) => Math.max(1, Math.ceil(ms / 1000))

/**
 * Retrieval-plane rate limiter (design 04). Per-IP and per-service sliding windows on
 * challenge/token, plus exponential-backoff lockout after repeated auth failures. Best-effort
 * and per-instance; disabled via `CUKI_RATE_LIMIT=false`.
 */
export class RateLimiter extends Effect.Service<RateLimiter>()("RateLimiter", {
  effect: Effect.gen(function* () {
    const cfg = yield* AppConfig
    const rl = cfg.rateLimit
    const state = newRlState()
    const lockOpts: LockoutOpts = {
      threshold: rl.lockoutThreshold,
      baseMs: rl.lockoutBaseMs,
      maxMs: rl.lockoutMaxMs,
    }
    let lastSweep = 0
    const now = () => Date.now()
    const maybeSweep = (t: number) => {
      if (t - lastSweep > rl.windowMs) {
        lastSweep = t
        sweep(state, t)
      }
    }
    const limited = (ms: number) => Effect.fail(new RateLimited({ retryAfter: secs(ms) }))

    /** Fail if any fail-key is locked out, then consume each (key, limit) window slot. */
    const guard = (lockKeys: string[], windows: Array<[string, number]>) =>
      Effect.suspend((): Effect.Effect<void, RateLimited> => {
        if (!rl.enabled) return Effect.void
        const t = now()
        maybeSweep(t)
        for (const k of lockKeys) {
          const l = checkLock(state, k, t)
          if (!l.ok) return limited(l.retryAfterMs)
        }
        for (const [key, limit] of windows) {
          const w = hitWindow(state, key, limit, rl.windowMs, t)
          if (!w.ok) return limited(w.retryAfterMs)
        }
        return Effect.void
      })

    const failKeys = (ip: string | null, handle: string | null) => {
      const ks: string[] = []
      if (ip) ks.push(`fail:ip:${ip}`)
      if (handle) ks.push(`fail:svc:${handle}`)
      return ks
    }

    return {
      /** Guard `POST /v1/auth/challenge` by source IP and service handle. */
      challengeGuard: (ip: string | null, handle: string) =>
        guard(failKeys(ip, handle), [
          ...(ip ? [[`ch:ip:${ip}`, rl.challengePerIp] as [string, number]] : []),
          [`ch:svc:${handle}`, rl.challengePerSvc],
        ]),

      /** Guard `POST /v1/auth/token` by source IP. */
      tokenGuard: (ip: string | null) =>
        guard(failKeys(ip, null), ip ? [[`tok:ip:${ip}`, rl.tokenPerIp]] : []),

      /** Record an auth failure for lockout tracking (by ip and, if known, service handle). */
      recordFailure: (ip: string | null, handle: string | null) =>
        Effect.sync(() => {
          if (!rl.enabled) return
          const t = now()
          for (const k of failKeys(ip, handle)) recordFailure(state, k, t, lockOpts)
        }),

      /** Clear failure counters on a successful auth. */
      recordSuccess: (ip: string | null, handle: string | null) =>
        Effect.sync(() => {
          for (const k of failKeys(ip, handle)) recordSuccess(state, k)
        }),
    }
  }),
}) {}
