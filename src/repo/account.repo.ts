import { SqlClient } from "@effect/sql"
import { and, eq, lt } from "drizzle-orm"
import { Effect } from "effect"
import type { Role } from "../errors"
import { Database } from "../db/sql"
import * as s from "../db/schema"
import { head } from "./util"

/** Users, sessions, organizations, memberships — the management-plane identity + tenancy. */
export class AccountRepo extends Effect.Service<AccountRepo>()("AccountRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Database
    const sql = yield* SqlClient.SqlClient

    return {
      // ── users ──
      createUser: (u: typeof s.users.$inferInsert) =>
        db.insert(s.users).values(u).returning().pipe(Effect.map(head)),

      findUserByEmail: (email: string) =>
        db.select().from(s.users).where(eq(s.users.email, email)).pipe(Effect.map(head)),

      findUserById: (id: string) =>
        db.select().from(s.users).where(eq(s.users.id, id)).pipe(Effect.map(head)),

      // ── sessions ──
      createSession: (row: typeof s.sessions.$inferInsert) => db.insert(s.sessions).values(row),

      findSessionByHash: (tokenHash: Uint8Array) =>
        db
          .select({ session: s.sessions, user: s.users })
          .from(s.sessions)
          .innerJoin(s.users, eq(s.sessions.userId, s.users.id))
          .where(eq(s.sessions.tokenHash, tokenHash))
          .pipe(Effect.map(head)),

      deleteSessionByHash: (tokenHash: Uint8Array) =>
        db.delete(s.sessions).where(eq(s.sessions.tokenHash, tokenHash)),

      deleteExpiredSessions: (now: Date) =>
        db.delete(s.sessions).where(lt(s.sessions.expiresAt, now)),

      // ── organizations ──
      createOrg: (row: typeof s.organizations.$inferInsert) =>
        db.insert(s.organizations).values(row).returning().pipe(Effect.map(head)),

      findOrgById: (id: string) =>
        db.select().from(s.organizations).where(eq(s.organizations.id, id)).pipe(Effect.map(head)),

      /** Orgs the user belongs to, with the user's role in each. */
      listOrgsForUser: (userId: string) =>
        db
          .select({ org: s.organizations, role: s.memberships.role })
          .from(s.organizations)
          .innerJoin(s.memberships, eq(s.memberships.orgId, s.organizations.id))
          .where(eq(s.memberships.userId, userId)),

      // ── memberships ──
      createMembership: (row: typeof s.memberships.$inferInsert) =>
        db.insert(s.memberships).values(row).returning().pipe(Effect.map(head)),

      /** The caller's role in an org — the core RBAC lookup. */
      findMembership: (orgId: string, userId: string) =>
        db
          .select()
          .from(s.memberships)
          .where(and(eq(s.memberships.orgId, orgId), eq(s.memberships.userId, userId)))
          .pipe(Effect.map(head)),

      findMembershipById: (id: string) =>
        db.select().from(s.memberships).where(eq(s.memberships.id, id)).pipe(Effect.map(head)),

      listMembers: (orgId: string) =>
        db
          .select({
            id: s.memberships.id,
            role: s.memberships.role,
            userId: s.users.id,
            email: s.users.email,
            name: s.users.name,
            createdAt: s.memberships.createdAt,
          })
          .from(s.memberships)
          .innerJoin(s.users, eq(s.memberships.userId, s.users.id))
          .where(eq(s.memberships.orgId, orgId)),

      updateMemberRole: (id: string, role: Role) =>
        db
          .update(s.memberships)
          .set({ role })
          .where(eq(s.memberships.id, id))
          .returning()
          .pipe(Effect.map(head)),

      deleteMembership: (id: string) => db.delete(s.memberships).where(eq(s.memberships.id, id)),

      /** Create an org and its first membership (owner) atomically. */
      createOrgWithOwner: (
        org: typeof s.organizations.$inferInsert,
        membership: typeof s.memberships.$inferInsert,
      ) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* db.insert(s.organizations).values(org)
            yield* db.insert(s.memberships).values(membership)
          }),
        ),
    }
  }),
}) {}
