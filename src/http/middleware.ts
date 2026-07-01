import { Effect, Layer, Redacted } from "effect"
import { AuthService } from "../domain/auth.service"
import { TokenService } from "../domain/token.service"
import { ServiceTokenAuth, SessionAuth } from "./api"

/**
 * Security middleware implementations (design 05). Each returns a per-scheme function that
 * receives the credential and resolves the request principal — `CurrentUser` from the
 * session cookie, `CurrentService` from the bearer access token.
 */

export const SessionAuthLive = Layer.effect(
  SessionAuth,
  Effect.gen(function* () {
    const auth = yield* AuthService
    return {
      cookie: (token: Redacted.Redacted<string>) => auth.validateSession(Redacted.value(token)),
    }
  }),
)

export const ServiceTokenAuthLive = Layer.effect(
  ServiceTokenAuth,
  Effect.gen(function* () {
    const tokens = yield* TokenService
    return {
      bearer: (token: Redacted.Redacted<string>) => tokens.resolve(Redacted.value(token)),
    }
  }),
)

export const MiddlewareLive = Layer.mergeAll(SessionAuthLive, ServiceTokenAuthLive)
