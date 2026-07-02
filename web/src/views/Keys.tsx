import { useEffect, useRef, useState } from "react"
import { api, type KeyMeta, type KeyType, type Role } from "../api"
import { useConfirm, useToast } from "../feedback"
import { Copy, Drawer, EmptyState, SkeletonTable, fmtDate, useAsync } from "../ui"

const rank: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }
const REVEAL_TTL_MS = 30_000

export function KeysView({ envId, role, envProtected }: { envId: string; role: Role; envProtected: boolean }) {
  const { data, error, loading, reload } = useAsync(() => api.listKeys(envId), [envId])
  const [create, setCreate] = useState(false)
  const [detail, setDetail] = useState<KeyMeta | null>(null)
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null)
  const hideTimer = useRef<number | undefined>(undefined)
  const toast = useToast()

  const clearReveal = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    setRevealed(null)
  }
  const doReveal = async (id: string, name: string) => {
    try {
      const r = await api.revealKey(id)
      setRevealed({ id, value: r.value })
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
      hideTimer.current = window.setTimeout(() => setRevealed(null), REVEAL_TTL_MS)
      toast.info(`Revealed ${name} — auto-hides in 30s (this was audited)`)
    } catch (e: any) {
      toast.error(e?.message ?? "reveal failed")
    }
  }
  useEffect(() => () => { if (hideTimer.current) window.clearTimeout(hideTimer.current) }, [])
  useEffect(() => { clearReveal() }, [envId])

  const canWrite = rank[role] >= 1 && (!envProtected || rank[role] >= 2)
  const canReveal = rank[role] >= 2

  return (
    <div>
      <div className="section-head">
        <div className="muted mono small">{data ? `${data.length} ${data.length === 1 ? "key" : "keys"}` : ""}</div>
        {canWrite && <button className="primary" onClick={() => setCreate(true)}>+ New key</button>}
      </div>
      {error && <div className="errbox">{error}</div>}

      {loading ? (
        <SkeletonTable rows={4} cols={5} />
      ) : data && data.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>name</th><th>type</th><th>version</th><th>value</th><th>updated</th><th className="right">actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((k) => (
                <tr key={k.id}>
                  <td className="mono" style={{ fontWeight: 500 }}>{k.name}</td>
                  <td><span className={"chip dot " + (k.type === "sensitive" ? "" : "accent")}>{k.type}</span></td>
                  <td className="mono muted">v{k.currentVersion}</td>
                  <td className="data" style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {k.type === "public"
                      ? (k.value ?? <span className="dim">—</span>)
                      : revealed?.id === k.id
                        ? <span style={{ color: "var(--warn)" }}>{revealed.value}</span>
                        : <span className="dim">••••••••••</span>}
                  </td>
                  <td className="mono muted">{fmtDate(k.updatedAt)}</td>
                  <td>
                    <div className="rowactions">
                      {k.type === "sensitive" && canReveal && (
                        revealed?.id === k.id
                          ? <button className="sm ghost" onClick={clearReveal}>hide</button>
                          : <button className="sm ghost" onClick={() => doReveal(k.id, k.name)}>reveal</button>
                      )}
                      <button className="sm ghost" onClick={() => setDetail(k)}>manage</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          emoji="🔑"
          title="No keys in this environment yet"
          hint="Add config and secrets here, then grant them to a service."
          action={canWrite ? <button className="primary" onClick={() => setCreate(true)}>+ New key</button> : undefined}
        />
      )}

      {create && (
        <CreateKeyDrawer
          envId={envId}
          onClose={() => setCreate(false)}
          onDone={(name) => {
            setCreate(false)
            reload()
            toast.success(`Key “${name}” created`)
          }}
        />
      )}
      {detail && (
        <KeyDetailDrawer
          keyMeta={detail}
          canWrite={canWrite}
          onClose={() => setDetail(null)}
          onChanged={reload}
          onDeleted={() => { setDetail(null); reload() }}
        />
      )}
    </div>
  )
}

function CreateKeyDrawer({ envId, onClose, onDone }: { envId: string; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState("")
  const [type, setType] = useState<KeyType>("sensitive")
  const [value, setValue] = useState("")
  const [description, setDescription] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()

  const submit = async () => {
    if (!name || !value) return
    setBusy(true); setErr(undefined)
    try {
      await api.createKey(envId, { name, type, value, description: description || undefined })
      onDone(name)
    } catch (e: any) { setErr(e.message); setBusy(false) }
  }

  return (
    <Drawer title="New key" desc="Config is stored in plaintext; secrets are encrypted at rest." onClose={onClose}>
      {err && <div className="errbox">{err}</div>}
      <div className="field">
        <label>Name</label>
        <input
          className="mono"
          value={name}
          onChange={(e) => setName(e.target.value.replace(/\s+/g, "_").toUpperCase())}
          placeholder="DATABASE_URL"
        />
      </div>
      <div className="field">
        <label>Type</label>
        <div className="segmented">
          <button className={type === "sensitive" ? "on" : ""} onClick={() => setType("sensitive")}>sensitive</button>
          <button className={type === "public" ? "on" : ""} onClick={() => setType("public")}>public / config</button>
        </div>
        <div className="hint">
          {type === "sensitive"
            ? "Encrypted at rest, masked in the dashboard, delivered sealed to services."
            : "Stored in plaintext and visible in the dashboard."}
        </div>
      </div>
      <div className="field">
        <label>Value</label>
        <textarea className="mono" rows={3} value={value} onChange={(e) => setValue(e.target.value)} placeholder="postgres://…" />
      </div>
      <div className="field">
        <label>Description <span className="dim">(optional)</span></label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Primary database connection string" />
      </div>
      <div className="overlay-foot">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !name || !value} onClick={submit}>{busy ? "Creating…" : "Create key"}</button>
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
  const toast = useToast()
  const confirm = useConfirm()

  const setValue = async () => {
    if (!newValue) return
    setBusy(true)
    try {
      await api.setKeyValue(keyMeta.id, newValue)
      setNewValue("")
      detail.reload()
      onChanged()
      toast.success(`New version saved for ${keyMeta.name}`)
    } catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }
  const rollback = async (v: number) => {
    if (!(await confirm({ title: "Roll back key", message: <>Point <b>{keyMeta.name}</b> back to <span className="mono">v{v}</span>? This creates the active value from that version.</>, confirmLabel: `Roll back to v${v}` }))) return
    try { await api.rollbackKey(keyMeta.id, v); detail.reload(); onChanged(); toast.success(`Rolled back to v${v}`) }
    catch (e: any) { toast.error(e.message) }
  }
  const del = async () => {
    if (!(await confirm({ title: "Delete key", message: <>Permanently delete <b>{keyMeta.name}</b> and all its versions? This cannot be undone.</>, confirmLabel: "Delete key", danger: true }))) return
    try { await api.deleteKey(keyMeta.id); onDeleted(); toast.success(`Deleted ${keyMeta.name}`) }
    catch (e: any) { toast.error(e.message) }
  }

  return (
    <Drawer title={keyMeta.name} onClose={onClose}>
      <div className="row" style={{ marginBottom: 20 }}>
        <span className={"chip dot " + (keyMeta.type === "public" ? "accent" : "")}>{keyMeta.type}</span>
        <span className="chip mono">v{keyMeta.currentVersion}</span>
        <span className="grow" />
        <span className="muted mono small">id <Copy text={keyMeta.id} label={keyMeta.id.slice(0, 10) + "…"} /></span>
      </div>

      {canWrite && (
        <div className="field">
          <label>Set new value <span className="dim">(creates a version)</span></label>
          <textarea className="mono" rows={2} value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="new value…" />
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
            <button className="primary sm" disabled={busy || !newValue} onClick={setValue}>{busy ? "Saving…" : "Save version"}</button>
          </div>
        </div>
      )}

      <hr className="sep" />
      <label>Version history</label>
      {detail.loading ? (
        <div className="loading"><span className="spin" /></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>version</th><th>created</th><th className="right"></th></tr></thead>
            <tbody>
              {detail.data?.versions.map((v) => (
                <tr key={v.version}>
                  <td className="mono">
                    {v.version === keyMeta.currentVersion
                      ? <span style={{ color: "var(--accent)" }}>v{v.version} · current</span>
                      : `v${v.version}`}
                  </td>
                  <td className="mono muted">{fmtDate(v.createdAt)}</td>
                  <td>
                    <div className="rowactions">
                      {canWrite && v.version !== keyMeta.currentVersion && (
                        <button className="sm ghost" onClick={() => rollback(v.version)}>rollback</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canWrite && (
        <>
          <hr className="sep" />
          <button className="danger" onClick={del}>Delete key</button>
        </>
      )}
    </Drawer>
  )
}
