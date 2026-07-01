import { Context } from "effect"
import type { Role } from "../errors"
import type { Service, User } from "../db/schema"

/** Resolved caller on the management plane (set by SessionAuth middleware). */
export interface CurrentUserData {
  readonly user: User
  readonly memberships: ReadonlyArray<{ readonly orgId: string; readonly role: Role }>
}
export class CurrentUser extends Context.Tag("cuki/CurrentUser")<CurrentUser, CurrentUserData>() {}

/** Resolved caller on the retrieval plane (set by ServiceTokenAuth middleware). */
export interface CurrentServiceData {
  readonly service: Service
  readonly scopeKeyIds: ReadonlyArray<string>
  readonly tokenId: string
  readonly orgId: string
}
export class CurrentService extends Context.Tag("cuki/CurrentService")<
  CurrentService,
  CurrentServiceData
>() {}

/** Per-request metadata for audit (client ip, user agent). */
export interface RequestMetaData {
  readonly ip: string | null
  readonly userAgent: string | null
}
export class RequestMeta extends Context.Tag("cuki/RequestMeta")<RequestMeta, RequestMetaData>() {}
