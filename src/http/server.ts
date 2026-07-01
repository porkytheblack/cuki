import {
  HttpApiBuilder,
  HttpApiScalar,
  HttpMiddleware,
  HttpServerRequest,
} from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { AppConfig } from "../config"
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
const withExtras = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const path = req.url.split("?")[0] ?? "/"
    if (path === "/healthz") return yield* healthz
    if (path === "/readyz") return yield* readyz
    if (path.startsWith("/v1") || path.startsWith("/docs") || path.startsWith("/openapi")) {
      return yield* app
    }
    return yield* serveStatic(path)
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
