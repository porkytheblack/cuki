#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { Args, Command, Options } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer, Logger, Option } from "effect"
import {
  AppLayer,
  initProgram,
  kekRotateProgram,
  logLevelFor,
  migrateProgram,
  serveProgram,
} from "./app"
import { AppConfig } from "./config"
import { SqlLive } from "./db/sql"
import { Cuki } from "./client/sdk"
import { CukiError } from "./client/errors"

const loggerLayer = Layer.unwrapEffect(
  Effect.sync(() => Logger.minimumLogLevel(logLevelFor(process.env.CUKI_LOG ?? "info"))),
)

// ── server / admin commands ──

const serve = Command.make(
  "serve",
  { noMigrate: Options.boolean("no-migrate").pipe(Options.withDefault(false)) },
  ({ noMigrate }) =>
    serveProgram({ migrate: !noMigrate }).pipe(Effect.provide(AppLayer), Effect.provide(loggerLayer)),
)

const migrate = Command.make("migrate", {}, () =>
  migrateProgram.pipe(
    Effect.provide(SqlLive.pipe(Layer.provide(AppConfig.Default))),
    Effect.provide(loggerLayer),
  ),
)

const init = Command.make("init", {}, () => initProgram)

const kekRotate = Command.make("rotate", {}, () =>
  kekRotateProgram.pipe(Effect.provide(AppLayer), Effect.provide(loggerLayer)),
)
const kek = Command.make("kek", {}).pipe(Command.withSubcommands([kekRotate]))

// ── client commands ──

const credsOption = Options.text("creds").pipe(
  Options.withAlias("c"),
  Options.optional,
)

const clientFromOpts = (creds: Option.Option<string>) =>
  Effect.try({
    try: () => (Option.isSome(creds) ? Cuki.fromCredsFile(creds.value) : Cuki.fromEnv()),
    catch: (e) => (e instanceof CukiError ? e : new CukiError("Config", String(e))),
  })

const fromPromise = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (e) => (e instanceof CukiError ? e : new CukiError("Network", String(e))),
  })

const get = Command.make(
  "get",
  {
    name: Args.text({ name: "NAME" }).pipe(Args.optional),
    json: Options.boolean("json").pipe(Options.withDefault(false)),
    creds: credsOption,
  },
  ({ name, json, creds }) =>
    Effect.gen(function* () {
      const cuki = yield* clientFromOpts(creds)
      if (json || Option.isNone(name)) {
        const all = yield* fromPromise(() => cuki.getAll())
        yield* Console.log(JSON.stringify(all, null, 2))
      } else {
        const value = yield* fromPromise(() => cuki.getSecret(name.value))
        yield* Console.log(value)
      }
    }),
)

const env = Command.make("env", { creds: credsOption }, ({ creds }) =>
  Effect.gen(function* () {
    const cuki = yield* clientFromOpts(creds)
    const all = yield* fromPromise(() => cuki.getAll())
    const lines = Object.entries(all).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    yield* Console.log(lines.join("\n"))
  }),
)

const run = Command.make(
  "run",
  {
    command: Args.text({ name: "command" }).pipe(Args.repeated),
    only: Options.text("only").pipe(Options.optional),
    creds: credsOption,
  },
  ({ command, only, creds }) =>
    Effect.gen(function* () {
      if (command.length === 0) {
        return yield* Effect.dieMessage("usage: cuki run [--only A,B] -- <command...>")
      }
      const cuki = yield* clientFromOpts(creds)
      const onlyList = Option.map(only, (s) => s.split(",").map((x) => x.trim()).filter(Boolean))
      const secrets = yield* fromPromise(() => cuki.getAll())
      const filtered = Option.match(onlyList, {
        onNone: () => secrets,
        onSome: (list) => Object.fromEntries(list.map((k) => [k, secrets[k] ?? ""])),
      })
      const [cmd, ...rest] = command
      const code = yield* Effect.async<number>((resume) => {
        const child = spawn(cmd!, rest, {
          stdio: "inherit",
          env: { ...process.env, ...filtered },
        })
        child.on("exit", (c) => resume(Effect.succeed(c ?? 0)))
        child.on("error", (e) => resume(Effect.die(e)))
      })
      yield* Effect.sync(() => process.exit(code))
    }),
)

// ── root ──

const cli = Command.make("cuki", {}, () =>
  Console.log("cuki — secrets & config. Try `cuki --help`."),
).pipe(Command.withSubcommands([serve, migrate, init, kek, get, env, run]))

const main = Command.run(cli, {
  name: "cuki",
  version: "0.1.0",
})

main(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
