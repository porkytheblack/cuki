import { SqlClient } from "@effect/sql"
import { and, desc, eq, gte, lt, lte, type SQL } from "drizzle-orm"
import { Effect, Option } from "effect"
import { Database } from "../db/sql"
import * as s from "../db/schema"

export interface AuditFilter {
  readonly actorType?: "user" | "service" | "system"
  readonly action?: string
  readonly environmentId?: string
  readonly result?: "success" | "denied" | "error"
  readonly from?: Date
  readonly to?: Date
  /** Keyset cursor: return rows with id < cursor (ULID desc = newest first). */
  readonly cursor?: string
  readonly limit?: number
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** Append-only audit log + the aggregate queries powering the dashboard (design 05/07). */
export class AuditRepo extends Effect.Service<AuditRepo>()("AuditRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Database
    const sql = yield* SqlClient.SqlClient

    return {
      append: (row: typeof s.auditLogs.$inferInsert) => db.insert(s.auditLogs).values(row),

      query: (orgId: string, f: AuditFilter) => {
        const limit = Math.min(f.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
        const conds: Array<SQL | undefined> = [eq(s.auditLogs.orgId, orgId)]
        if (f.actorType) conds.push(eq(s.auditLogs.actorType, f.actorType))
        if (f.action) conds.push(eq(s.auditLogs.action, f.action))
        if (f.environmentId) conds.push(eq(s.auditLogs.environmentId, f.environmentId))
        if (f.result) conds.push(eq(s.auditLogs.result, f.result))
        if (f.from) conds.push(gte(s.auditLogs.createdAt, f.from))
        if (f.to) conds.push(lte(s.auditLogs.createdAt, f.to))
        if (f.cursor) conds.push(lt(s.auditLogs.id, f.cursor))
        return db
          .select()
          .from(s.auditLogs)
          .where(and(...conds))
          .orderBy(desc(s.auditLogs.id))
          .limit(limit + 1)
          .pipe(
            Effect.map((rows) => {
              const hasMore = rows.length > limit
              const items = hasMore ? rows.slice(0, limit) : rows
              const nextCursor = hasMore ? Option.some(items[items.length - 1]!.id) : Option.none()
              return { items, nextCursor }
            }),
          )
      },

      // ── analytics (aggregates over audit_logs) ──

      readsPerDay: (orgId: string, from: Date, to: Date) =>
        sql<{ day: string; count: number }>`
          SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                 count(*)::int AS count
          FROM audit_logs
          WHERE org_id = ${orgId} AND action = 'secret.read'
            AND created_at >= ${from} AND created_at <= ${to}
          GROUP BY 1 ORDER BY 1`,

      topServices: (orgId: string, from: Date, to: Date, limit = 10) =>
        sql<{ actorId: string | null; count: number }>`
          SELECT actor_id AS "actorId", count(*)::int AS count
          FROM audit_logs
          WHERE org_id = ${orgId} AND actor_type = 'service' AND action = 'secret.read'
            AND created_at >= ${from} AND created_at <= ${to}
          GROUP BY actor_id ORDER BY count DESC LIMIT ${limit}`,

      topKeys: (orgId: string, from: Date, to: Date, limit = 10) =>
        sql<{ keyId: string; count: number }>`
          SELECT kid AS "keyId", count(*)::int AS count
          FROM audit_logs, jsonb_array_elements_text(metadata->'keyIds') AS kid
          WHERE org_id = ${orgId} AND action = 'secret.read'
            AND created_at >= ${from} AND created_at <= ${to}
          GROUP BY kid ORDER BY count DESC LIMIT ${limit}`,

      /** Recent reads by one service (actor_id = service id). */
      serviceActivity: (orgId: string, serviceId: string, limit = 20) =>
        sql<{
          id: string
          action: string
          result: string
          ip: string | null
          createdAt: Date
        }>`
          SELECT id, action, result, ip, created_at AS "createdAt"
          FROM audit_logs
          WHERE org_id = ${orgId} AND actor_type = 'service' AND actor_id = ${serviceId}
          ORDER BY created_at DESC LIMIT ${limit}`,

      /** Who/what read a given key (metadata.keyIds contains it, or target is the key). */
      keyAccess: (orgId: string, keyId: string, limit = 50) =>
        sql<{
          id: string
          actorType: string
          actorId: string | null
          result: string
          ip: string | null
          createdAt: Date
        }>`
          SELECT id, actor_type AS "actorType", actor_id AS "actorId", result, ip,
                 created_at AS "createdAt"
          FROM audit_logs
          WHERE org_id = ${orgId}
            AND (target_id = ${keyId} OR metadata->'keyIds' @> ${JSON.stringify([keyId])}::jsonb)
          ORDER BY created_at DESC LIMIT ${limit}`,
    }
  }),
}) {}
