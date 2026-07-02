import {
  HttpApiBuilder,
  HttpApiScalar,
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { AppConfig } from "../config"
import { timingSafeEqual } from "../crypto/keys"
import { utf8ToBytes } from "../util/bytes"
import { api } from "./api"
import { AuthGroupLive } from "./handlers/auth"
import { ManagementGroupLive } from "./handlers/management"
import { RetrievalGroupLive } from "./handlers/retrieval"
import { MiddlewareLive } from "./middleware"
import { healthz, readyz, serveStatic } from "./static"

/** All group handlers + the security middleware, assembled into the API layer. */
const ApiLive = HttpApiBuilder.api(api).pipe(
  Layer.provide(Layer.mergeAll(AuthGroupLive, ManagementGroupLive, RetrievalGroupLive)),
  Layer.provide(MiddlewareLive),
)

/**
 * Wrap the API app: health endpoints, then delegate `/v1` + API docs to the API router,
 * else serve the embedded SPA (with client-routing fallback). Design 08.
 */
/** Baseline hardening headers applied to every response (design: defense in depth). */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
} as const

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"])

const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(";")) {
    const i = part.indexOf("=")
    if (i < 0) continue
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

const csrfEqual = (a: string, b: string) => timingSafeEqual(utf8ToBytes(a), utf8ToBytes(b))

const withExtras = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const cfg = yield* AppConfig
    const req = yield* HttpServerRequest.HttpServerRequest
    const path = req.url.split("?")[0] ?? "/"
    const isApi = path.startsWith("/v1")
    const isDocs = path.startsWith("/docs") || path.startsWith("/openapi")

    // API docs are opt-in (CUKI_ENABLE_DOCS) — hide the surface otherwise.
    if (isDocs && !cfg.security.docsEnabled) {
      return HttpServerResponse.text("not found", { status: 404 })
    }

    // Double-submit CSRF: cookie-authenticated mutating management requests must echo the
    // csrf cookie in X-CSRF-Token. Bearer/retrieval and auth endpoints are exempt.
    if (cfg.security.csrfEnabled && MUTATING.has(req.method) && isApi && !path.startsWith("/v1/auth/")) {
      const cookies = parseCookies(req.headers["cookie"])
      if (cookies["cuki_session"]) {
        const header = req.headers["x-csrf-token"]
        const cookie = cookies["cuki_csrf"]
        if (!header || !cookie || !csrfEqual(header, cookie)) {
          return HttpServerResponse.text("CSRF token missing or invalid", { status: 403 })
        }
      }
    }

    let res
    if (path === "/healthz") res = yield* healthz
    else if (path === "/readyz") res = yield* readyz
    else if (isApi || isDocs) res = yield* app
    else res = yield* serveStatic(path)
    return HttpServerResponse.setHeaders(res, SECURITY_HEADERS)
  }),
)

/** The Bun HTTP server bound to the configured address. */
const HttpServerLive = Layer.unwrapEffect(
  AppConfig.pipe(
    Effect.map((cfg) => BunHttpServer.layer({ port: cfg.addr.port, hostname: cfg.addr.host })),
  ),
)

/**
 * The full HTTP layer. Requires the domain services (+ KEK/repos) and `AppConfig`, provided
 * by the app root in `main`.
 */
export const HttpLive = HttpApiBuilder.serve(withExtras).pipe(
  Layer.provide(HttpApiScalar.layer({ path: "/docs" })),
  Layer.provide(ApiLive),
  Layer.provide(HttpServerLive),
)
