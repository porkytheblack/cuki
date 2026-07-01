import { defineConfig } from "drizzle-kit"

/**
 * drizzle-kit config for authoring migrations against `schema.ts`.
 * `cuki migrate` applies them at boot; never edit an applied migration — add a new one.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url:
      process.env.CUKI_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://cuki:cuki@127.0.0.1:5432/cuki",
  },
  strict: true,
  verbose: true,
})
