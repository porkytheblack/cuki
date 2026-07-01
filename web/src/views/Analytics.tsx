import { api } from "../api"
import { useAsync } from "../ui"

export function AnalyticsView({ orgId }: { orgId: string }) {
  const { data, error, loading } = useAsync(() => api.analytics(orgId), [orgId])
  if (loading) return <div className="empty"><span className="spin" /></div>
  if (error) return <div className="err">{error}</div>
  if (!data) return null

  const totalReads = data.readsPerDay.reduce((n, d) => n + d.count, 0)
  const maxDay = Math.max(1, ...data.readsPerDay.map((d) => d.count))

  return (
    <div className="col" style={{ gap: 24 }}>
      <div className="cards">
        <div className="stat"><div className="n">{totalReads}</div><div className="l">reads (30d)</div></div>
        <div className="stat"><div className="n">{data.topServices.length}</div><div className="l">active services</div></div>
        <div className="stat"><div className="n">{data.topKeys.length}</div><div className="l">keys read</div></div>
      </div>

      <div className="card">
        <div className="l" style={{ marginBottom: 12 }}>READS PER DAY</div>
        {data.readsPerDay.length === 0 ? <div className="dim mono">no reads yet</div> : (
          <div className="col" style={{ gap: 6 }}>
            {data.readsPerDay.map((d) => (
              <div key={d.day} className="row">
                <span className="mono muted" style={{ width: 90, fontSize: 12 }}>{d.day}</span>
                <div className="bartrack grow"><div className="bar" style={{ width: `${(d.count / maxDay) * 100}%` }} /></div>
                <span className="mono" style={{ width: 40, textAlign: "right" }}>{d.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="row" style={{ alignItems: "flex-start", gap: 24 }}>
        <div className="card grow">
          <div className="l" style={{ marginBottom: 12 }}>TOP SERVICES</div>
          <table>
            <thead><tr><th>service_id</th><th className="right">reads</th></tr></thead>
            <tbody>
              {data.topServices.length ? data.topServices.map((s) => (
                <tr key={s.actorId ?? "?"}><td className="data">{s.actorId ?? "—"}</td><td className="right mono">{s.count}</td></tr>
              )) : <tr><td colSpan={2} className="dim mono">no data</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="card grow">
          <div className="l" style={{ marginBottom: 12 }}>TOP KEYS</div>
          <table>
            <thead><tr><th>key id</th><th className="right">reads</th></tr></thead>
            <tbody>
              {data.topKeys.length ? data.topKeys.map((k) => (
                <tr key={k.keyId}><td className="data">{k.keyId.slice(0, 16)}…</td><td className="right mono">{k.count}</td></tr>
              )) : <tr><td colSpan={2} className="dim mono">no data</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
