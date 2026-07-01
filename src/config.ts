import { Config, ConfigError, Duration, Effect, Either, Option, Redacted } from "effect"

/**
 * Typed, redacted application configuration (design 08).
 *
 * Precedence is CLI flags > env > config file > defaults; this module covers env + defaults.
 * Secrets (`CUKI_MASTER_KEY`, DB URL) are `Config.redacted` so they can never be logged or
 * serialized. Read once at boot and cached as a Layer.
 */

const DEFAULT_ADDR = "0.0.0.0:8787"

/** Parse a compact duration string like `600s`, `30s`, `7d`, `10m`, `2h`, or bare seconds. */
const parseCompactDuration = (raw: string): Option.Option<Duration.Duration> => {
  const s = raw.trim()
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(s)
  if (!m) return Option.none()
  const n = Number(m[1])
  switch (m[2]) {
    case "ms":
      return Option.some(Duration.millis(n))
    case "m":
      return Option.some(Duration.minutes(n))
    case "h":
      return Option.some(Duration.hours(n))
    case "d":
      return Option.some(Duration.days(n))
    case "s":
    case undefined:
    default:
      return Option.some(Duration.seconds(n))
  }
}

const durationConfig = (name: string, def: Duration.Duration) =>
  Config.string(name).pipe(
    Config.mapOrFail((raw) =>
      Option.match(parseCompactDuration(raw), {
        onNone: () =>
          Either.left(
            ConfigError.InvalidData(
              [name],
              `Invalid duration "${raw}" (use e.g. 600s, 10m, 7d)`,
            ),
          ),
        onSome: (d) => Either.right(d),
      }),
    ),
    Config.withDefault(def),
  )

/** host:port → { host, port }. Handles bracketed IPv6 (`[::1]:8787`) and bare IPv6. */
const parseAddr = (addr: string): { host: string; port: number } => {
  const s = addr.trim()
  // Bracketed IPv6: [host]:port or [host]
  if (s.startsWith("[")) {
    const close = s.indexOf("]")
    if (close > 0) {
      const host = s.slice(1, close)
      const rest = s.slice(close + 1)
      const port = rest.startsWith(":") ? Number(rest.slice(1)) : 8787
      return { host, port: Number.isFinite(port) ? port : 8787 }
    }
  }
  const colons = (s.match(/:/g) || []).length
  // Bare IPv6 with no port (more than one colon and not bracketed) → whole string is the host.
  if (colons > 1) return { host: s, port: 8787 }
  if (colons === 0) return { host: s || "0.0.0.0", port: 8787 }
  const idx = s.lastIndexOf(":")
  const host = s.slice(0, idx) || "0.0.0.0"
  const port = Number(s.slice(idx + 1))
  return { host, port: Number.isFinite(port) ? port : 8787 }
}

export type KekProviderKind = "local" | "aws-kms" | "gcp-kms" | "vault-transit"

export class AppConfig extends Effect.Service<AppConfig>()("AppConfig", {
  accessors: true,
  effect: Effect.gen(function* () {
    const addrStr = yield* Config.string("CUKI_ADDR").pipe(Config.withDefault(DEFAULT_ADDR))
    const { host, port } = parseAddr(addrStr)

    // Required datastore URL. Accept CUKI_DATABASE_URL, fall back to DATABASE_URL.
    const databaseUrl = yield* Config.redacted("CUKI_DATABASE_URL").pipe(
      Config.orElse(() => Config.redacted("DATABASE_URL")),
    )
    const dbPool = yield* Config.integer("CUKI_DB_POOL").pipe(Config.withDefault(10))

    // KEK sourcing (design 03). Any of these may be present; KekProvider resolves precedence.
    const masterKey = yield* Config.option(Config.redacted("CUKI_MASTER_KEY"))
    const masterKeyFile = yield* Config.option(Config.string("CUKI_MASTER_KEY_FILE"))
    const masterPassphrase = yield* Config.option(Config.redacted("CUKI_MASTER_PASSPHRASE"))
    const masterSalt = yield* Config.option(Config.string("CUKI_MASTER_SALT"))
    const masterKeyOld = yield* Config.option(Config.redacted("CUKI_MASTER_KEY_OLD"))
    const kekProvider = (yield* Config.literal(
      "local",
      "aws-kms",
      "gcp-kms",
      "vault-transit",
    )("CUKI_KEK_PROVIDER").pipe(Config.withDefault("local" as const))) as KekProviderKind

    const tokenTtl = yield* durationConfig("CUKI_TOKEN_TTL", Duration.minutes(10))
    const challengeTtl = yield* durationConfig("CUKI_CHALLENGE_TTL", Duration.seconds(30))
    const sessionTtl = yield* durationConfig("CUKI_SESSION_TTL", Duration.days(7))
    const sweepInterval = yield* durationConfig("CUKI_SWEEP_INTERVAL", Duration.minutes(5))

    const tlsCert = yield* Config.option(Config.string("CUKI_TLS_CERT"))
    const tlsKey = yield* Config.option(Config.string("CUKI_TLS_KEY"))

    const logLevel = yield* Config.string("CUKI_LOG").pipe(Config.withDefault("info"))

    // Only trust X-Forwarded-For when a header-stripping reverse proxy sits in front;
    // otherwise clients could spoof the source IP used for service IP allowlists + audit.
    const trustProxy = yield* Config.boolean("CUKI_TRUST_PROXY").pipe(Config.withDefault(false))

    return {
      addr: { host, port },
      trustProxy,
      db: { url: databaseUrl, poolSize: dbPool },
      kek: {
        provider: kekProvider,
        masterKey,
        masterKeyFile,
        masterPassphrase,
        masterSalt,
        masterKeyOld,
      },
      ttl: { token: tokenTtl, challenge: challengeTtl, session: sessionTtl },
      sweepInterval,
      tls: { cert: tlsCert, key: tlsKey },
      logLevel,
      /** A boot-log-safe view: no secret material. */
      describe: () => ({
        addr: `${host}:${port}`,
        dbPool,
        kekProvider,
        tokenTtl: Duration.format(tokenTtl),
        challengeTtl: Duration.format(challengeTtl),
        sessionTtl: Duration.format(sessionTtl),
        tls: Option.isSome(tlsCert),
        trustProxy,
        logLevel,
        dbUrl: Redacted.value(databaseUrl).replace(/\/\/[^@]*@/, "//***@"),
      }),
    }
  }),
}) {}
