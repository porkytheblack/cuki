import { useState } from "react"
import { api, type AuditLog } from "../api"
import { EmptyState, SkeletonTable, fmtDate, relTime } from "../ui"
import { useAsync } from "../ui"

const ACTOR_ICON: Record<string, string> = { service: "◆", user: "●", system: "▲" }

export function ActivityView({ orgId, environmentId }: { orgId: string; environmentId?: string }) {
  const [filters, setFilters] = useState<{ actorType?: string; result?: string; action?: string }>({})
  const q: Record<string, string> = {}
  if (environmentId) q.environmentId = environmentId
  if (filters.actorType) q.actorType = filters.actorType
  if (filters.result) q.result = filters.result
  if (filters.action) q.action = filters.action
  const { data, error, loading } = useAsync(() => api.audit(orgId, q), [orgId, environmentId, JSON.stringify(filters)])
  const [open, setOpen] = useState<string | null>(null)
  const hasFilters = !!(filters.actorType || filters.result || filters.action)

  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 16 }}>
        <select style={{ width: 150 }} value={filters.actorType ?? ""} onChange={(e) => setFilters((f) => ({ ...f, actorType: e.target.value || undefined }))}>
          <option value="">all actors</option>
          <option value="user">user</option>
          <option value="service">service</option>
          <option value="system">system</option>
        </select>
        <select style={{ width: 150 }} value={filters.result ?? ""} onChange={(e) => setFilters((f) => ({ ...f, result: e.target.value || undefined }))}>
          <option value="">all results</option>
          <option value="success">success</option>
          <option value="denied">denied</option>
          <option value="error">error</option>
        </select>
        <input style={{ width: 200 }} className="mono" placeholder="action (e.g. secret.read)" value={filters.action ?? ""} onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value || undefined }))} />
        {hasFilters && <button className="ghost sm" onClick={() => setFilters({})}>clear filters</button>}
        <span className="grow" />
        {data && <span className="muted mono small">{data.items.length} events{data.nextCursor ? "+" : ""}</span>}
      </div>
      {error && <div className="errbox">{error}</div>}

      {loading ? (
        <SkeletonTable rows={6} cols={5} />
      ) : data && data.items.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>time</th><th>actor</th><th>action</th><th>target</th><th>result</th><th>ip</th></tr></thead>
            <tbody>
              {data.items.map((a: AuditLog) => (
                <RowFor key={a.id} a={a} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState emoji="◷" title={hasFilters ? "No events match these filters" : "No activity yet"} hint={hasFilters ? "Try clearing the filters." : "Reads, writes, and auth events will appear here."} />
      )}
    </div>
  )
}

function RowFor({ a, open, onToggle }: { a: AuditLog; open: boolean; onToggle: () => void }) {
  const danger = a.result !== "success"
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer", background: danger ? "var(--danger-dim)" : undefined }} title="click to expand">
        <td className="mono muted" title={fmtDate(a.createdAt)}>{relTime(a.createdAt)}</td>
        <td className="mono">
          <span className="dim" style={{ marginRight: 6 }}>{ACTOR_ICON[a.actorType] ?? "•"}</span>
          {a.actorId ? a.actorId.slice(0, 16) : "—"}
        </td>
        <td className="mono">{a.action}</td>
        <td className="mono muted">{a.targetType ?? "—"}</td>
        <td><span className={"chip dot " + (danger ? "danger" : "ok")}>{a.result}</span></td>
        <td className="mono muted">{a.ip ?? "—"}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} style={{ background: "var(--bg)", padding: 0 }}>
            <pre className="codeblock" style={{ margin: 0, border: "none" }}>
              {JSON.stringify({ time: a.createdAt, metadata: a.metadata, userAgent: a.userAgent, targetId: a.targetId, actorId: a.actorId }, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  )
}
