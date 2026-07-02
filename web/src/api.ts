// Typed client for the cuki management API. Same-origin; session via HttpOnly cookie.

export interface User { id: string; email: string; name: string; createdAt: string }
export interface Membership { orgId: string; role: Role }
export type Role = "owner" | "admin" | "member" | "viewer"
export interface Me { user: User; memberships: Membership[] }
export interface Org { id: string; name: string; slug: string; role: Role; createdAt: string }
export interface Member { id: string; userId: string; email: string; name: string; role: Role; createdAt: string }
export interface Project { id: string; orgId: string; name: string; slug: string; createdAt: string }
export interface Environment { id: string; projectId: string; name: string; slug: string; protected: boolean; createdAt: string }
export type KeyType = "sensitive" | "public"
export interface KeyMeta {
  id: string; name: string; type: KeyType; currentVersion: number
  description: string | null; updatedAt: string; updatedBy: string | null; value: string | null
}
export interface KeyVersion { version: number; createdBy: string | null; createdAt: string }
export interface KeyDetail { key: KeyMeta; versions: KeyVersion[] }
export interface Service {
  id: string; environmentId: string; name: string; serviceId: string
  status: "active" | "revoked"; ipAllowlist: string[] | null; lastAuthAt: string | null
  grants: number; createdAt: string
}
export interface ServiceCreated { service: Service; privateKey: string }
export interface Grant { id: string; keyId: string; keyName: string; keyType: KeyType; createdAt: string }
export interface AuditLog {
  id: string; actorType: string; actorId: string | null; action: string
  environmentId: string | null; targetType: string | null; targetId: string | null
  metadata: Record<string, unknown> | null; ip: string | null; userAgent: string | null
  result: "success" | "denied" | "error"; createdAt: string
}
export interface Analytics {
  readsPerDay: { day: string; count: number }[]
  topServices: { actorId: string | null; count: number }[]
  topKeys: { keyId: string; count: number }[]
}

export class ApiError extends Error {
  constructor(public status: number, public tag: string, message: string) {
    super(message)
  }
}

const readCookie = (name: string): string | undefined =>
  document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(name + "="))
    ?.slice(name.length + 1)

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"])

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers["content-type"] = "application/json"
  // Double-submit CSRF: echo the readable csrf cookie on state-changing requests.
  if (MUTATING.has(method)) {
    const csrf = readCookie("cuki_csrf")
    if (csrf) headers["x-csrf-token"] = decodeURIComponent(csrf)
  }
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: Object.keys(headers).length ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const data = text ? JSON.parse(text) : undefined
  if (!res.ok) {
    const tag = data?._tag ?? "Error"
    const msg = data?.message ?? data?.reason ?? tag
    throw new ApiError(res.status, tag, msg)
  }
  return data as T
}

export const api = {
  register: (b: { email: string; name: string; password: string }) => req<Me>("POST", "/v1/auth/register", b),
  login: (b: { email: string; password: string }) => req<Me>("POST", "/v1/auth/login", b),
  logout: () => req<void>("POST", "/v1/auth/logout"),
  me: () => req<Me>("GET", "/v1/auth/me"),

  listOrgs: () => req<Org[]>("GET", "/v1/orgs"),
  createOrg: (name: string) => req<Org>("POST", "/v1/orgs", { name }),

  listMembers: (orgId: string) => req<Member[]>("GET", `/v1/orgs/${orgId}/members`),
  addMember: (orgId: string, email: string, role: Role) => req<Member>("POST", `/v1/orgs/${orgId}/members`, { email, role }),
  updateMember: (orgId: string, id: string, role: Role) => req<Member>("PATCH", `/v1/orgs/${orgId}/members/${id}`, { role }),
  removeMember: (orgId: string, id: string) => req<void>("DELETE", `/v1/orgs/${orgId}/members/${id}`),

  listProjects: (orgId: string) => req<Project[]>("GET", `/v1/orgs/${orgId}/projects`),
  createProject: (orgId: string, name: string) => req<Project>("POST", `/v1/orgs/${orgId}/projects`, { name }),
  deleteProject: (id: string) => req<void>("DELETE", `/v1/projects/${id}`),

  listEnvironments: (projectId: string) => req<Environment[]>("GET", `/v1/projects/${projectId}/environments`),
  createEnvironment: (projectId: string, name: string, isProtected: boolean) =>
    req<Environment>("POST", `/v1/projects/${projectId}/environments`, { name, protected: isProtected }),
  deleteEnvironment: (id: string) => req<void>("DELETE", `/v1/environments/${id}`),

  listKeys: (envId: string) => req<KeyMeta[]>("GET", `/v1/environments/${envId}/keys`),
  createKey: (envId: string, b: { name: string; type: KeyType; value: string; description?: string }) =>
    req<KeyMeta>("POST", `/v1/environments/${envId}/keys`, b),
  getKey: (id: string) => req<KeyDetail>("GET", `/v1/keys/${id}`),
  setKeyValue: (id: string, value: string) => req<KeyMeta>("PUT", `/v1/keys/${id}`, { value }),
  deleteKey: (id: string) => req<void>("DELETE", `/v1/keys/${id}`),
  revealKey: (id: string) => req<{ value: string }>("POST", `/v1/keys/${id}/reveal`),
  rollbackKey: (id: string, version: number) => req<KeyMeta>("POST", `/v1/keys/${id}/rollback`, { version }),
  keyAccess: (id: string) => req<AuditLog[]>("GET", `/v1/keys/${id}/access`),

  listServices: (envId: string) => req<Service[]>("GET", `/v1/environments/${envId}/services`),
  createService: (envId: string, name: string, ipAllowlist?: string[]) =>
    req<ServiceCreated>("POST", `/v1/environments/${envId}/services`, ipAllowlist ? { name, ipAllowlist } : { name }),
  rotateServiceKey: (id: string) => req<{ privateKey: string }>("POST", `/v1/services/${id}/rotate-key`),
  revokeService: (id: string) => req<Service>("POST", `/v1/services/${id}/revoke`),
  deleteService: (id: string) => req<void>("DELETE", `/v1/services/${id}`),
  listGrants: (id: string) => req<Grant[]>("GET", `/v1/services/${id}/grants`),
  addGrants: (id: string, keyIds: string[]) => req<Grant[]>("POST", `/v1/services/${id}/grants`, { keyIds }),
  deleteGrant: (id: string) => req<void>("DELETE", `/v1/grants/${id}`),
  serviceActivity: (id: string) => req<{ id: string; action: string; result: string; ip: string | null; createdAt: string }[]>("GET", `/v1/services/${id}/activity`),

  audit: (orgId: string, q: Record<string, string>) => {
    const qs = new URLSearchParams(q).toString()
    return req<{ items: AuditLog[]; nextCursor: string | null }>("GET", `/v1/orgs/${orgId}/audit${qs ? "?" + qs : ""}`)
  },
  analytics: (orgId: string) => req<Analytics>("GET", `/v1/orgs/${orgId}/analytics/access`),
}
