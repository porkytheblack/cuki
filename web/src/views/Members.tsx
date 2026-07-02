import { useState } from "react"
import { api, type Role } from "../api"
import { useConfirm, useToast } from "../feedback"
import { SkeletonTable, fmtDate, useAsync } from "../ui"

const rank: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }
const ROLES: Role[] = ["viewer", "member", "admin", "owner"]

export function MembersView({ orgId, role }: { orgId: string; role: Role }) {
  const { data, error, loading, reload } = useAsync(() => api.listMembers(orgId), [orgId])
  const [email, setEmail] = useState("")
  const [newRole, setNewRole] = useState<Role>("member")
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const confirm = useConfirm()
  const canManage = rank[role] >= 2

  const add = async () => {
    if (!email.trim()) return
    setBusy(true)
    try {
      await api.addMember(orgId, email.trim(), newRole)
      setEmail("")
      reload()
      toast.success(`Added ${email.trim()} as ${newRole}`)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  const changeRole = async (id: string, r: Role, name: string) => {
    try { await api.updateMember(orgId, id, r); reload(); toast.success(`${name} is now ${r}`) }
    catch (e: any) { toast.error(e.message); reload() }
  }

  const remove = async (id: string, who: string) => {
    if (!(await confirm({ title: "Remove member", message: <>Remove <b>{who}</b> from this organization?</>, confirmLabel: "Remove", danger: true }))) return
    try { await api.removeMember(orgId, id); reload(); toast.success(`Removed ${who}`) }
    catch (e: any) { toast.error(e.message) }
  }

  return (
    <div>
      {canManage && (
        <div className="card" style={{ marginBottom: 16 }}>
          <label>Add an existing user by email</label>
          <div className="row">
            <input
              className="grow mono"
              placeholder="person@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <select style={{ width: 140 }} value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button className="primary" disabled={!email.trim() || busy} onClick={add}>{busy ? "Adding…" : "Add"}</button>
          </div>
          <div className="hint">Owner role can only be granted by an owner.</div>
        </div>
      )}
      {error && <div className="errbox">{error}</div>}

      {loading ? (
        <SkeletonTable rows={4} cols={4} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>name</th><th>email</th><th>role</th><th>joined</th><th className="right"></th></tr></thead>
            <tbody>
              {data?.map((m) => (
                <tr key={m.id}>
                  <td style={{ fontWeight: 500 }}>{m.name}</td>
                  <td className="mono muted">{m.email}</td>
                  <td>
                    {canManage ? (
                      <select value={m.role} onChange={(e) => changeRole(m.id, e.target.value as Role, m.name)} style={{ width: 130 }}>
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    ) : <span className="chip">{m.role}</span>}
                  </td>
                  <td className="mono muted">{fmtDate(m.createdAt)}</td>
                  <td>
                    <div className="rowactions">
                      {canManage && <button className="sm danger" onClick={() => remove(m.id, m.email)}>remove</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
