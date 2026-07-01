import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Option } from "effect"
import { KekProvider } from "../crypto/kek"
import { KekVersionRepo } from "../repo/kek.repo"
import { assets } from "./assets.gen"

const PLACEHOLDER = `<!doctype html><html><head><meta charset="utf-8"><title>cuki</title>
<style>body{background:#0b0b0c;color:#e7e7e9;font-family:ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0}
.card{border:1px solid #26262b;padding:2rem 2.5rem}.a{color:#7c8cff}code{color:#9aa}</style></head>
<body><div class="card"><h1>cuki</h1><p>secrets &amp; config — API is live.</p>
<p><code>GET /healthz</code> · <code>GET /docs</code> · <code>POST /v1/auth/register</code></p>
<p class="a">dashboard not built — run <code>bun run build:web</code></p></div></body></html>`

const decode = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"))

/** Serve an embedded SPA asset, falling back to index.html for client-side routing. */
export const serveStatic = (path: string) =>
  Effect.gen(function* () {
    const clean = path === "/" || path === "" ? "/index.html" : path.split("?")[0]!
    const direct = assets[clean]
    if (direct) {
      return HttpServerResponse.uint8Array(decode(direct.base64), {
        contentType: direct.contentType,
      })
    }
    // SPA fallback: unknown non-file path → index.html.
    const index = assets["/index.html"]
    if (index && !clean.includes(".")) {
      return HttpServerResponse.uint8Array(decode(index.base64), {
        contentType: index.contentType,
      })
    }
    if (index) return HttpServerResponse.text("not found", { status: 404 })
    // No dashboard embedded yet.
    return clean === "/index.html"
      ? HttpServerResponse.html(PLACEHOLDER)
      : HttpServerResponse.text("not found", { status: 404 })
  })

/** Liveness — process is up. */
export const healthz = HttpServerResponse.text("ok")

/** Readiness — Postgres reachable + KEK loaded (design 08). */
export const readyz = Effect.gen(function* () {
  const kek = yield* KekProvider
  const repo = yield* KekVersionRepo
  const active = yield* repo.active().pipe(Effect.catchAll(() => Effect.succeed(Option.none())))
  const version = yield* kek.activeVersion
  const dbOk = Option.isSome(active)
  const kekOk = version > 0
  return dbOk && kekOk
    ? HttpServerResponse.text("ready")
    : HttpServerResponse.text(
        `not ready (db=${dbOk ? "ok" : "down"}, kek=${kekOk ? "ok" : "uninitialised"})`,
        { status: 503 },
      )
}).pipe(Effect.catchAll(() => HttpServerResponse.text("not ready", { status: 503 })))

export { HttpServerRequest }
