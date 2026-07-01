import { Effect } from "effect"
import { AuditRepo, type AuditFilter } from "../repo/audit.repo"
import { dieSqlApi } from "../util/effect"
import { newId } from "../util/id"

export interface AuditEntry {
  readonly orgId: string
  readonly actorType: "user" | "service" | "system"
  readonly actorId?: string | null
  readonly action: string
  readonly environmentId?: string | null
  readonly targetType?: string | null
  readonly targetId?: string | null
  readonly metadata?: Record<string, unknown> | null
  readonly ip?: string | null
  readonly userAgent?: string | null
  readonly result: "success" | "denied" | "error"
}

/**
 * Append-only audit + analytics (design 05/07). `record` never fails the caller — an audit
 * write error is logged, not propagated, so a logging hiccup can't break a secret read.
 */
export class AuditService extends Effect.Service<AuditService>()("AuditService", {
  effect: Effect.gen(function* () {
    const repo = yield* AuditRepo

    return dieSqlApi({
      record: (entry: AuditEntry) =>
        repo
          .append({
            id: newId(),
            orgId: entry.orgId,
            actorType: entry.actorType,
            actorId: entry.actorId ?? null,
            action: entry.action,
            environmentId: entry.environmentId ?? null,
            targetType: entry.targetType ?? null,
            targetId: entry.targetId ?? null,
            metadata: entry.metadata ?? null,
            ip: entry.ip ?? null,
            userAgent: entry.userAgent ?? null,
            result: entry.result,
          })
          .pipe(
            Effect.catchAll((e) => Effect.logError("audit append failed", e)),
          ),

      query: (orgId: string, filter: AuditFilter) => repo.query(orgId, filter),
      readsPerDay: (orgId: string, from: Date, to: Date) => repo.readsPerDay(orgId, from, to),
      topServices: (orgId: string, from: Date, to: Date, limit?: number) =>
        repo.topServices(orgId, from, to, limit),
      topKeys: (orgId: string, from: Date, to: Date, limit?: number) =>
        repo.topKeys(orgId, from, to, limit),
      serviceActivity: (orgId: string, serviceId: string, limit?: number) =>
        repo.serviceActivity(orgId, serviceId, limit),
      keyAccess: (orgId: string, keyId: string, limit?: number) =>
        repo.keyAccess(orgId, keyId, limit),
    })
  }),
}) {}
