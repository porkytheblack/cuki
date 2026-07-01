import { useState } from "react"
import { api, type Role } from "../api"
import { fmtDate, useAsync } from "../ui"

const rank: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }
const ROLES: Role[] = ["viewer", "member", "admin", "owner"]

export function MembersView({ orgId, role }: { orgId: string; role: Role }) {
  const { data, error, loading, reload } = useAsync(() => api.listMembers(orgId), [orgId])
  const [email, setEmail] = useState("")
  const [newRole, setNewRole] = useState<Role>("member")
  const [err, setErr] = useState<string>()
  const canManage = rank[role] >= 2

  const add = async () => {
    setErr(undefined)
    try { await api.addMember(orgId, email, newRole); setEmail(""); reload() } catch (e: any) { setErr(e.message) }
  }

  return (
    <div>
      {canManage && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="l" style={{ marginBottom: 10 }}>ADD MEMBER (existing user by email)</div>
          <div className="row">
            <input className="grow mono" placeholder="person@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select style={{ width: 130 }} value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button className="primary" disabled={!email} onClick={add}>add</button>
          </div>
          {err && <div className="err">{err}</div>}
        </div>
      )}
      {error && <div className="err">{error}</div>}
      {loading ? <div className="empty"><span className="spin" /></div> : (
        <table>
          <thead><tr><th>name</th><th>email</th><th>role</th><th>joined</th><th className="right"></th></tr></thead>
          <tbody>
            {data?.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td className="mono muted">{m.email}</td>
                <td>
                  {canManage ? (
                    <select value={m.role} onChange={async (e) => { try { await api.updateMember(orgId, m.id, e.target.value as Role); reload() } catch (er: any) { setErr(er.message) } }} style={{ width: 120 }}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : <span className="chip">{m.role}</span>}
                </td>
                <td className="mono muted">{fmtDate(m.createdAt)}</td>
                <td className="right">
                  {canManage && <button className="sm danger" onClick={async () => { if (confirm(`Remove ${m.email}?`)) { try { await api.removeMember(orgId, m.id); reload() } catch (e: any) { setErr(e.message) } } }}>remove</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
