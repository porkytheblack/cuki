import { useState } from "react"
import { api } from "../api"
import { Loading, useAsync } from "../ui"

export function AnalyticsView({ orgId }: { orgId: string }) {
  const { data, error, loading } = useAsync(() => api.analytics(orgId), [orgId])
  if (loading) return <Loading label="loading analytics" />
  if (error) return <div className="errbox">{error}</div>
  if (!data) return null

  const totalReads = data.readsPerDay.reduce((n, d) => n + d.count, 0)
  const peak = data.readsPerDay.reduce((m, d) => Math.max(m, d.count), 0)

  return (
    <div className="col" style={{ gap: 24 }}>
      <div className="cards">
        <Stat label="reads · 30d" value={totalReads} sub="secret.read events" />
        <Stat label="active services" value={data.topServices.length} sub="reading secrets" />
        <Stat label="keys read" value={data.topKeys.length} sub="distinct keys" />
        <Stat label="peak / day" value={peak} sub="busiest day" />
      </div>

      <div className="card">
        <div className="section-head" style={{ marginBottom: 8 }}>
          <div className="stat-l" style={{ fontSize: 11, letterSpacing: "0.06em", color: "var(--fg-muted)", textTransform: "uppercase" }}>Reads per day</div>
          <div className="muted mono small">last 30 days</div>
        </div>
        {data.readsPerDay.length > 0 ? (
          <AreaChart points={data.readsPerDay} />
        ) : (
          <div className="dim mono small" style={{ padding: "24px 0", textAlign: "center" }}>no reads recorded yet</div>
        )}
      </div>

      <div className="row" style={{ alignItems: "stretch", gap: 24 }}>
        <RankPanel
          title="Top services"
          empty="no service reads yet"
          rows={data.topServices.map((s) => ({ label: s.actorId ?? "—", value: s.count, mono: true }))}
        />
        <RankPanel
          title="Top keys"
          empty="no key reads yet"
          rows={data.topKeys.map((k) => ({ label: shortId(k.keyId), value: k.count, mono: true, full: k.keyId }))}
        />
      </div>
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="stat">
      <div className="accentbar" />
      <div className="l">{label}</div>
      <div className="n">{value.toLocaleString()}</div>
      <div className="sub">{sub}</div>
    </div>
  )
}

function RankPanel({
  title,
  rows,
  empty,
}: {
  title: string
  empty: string
  rows: { label: string; value: number; mono?: boolean; full?: string }[]
}) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className="card grow" style={{ minWidth: 0 }}>
      <div className="l" style={{ fontSize: 11, letterSpacing: "0.06em", color: "var(--fg-muted)", textTransform: "uppercase", marginBottom: 8 }}>{title}</div>
      {rows.length > 0 ? (
        rows.map((r, i) => (
          <div key={i} className="barrow">
            <div style={{ minWidth: 0 }}>
              <div className={"lab" + (r.mono ? " mono" : "")} title={r.full ?? r.label}>{r.label}</div>
              <div className="barmeter"><span style={{ width: `${(r.value / max) * 100}%` }} /></div>
            </div>
            <div className="val">{r.value.toLocaleString()}</div>
          </div>
        ))
      ) : (
        <div className="dim mono small" style={{ padding: "12px 0" }}>{empty}</div>
      )}
    </div>
  )
}

/** Single-series area+line over time: recessive grid, one accent hue, hover crosshair+tooltip. */
function AreaChart({ points }: { points: { day: string; count: number }[] }) {
  const W = 760
  const H = 190
  const PAD = { l: 6, r: 6, t: 14, b: 22 }
  const iw = W - PAD.l - PAD.r
  const ih = H - PAD.t - PAD.b
  const n = points.length
  const max = Math.max(1, ...points.map((p) => p.count))
  const x = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
  const y = (v: number) => PAD.t + ih - (v / max) * ih
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.count).toFixed(1)}`).join(" ")
  const area = `${line} L${x(n - 1).toFixed(1)},${(PAD.t + ih).toFixed(1)} L${x(0).toFixed(1)},${(PAD.t + ih).toFixed(1)} Z`
  const [hover, setHover] = useState<number | null>(null)
  const hp = hover != null ? points[hover] : undefined

  const labelIdx = Array.from(new Set([0, Math.floor((n - 1) / 2), n - 1])).filter((i) => i >= 0)

  return (
    <div style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ display: "block", overflow: "visible" }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const px = ((e.clientX - rect.left) / rect.width) * W
          let idx = n <= 1 ? 0 : Math.round(((px - PAD.l) / iw) * (n - 1))
          idx = Math.max(0, Math.min(n - 1, idx))
          setHover(idx)
        }}
      >
        {[0, 0.5, 1].map((t) => (
          <line key={t} className="chart-grid" x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih - t * ih} y2={PAD.t + ih - t * ih} />
        ))}
        <path className="chart-area" d={area} />
        <path className="chart-line" d={line} />
        {hp && (
          <>
            <line className="chart-grid" style={{ opacity: 0.9 }} x1={x(hover!)} x2={x(hover!)} y1={PAD.t} y2={PAD.t + ih} />
            <circle className="chart-dot" cx={x(hover!)} cy={y(hp.count)} r={3.5} />
          </>
        )}
        {labelIdx.map((i) => (
          <text key={i} className="chart-label" x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
            {points[i]?.day.slice(5)}
          </text>
        ))}
      </svg>
      {hp && (
        <div
          className="tooltip"
          style={{ position: "absolute", left: `${(x(hover!) / W) * 100}%`, top: -2, transform: "translateX(-50%)" }}
        >
          {hp.day} · {hp.count} {hp.count === 1 ? "read" : "reads"}
        </div>
      )}
    </div>
  )
}

const shortId = (id: string) => (id.length > 18 ? id.slice(0, 16) + "…" : id)
