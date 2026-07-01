import { useEffect, useRef, useState } from "react"
import { api, type KeyMeta, type KeyType, type Role } from "../api"
import { Copy, Drawer, fmtDate, useAsync } from "../ui"

const rank: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }
const REVEAL_TTL_MS = 30_000

export function KeysView({ envId, role, envProtected }: { envId: string; role: Role; envProtected: boolean }) {
  const { data, error, loading, reload } = useAsync(() => api.listKeys(envId), [envId])
  const [create, setCreate] = useState(false)
  const [detail, setDetail] = useState<KeyMeta | null>(null)
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null)
  const [revealErr, setRevealErr] = useState<string>()
  const hideTimer = useRef<number | undefined>(undefined)

  const clearReveal = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    setRevealed(null)
  }
  const doReveal = async (id: string) => {
    setRevealErr(undefined)
    try {
      const r = await api.revealKey(id)
      setRevealed({ id, value: r.value })
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
      // Don't leave plaintext on screen indefinitely — auto-hide after a short window.
      hideTimer.current = window.setTimeout(() => setRevealed(null), REVEAL_TTL_MS)
    } catch (e: any) {
      setRevealErr(e?.message ?? "reveal failed")
    }
  }
  // Clear any revealed secret + timer when leaving this environment/view.
  useEffect(() => () => { if (hideTimer.current) window.clearTimeout(hideTimer.current) }, [])
  useEffect(() => { clearReveal(); setRevealErr(undefined) }, [envId])

  const canWrite = rank[role] >= 1 && (!envProtected || rank[role] >= 2)
  const canReveal = rank[role] >= 2

  return (
    <div>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div className="muted mono" style={{ fontSize: 12 }}>{data?.length ?? 0} keys</div>
        {canWrite && <button className="primary" onClick={() => setCreate(true)}>+ New key</button>}
      </div>
      {error && <div className="err">{error}</div>}
      {revealErr && <div className="err">{revealErr}</div>}
      {loading ? (
        <div className="empty"><span className="spin" /></div>
      ) : data && data.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>name</th><th>type</th><th>version</th><th>value</th><th>updated</th><th className="right">actions</th>
            </tr>
          </thead>
          <tbody>
            {data.map((k) => (
              <tr key={k.id}>
                <td className="mono">{k.name}</td>
                <td><span className={"chip " + (k.type === "sensitive" ? "" : "accent")}>{k.type}</span></td>
                <td className="mono">v{k.currentVersion}</td>
                <td className="data" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {k.type === "public" ? (k.value ?? "") : (
                    revealed?.id === k.id ? <span style={{ color: "var(--warn)" }}>{revealed.value}</span> : "••••••••"
                  )}
                </td>
                <td className="mono muted">{fmtDate(k.updatedAt)}</td>
                <td className="right">
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    {k.type === "sensitive" && canReveal && (
                      revealed?.id === k.id
                        ? <button className="sm ghost" onClick={clearReveal}>hide</button>
                        : <button className="sm ghost" onClick={() => doReveal(k.id)}>reveal</button>
                    )}
                    <button className="sm ghost" onClick={() => setDetail(k)}>manage</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty">no keys yet — create your first key</div>
      )}

      {create && (
        <CreateKeyDrawer envId={envId} onClose={() => setCreate(false)} onDone={() => { setCreate(false); reload() }} />
      )}
      {detail && (
        <KeyDetailDrawer
          keyMeta={detail}
          canWrite={canWrite}
          onClose={() => setDetail(null)}
          onChanged={() => { reload() }}
          onDeleted={() => { setDetail(null); reload() }}
        />
      )}
    </div>
  )
}

function CreateKeyDrawer({ envId, onClose, onDone }: { envId: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("")
  const [type, setType] = useState<KeyType>("sensitive")
  const [value, setValue] = useState("")
  const [description, setDescription] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()

  const submit = async () => {
    setBusy(true); setErr(undefined)
    try {
      await api.createKey(envId, { name, type, value, description: description || undefined })
      onDone()
    } catch (e: any) { setErr(e.message); setBusy(false) }
  }

  return (
    <Drawer title="New key" onClose={onClose}>
      <div className="field">
        <label>name</label>
        <input className="mono" value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="DATABASE_URL" />
      </div>
      <div className="field">
        <label>type</label>
        <div className="row">
          <button className={type === "sensitive" ? "primary" : ""} onClick={() => setType("sensitive")}>sensitive</button>
          <button className={type === "public" ? "primary" : ""} onClick={() => setType("public")}>public (config)</button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {type === "sensitive" ? "encrypted at rest; masked in the dashboard." : "stored plaintext, visible in the dashboard."}
        </div>
      </div>
      <div className="field">
        <label>value</label>
        <textarea className="mono" rows={3} value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
      <div className="field">
        <label>description (optional)</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {err && <div className="err">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="ghost" onClick={onClose}>cancel</button>
        <button className="primary" disabled={busy || !name || !value} onClick={submit}>{busy ? "creating…" : "create key"}</button>
      </div>
    </Drawer>
  )
}

function KeyDetailDrawer({ keyMeta, canWrite, onClose, onChanged, onDeleted }: {
  keyMeta: KeyMeta; canWrite: boolean; onClose: () => void; onChanged: () => void; onDeleted: () => void
}) {
  const detail = useAsync(() => api.getKey(keyMeta.id), [keyMeta.id])
  const [newValue, setNewValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()

  const setValue = async () => {
    setBusy(true); setErr(undefined)
    try { await api.setKeyValue(keyMeta.id, newValue); setNewValue(""); detail.reload(); onChanged() }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const rollback = async (v: number) => {
    if (!confirm(`Roll back ${keyMeta.name} to v${v}?`)) return
    try { await api.rollbackKey(keyMeta.id, v); detail.reload(); onChanged() } catch (e: any) { setErr(e.message) }
  }
  const del = async () => {
    if (!confirm(`Delete ${keyMeta.name}? This cannot be undone.`)) return
    try { await api.deleteKey(keyMeta.id); onDeleted() } catch (e: any) { setErr(e.message) }
  }

  return (
    <Drawer title={keyMeta.name} onClose={onClose}>
      <div className="row" style={{ marginBottom: 16 }}>
        <span className={"chip " + (keyMeta.type === "public" ? "accent" : "")}>{keyMeta.type}</span>
        <span className="chip mono">v{keyMeta.currentVersion}</span>
      </div>
      {err && <div className="err">{err}</div>}

      {canWrite && (
        <div className="field">
          <label>set new value (creates a version)</label>
          <textarea className="mono" rows={2} value={newValue} onChange={(e) => setNewValue(e.target.value)} />
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
            <button className="primary sm" disabled={busy || !newValue} onClick={setValue}>save version</button>
          </div>
        </div>
      )}

      <hr className="sep" />
      <label>version history</label>
      <table>
        <thead><tr><th>version</th><th>created</th><th className="right"></th></tr></thead>
        <tbody>
          {detail.data?.versions.map((v) => (
            <tr key={v.version}>
              <td className="mono">{v.version === keyMeta.currentVersion ? <b>v{v.version} (current)</b> : `v${v.version}`}</td>
              <td className="mono muted">{fmtDate(v.createdAt)}</td>
              <td className="right">
                {canWrite && v.version !== keyMeta.currentVersion && (
                  <button className="sm ghost" onClick={() => rollback(v.version)}>rollback</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canWrite && (
        <>
          <hr className="sep" />
          <button className="danger" onClick={del}>delete key</button>
        </>
      )}
      <div style={{ marginTop: 12 }} className="muted mono">
        id <Copy text={keyMeta.id} label={keyMeta.id.slice(0, 10) + "…"} />
      </div>
    </Drawer>
  )
}
