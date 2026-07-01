import { HttpServerRequest } from "@effect/platform"
import { Effect, Option } from "effect"

/** Extract client ip + user agent for audit logging (design 05). */
export const clientMeta = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const xff = req.headers["x-forwarded-for"]
  const ip = xff ? (xff.split(",")[0]?.trim() ?? null) : Option.getOrNull(req.remoteAddress)
  const userAgent = req.headers["user-agent"] ?? null
  return { ip: ip ?? null, userAgent }
})
