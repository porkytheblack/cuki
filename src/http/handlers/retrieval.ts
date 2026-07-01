import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { AuditService } from "../../domain/audit.service"
import { CurrentService } from "../../domain/context"
import { KeyService } from "../../domain/key.service"
import { api } from "../api"
import { clientMeta } from "../req"

/** Retrieval group: sealed secret delivery, audited on every read (design 05). */
export const RetrievalGroupLive = HttpApiBuilder.group(api, "retrieval", (handlers) =>
  Effect.gen(function* () {
    const keys = yield* KeyService
    const audit = yield* AuditService

    return handlers
      .handle("secrets", () =>
        Effect.gen(function* () {
          const cur = yield* CurrentService
          const meta = yield* clientMeta
          const result = yield* keys.readForService(
            cur.service.serviceId,
            cur.service.encPublicKey,
            cur.scopeKeyIds,
          )
          yield* audit.record({
            orgId: cur.orgId,
            actorType: "service",
            actorId: cur.service.serviceId,
            action: "secret.read",
            environmentId: cur.service.environmentId,
            result: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            metadata: { keyIds: result.keyIds, tokenId: cur.tokenId },
          })
          return result.envelope
        }),
      )
      .handle("secretByName", ({ path }) =>
        Effect.gen(function* () {
          const cur = yield* CurrentService
          const meta = yield* clientMeta
          const result = yield* keys
            .readForService(cur.service.serviceId, cur.service.encPublicKey, cur.scopeKeyIds, path.name)
            .pipe(
              Effect.tapError(() =>
                audit.record({
                  orgId: cur.orgId,
                  actorType: "service",
                  actorId: cur.service.serviceId,
                  action: "secret.read",
                  environmentId: cur.service.environmentId,
                  result: "denied",
                  ip: meta.ip,
                  userAgent: meta.userAgent,
                  metadata: { name: path.name, tokenId: cur.tokenId },
                }),
              ),
            )
          yield* audit.record({
            orgId: cur.orgId,
            actorType: "service",
            actorId: cur.service.serviceId,
            action: "secret.read",
            environmentId: cur.service.environmentId,
            result: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            metadata: { keyIds: result.keyIds, name: path.name, tokenId: cur.tokenId },
          })
          return result.envelope
        }),
      )
  }),
)
