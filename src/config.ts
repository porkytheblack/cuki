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

/** host:port → { host, port }. */
const parseAddr = (addr: string): { host: string; port: number } => {
  const idx = addr.lastIndexOf(":")
  if (idx < 0) return { host: addr, port: 8787 }
  const host = addr.slice(0, idx) || "0.0.0.0"
  const port = Number(addr.slice(idx + 1))
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

    return {
      addr: { host, port },
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
        logLevel,
        dbUrl: Redacted.value(databaseUrl).replace(/\/\/[^@]*@/, "//***@"),
      }),
    }
  }),
}) {}
