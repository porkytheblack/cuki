import { Layer } from "effect"
import { DatabaseLive } from "../db/sql"
import { AccountRepo } from "./account.repo"
import { AuditRepo } from "./audit.repo"
import { AuthStateRepo } from "./authstate.repo"
import { HierarchyRepo } from "./hierarchy.repo"
import { KekVersionRepo } from "./kek.repo"
import { KeyRepo } from "./key.repo"
import { ServiceRepo } from "./service.repo"

export { AccountRepo, AuditRepo, AuthStateRepo, HierarchyRepo, KekVersionRepo, KeyRepo, ServiceRepo }

/**
 * All repositories, wired over the Drizzle/Postgres datastore (requires `AppConfig`).
 * `DatabaseLive` is `provideMerge`d so `SqlClient` + the Drizzle client are also exposed —
 * the migrator and boot sequence share the same pool.
 */
export const RepoLive = Layer.mergeAll(
  AccountRepo.Default,
  HierarchyRepo.Default,
  KeyRepo.Default,
  ServiceRepo.Default,
  AuthStateRepo.Default,
  AuditRepo.Default,
  KekVersionRepo.Default,
).pipe(Layer.provideMerge(DatabaseLive))
