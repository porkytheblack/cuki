import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "@effect/platform"
import { Schema } from "effect"
import { CurrentService, CurrentUser } from "../domain/context"
import * as E from "../errors"
import * as S from "./schemas"

/** Security schemes: session cookie (management), bearer access token (retrieval). */
export const sessionCookie = HttpApiSecurity.apiKey({ in: "cookie", key: "cuki_session" })
export const serviceBearer = HttpApiSecurity.bearer
/** Double-submit CSRF cookie (readable by JS; echoed in X-CSRF-Token on mutating requests). */
export const csrfCookie = HttpApiSecurity.apiKey({ in: "cookie", key: "cuki_csrf" })

/** Resolves `CurrentUser` from the session cookie (design 05). */
export class SessionAuth extends HttpApiMiddleware.Tag<SessionAuth>()("cuki/SessionAuth", {
  provides: CurrentUser,
  failure: E.Unauthorized,
  security: { cookie: sessionCookie },
}) {}

/** Resolves `CurrentService` + scope from the bearer access token (design 05). */
export class ServiceTokenAuth extends HttpApiMiddleware.Tag<ServiceTokenAuth>()(
  "cuki/ServiceTokenAuth",
  {
    provides: CurrentService,
    failure: E.Unauthorized,
    security: { bearer: serviceBearer },
  },
) {}

// Path/param helpers
const IdParam = Schema.Struct({ id: Schema.String })
const OrgIdParam = Schema.Struct({ orgId: Schema.String })
const OrgMemberParam = Schema.Struct({ orgId: Schema.String, id: Schema.String })
const NameParam = Schema.Struct({ name: Schema.String })
const NoContent = Schema.Void

// ── auth group ──
const authGroup = HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.post("register", "/v1/auth/register")
      .setPayload(S.RegisterRequest)
      .addSuccess(S.MeDto)
      .addError(E.Conflict),
  )
  .add(
    HttpApiEndpoint.post("login", "/v1/auth/login")
      .setPayload(S.LoginRequest)
      .addSuccess(S.MeDto)
      .addError(E.Unauthorized),
  )
  .add(
    HttpApiEndpoint.post("logout", "/v1/auth/logout")
      .addSuccess(NoContent, { status: 204 })
      .middleware(SessionAuth),
  )
  .add(HttpApiEndpoint.get("me", "/v1/auth/me").addSuccess(S.MeDto).middleware(SessionAuth))
  .add(
    HttpApiEndpoint.post("challenge", "/v1/auth/challenge")
      .setPayload(S.ChallengeRequest)
      .addSuccess(S.ChallengeDto)
      .addError(E.Unauthorized)
      .addError(E.RateLimited),
  )
  .add(
    HttpApiEndpoint.post("token", "/v1/auth/token")
      .setPayload(S.TokenRequest)
      .addSuccess(S.TokenDto)
      .addError(E.Unauthorized)
      .addError(E.RateLimited),
  )

// ── management group (SessionAuth) ──
const managementGroup = HttpApiGroup.make("management")
  // orgs
  .add(HttpApiEndpoint.get("listOrgs", "/v1/orgs").addSuccess(Schema.Array(S.OrgDto)))
  .add(
    HttpApiEndpoint.post("createOrg", "/v1/orgs")
      .setPayload(S.CreateOrgRequest)
      .addSuccess(S.OrgDto)
      .addError(E.Conflict),
  )
  // members
  .add(
    HttpApiEndpoint.get("listMembers", "/v1/orgs/:orgId/members")
      .setPath(OrgIdParam)
      .addSuccess(Schema.Array(S.MemberDto))
      .addError(E.Forbidden),
  )
  .add(
    HttpApiEndpoint.post("addMember", "/v1/orgs/:orgId/members")
      .setPath(OrgIdParam)
      .setPayload(S.AddMemberRequest)
      .addSuccess(S.MemberDto)
      .addError(E.Forbidden)
      .addError(E.NotFound)
      .addError(E.Conflict),
  )
  .add(
    HttpApiEndpoint.patch("updateMember", "/v1/orgs/:orgId/members/:id")
      .setPath(OrgMemberParam)
      .setPayload(S.UpdateMemberRequest)
      .addSuccess(S.MemberDto)
      .addError(E.Forbidden)
      .addError(E.NotFound)
      .addError(E.Conflict),
  )
  .add(
    HttpApiEndpoint.del("removeMember", "/v1/orgs/:orgId/members/:id")
      .setPath(OrgMemberParam)
      .addSuccess(NoContent, { status: 204 })
      .addError(E.Forbidden)
      .addError(E.NotFound)
      .addError(E.Conflict),
  )
  // projects
  .add(
    HttpApiEndpoint.get("listProjects", "/v1/orgs/:orgId/projects")
      .setPath(OrgIdParam)
      .addSuccess(Schema.Array(S.ProjectDto))
      .addError(E.Forbidden),
  )
  .add(
    HttpApiEndpoint.post("createProject", "/v1/orgs/:orgId/projects")
      .setPath(OrgIdParam)
      .setPayload(S.CreateProjectRequest)
      .addSuccess(S.ProjectDto)
      .addError(E.Forbidden)
      .addError(E.Conflict),
  )
  .add(
    HttpApiEndpoint.del("deleteProject", "/v1/projects/:id")
      .setPath(IdParam)
      .addSuccess(NoContent, { status: 204 })
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  // environments
  .add(
    HttpApiEndpoint.get("listEnvironments", "/v1/projects/:id/environments")
      .setPath(IdParam)
      .addSuccess(Schema.Array(S.EnvironmentDto))
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  .add(
    HttpApiEndpoint.post("createEnvironment", "/v1/projects/:id/environments")
      .setPath(IdParam)
      .setPayload(S.CreateEnvironmentRequest)
      .addSuccess(S.EnvironmentDto)
      .addError(E.Forbidden)
      .addError(E.NotFound)
      .addError(E.Conflict),
  )
  .add(
    HttpApiEndpoint.del("deleteEnvironment", "/v1/environments/:id")
      .setPath(IdParam)
      .addSuccess(NoContent, { status: 204 })
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  // keys
  .add(
    HttpApiEndpoint.get("listKeys", "/v1/environments/:id/keys")
      .setPath(IdParam)
      .addSuccess(Schema.Array(S.KeyMetaDto))
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  .add(
    HttpApiEndpoint.post("createKey", "/v1/environments/:id/keys")
      .setPath(IdParam)
      .setPayload(S.CreateKeyRequest)
      .addSuccess(S.KeyMetaDto)
      .addError(E.Forbidden)
      .addError(E.NotFound)
      .addError(E.Conflict),
  )
  .add(
    HttpApiEndpoint.get("getKey", "/v1/keys/:id")
      .setPath(IdParam)
      .addSuccess(S.KeyDetailDto)
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  .add(
    HttpApiEndpoint.put("setKeyValue", "/v1/keys/:id")
      .setPath(IdParam)
      .setPayload(S.SetKeyValueRequest)
      .addSuccess(S.KeyMetaDto)
      .addError(E.Forbidden)
      .addError(E.NotFound)
      .addError(E.Conflict),
  )
  .add(
    HttpApiEndpoint.del("deleteKey", "/v1/keys/:id")
      .setPath(IdParam)
      .addSuccess(NoContent, { status: 204 })
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  .add(
    HttpApiEndpoint.post("revealKey", "/v1/keys/:id/reveal")
      .setPath(IdParam)
      .addSuccess(S.RevealDto)
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  .add(
    HttpApiEndpoint.post("rollbackKey", "/v1/keys/:id/rollback")
      .setPath(IdParam)
      .setPayload(S.RollbackRequest)
      .addSuccess(S.KeyMetaDto)
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  .add(
    HttpApiEndpoint.get("keyAccess", "/v1/keys/:id/access")
      .setPath(IdParam)
      .addSuccess(S.KeyAccessDto)
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  // services
  .add(
    HttpApiEndpoint.get("listServices", "/v1/environments/:id/services")
      .setPath(IdParam)
      .addSuccess(Schema.Array(S.ServiceDto))
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  .add(
    HttpApiEndpoint.post("createService", "/v1/environments/:id/services")
      .setPath(IdParam)
      .setPayload(S.CreateServiceRequest)
      .addSuccess(S.ServiceCreatedDto)
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  .add(
    HttpApiEndpoint.post("rotateServiceKey", "/v1/services/:id/rotate-key")
      .setPath(IdParam)
      .addSuccess(S.PrivateKeyDto)
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  .add(
    HttpApiEndpoint.post("revokeService", "/v1/services/:id/revoke")
      .setPath(IdParam)
      .addSuccess(S.ServiceDto)
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  .add(
    HttpApiEndpoint.del("deleteService", "/v1/services/:id")
      .setPath(IdParam)
      .addSuccess(NoContent, { status: 204 })
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  .add(
    HttpApiEndpoint.get("listGrants", "/v1/services/:id/grants")
      .setPath(IdParam)
      .addSuccess(Schema.Array(S.GrantDto))
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  .add(
    HttpApiEndpoint.post("addGrants", "/v1/services/:id/grants")
      .setPath(IdParam)
      .setPayload(S.AddGrantsRequest)
      .addSuccess(Schema.Array(S.GrantDto))
      .addError(E.Forbidden)
      .addError(E.NotFound)
      .addError(E.Conflict),
  )
  .add(
    HttpApiEndpoint.del("deleteGrant", "/v1/grants/:id")
      .setPath(IdParam)
      .addSuccess(NoContent, { status: 204 })
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  .add(
    HttpApiEndpoint.get("serviceActivity", "/v1/services/:id/activity")
      .setPath(IdParam)
      .addSuccess(S.ServiceActivityDto)
      .addError(E.Forbidden)
      .addError(E.NotFound),
  )
  // audit + analytics
  .add(
    HttpApiEndpoint.get("audit", "/v1/orgs/:orgId/audit")
      .setPath(OrgIdParam)
      .setUrlParams(S.AuditQuery)
      .addSuccess(S.PaginatedAuditDto)
      .addError(E.Forbidden),
  )
  .add(
    HttpApiEndpoint.get("analytics", "/v1/orgs/:orgId/analytics/access")
      .setPath(OrgIdParam)
      .setUrlParams(S.AnalyticsQuery)
      .addSuccess(S.AnalyticsDto)
      .addError(E.Forbidden),
  )
  .middleware(SessionAuth)

// ── retrieval group (ServiceTokenAuth) ──
const retrievalGroup = HttpApiGroup.make("retrieval")
  .add(
    HttpApiEndpoint.get("secrets", "/v1/secrets")
      .addSuccess(S.SealedEnvelopeDto)
      .addError(E.NotFound),
  )
  .add(
    HttpApiEndpoint.get("secretByName", "/v1/secrets/:name")
      .setPath(NameParam)
      .addSuccess(S.SealedEnvelopeDto)
      .addError(E.NotFound),
  )
  .middleware(ServiceTokenAuth)

export const api = HttpApi.make("cuki")
  .add(authGroup)
  .add(managementGroup)
  .add(retrievalGroup)
  .addError(E.ValidationError)
