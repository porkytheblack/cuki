import { HttpServerRequest } from "@effect/platform"
import { Effect, Option } from "effect"
import { AppConfig } from "../config"

/**
 * Extract client ip + user agent for audit logging and IP allowlists (design 04/05).
 * `X-Forwarded-For` is honored ONLY when `CUKI_TRUST_PROXY` is set — otherwise a client
 * could spoof the header to defeat a service's IP allowlist or poison the audit trail. When
 * untrusted, the socket peer address (`remoteAddress`) is used.
 */
export const clientMeta = Effect.gen(function* () {
  const cfg = yield* AppConfig
  const req = yield* HttpServerRequest.HttpServerRequest
  const peer = Option.getOrNull(req.remoteAddress)
  const xff = cfg.trustProxy ? req.headers["x-forwarded-for"] : undefined
  const ip = xff ? (xff.split(",")[0]?.trim() ?? peer) : peer
  const userAgent = req.headers["user-agent"] ?? null
  return { ip: ip ?? null, userAgent }
})
