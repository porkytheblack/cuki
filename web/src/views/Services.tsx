import { useState } from "react"
import { api, type KeyMeta, type Role, type Service, type ServiceCreated } from "../api"
import { Copy, Drawer, Modal, relTime, useAsync } from "../ui"

const rank: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }

export function ServicesView({ envId, role, serverOrigin }: { envId: string; role: Role; serverOrigin: string }) {
  const { data, error, loading, reload } = useAsync(() => api.listServices(envId), [envId])
  const [create, setCreate] = useState(false)
  const [created, setCreated] = useState<ServiceCreated | null>(null)
  const [manage, setManage] = useState<Service | null>(null)

  const canWrite = rank[role] >= 1
  const canAdmin = rank[role] >= 2

  return (
    <div>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div className="muted mono" style={{ fontSize: 12 }}>{data?.length ?? 0} services</div>
        {canWrite && <button className="primary" onClick={() => setCreate(true)}>+ New service</button>}
      </div>
      {error && <div className="err">{error}</div>}
      {loading ? (
        <div className="empty"><span className="spin" /></div>
      ) : data && data.length > 0 ? (
        <table>
          <thead><tr><th>name</th><th>service_id</th><th>status</th><th>last auth</th><th>grants</th><th className="right"></th></tr></thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.name}</td>
                <td className="data">{s.serviceId}</td>
                <td><span className={"chip " + (s.status === "active" ? "ok" : "danger")}>{s.status}</span></td>
                <td className="mono muted">{relTime(s.lastAuthAt)}</td>
                <td className="mono">{s.grants}</td>
                <td className="right"><button className="sm ghost" onClick={() => setManage(s)}>manage</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty">no services — create one to let a workload read secrets</div>
      )}

      {create && (
        <CreateServiceDrawer
          envId={envId}
          onClose={() => setCreate(false)}
          onCreated={(c) => { setCreate(false); setCreated(c); reload() }}
        />
      )}
      {created && (
        <CredentialModal created={created} serverOrigin={serverOrigin} onClose={() => setCreated(null)} />
      )}
      {manage && (
        <ManageServiceDrawer
          svc={manage}
          envId={envId}
          canAdmin={canAdmin}
          onClose={() => setManage(null)}
          onChanged={() => reload()}
          onRotated={(pk) => setCreated({ service: manage, privateKey: pk })}
        />
      )}
    </div>
  )
}

function CreateServiceDrawer({ envId, onClose, onCreated }: {
  envId: string; onClose: () => void; onCreated: (c: ServiceCreated) => void
}) {
  const [name, setName] = useState("")
  const [allow, setAllow] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const submit = async () => {
    setBusy(true); setErr(undefined)
    try {
      const cidrs = allow.split(",").map((s) => s.trim()).filter(Boolean)
      onCreated(await api.createService(envId, name, cidrs.length ? cidrs : undefined))
    } catch (e: any) { setErr(e.message); setBusy(false) }
  }
  return (
    <Drawer title="New service" onClose={onClose}>
      <div className="field"><label>name</label><input className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="api" /></div>
      <div className="field"><label>ip allowlist (optional, comma CIDRs)</label><input className="mono" value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="10.0.0.0/8, 127.0.0.1" /></div>
      {err && <div className="err">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="ghost" onClick={onClose}>cancel</button>
        <button className="primary" disabled={busy || !name} onClick={submit}>{busy ? "creating…" : "create service"}</button>
      </div>
    </Drawer>
  )
}

function CredentialModal({ created, serverOrigin, onClose }: {
  created: ServiceCreated; serverOrigin: string; onClose: () => void
}) {
  const { service, privateKey } = created
  const svc = { url: serverOrigin, service_id: service.serviceId, private_key: privateKey }
  const download = () => {
    const blob = new Blob([JSON.stringify(svc, null, 2)], { type: "application/json" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = "cuki.svc"
    a.click()
  }
  const envSnippet = `CUKI_URL=${serverOrigin}\nCUKI_SERVICE_ID=${service.serviceId}\nCUKI_PRIVATE_KEY=${privateKey}`
  const runSnippet = `cuki run --creds cuki.svc -- your-app`
  return (
    <Modal title="Service credentials" onClose={onClose} wide>
      <div className="warnbox">⚠ The private key is shown once and never again. Store it now — cuki does not keep a copy.</div>
      <div className="field">
        <label>service_id</label>
        <div className="row"><code className="codeblock grow">{service.serviceId}</code><Copy text={service.serviceId} /></div>
      </div>
      <div className="field">
        <label>private_key</label>
        <div className="row"><code className="codeblock grow">{privateKey}</code><Copy text={privateKey} /></div>
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        <button onClick={download}>⬇ download cuki.svc</button>
      </div>
      <div className="field">
        <label>environment variables</label>
        <code className="codeblock">{envSnippet}</code>
        <div className="right"><Copy text={envSnippet} label="copy env" /></div>
      </div>
      <div className="field">
        <label>run your app with injected secrets</label>
        <code className="codeblock">{runSnippet}</code>
      </div>
      <div className="right"><button className="primary" onClick={onClose}>I've saved it</button></div>
    </Modal>
  )
}

function ManageServiceDrawer({ svc, envId, canAdmin, onClose, onChanged, onRotated }: {
  svc: Service; envId: string; canAdmin: boolean; onClose: () => void; onChanged: () => void; onRotated: (pk: string) => void
}) {
  const grants = useAsync(() => api.listGrants(svc.id), [svc.id])
  const keys = useAsync(() => api.listKeys(envId), [envId])
  const activity = useAsync(() => api.serviceActivity(svc.id), [svc.id])
  const [err, setErr] = useState<string>()

  const grantedIds = new Set(grants.data?.map((g) => g.keyId))
  const ungranted = (keys.data ?? []).filter((k: KeyMeta) => !grantedIds.has(k.id))

  const addGrant = async (keyId: string) => {
    try { await api.addGrants(svc.id, [keyId]); grants.reload(); onChanged() } catch (e: any) { setErr(e.message) }
  }
  const removeGrant = async (id: string) => {
    try { await api.deleteGrant(id); grants.reload(); onChanged() } catch (e: any) { setErr(e.message) }
  }

  return (
    <Drawer title={svc.name} onClose={onClose}>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className={"chip " + (svc.status === "active" ? "ok" : "danger")}>{svc.status}</span>
        <span className="data muted">{svc.serviceId}</span>
      </div>
      {err && <div className="err">{err}</div>}

      <label>granted keys</label>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        {grants.data?.length ? grants.data.map((g) => (
          <span key={g.id} className="chip removable" onClick={() => removeGrant(g.id)} title="remove grant">
            {g.keyName} ✕
          </span>
        )) : <span className="dim mono" style={{ fontSize: 12 }}>none</span>}
      </div>
      {ungranted.length > 0 && (
        <div className="field">
          <label>grant a key</label>
          <div className="row wrap">
            {ungranted.map((k) => (
              <button key={k.id} className="sm" onClick={() => addGrant(k.id)}>+ {k.name}</button>
            ))}
          </div>
        </div>
      )}

      <hr className="sep" />
      <label>recent activity</label>
      {activity.data?.length ? (
        <table>
          <thead><tr><th>action</th><th>result</th><th>when</th></tr></thead>
          <tbody>
            {activity.data.slice(0, 8).map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.action}</td>
                <td><span className={"chip " + (a.result === "success" ? "ok" : "danger")}>{a.result}</span></td>
                <td className="mono muted">{relTime(a.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="dim mono" style={{ fontSize: 12 }}>no reads yet</div>}

      {canAdmin && svc.status === "active" && (
        <>
          <hr className="sep" />
          <div className="row wrap">
            <button onClick={async () => {
              if (!confirm("Rotate the key? The old private key stops working.")) return
              try { const r = await api.rotateServiceKey(svc.id); onRotated(r.privateKey) } catch (e: any) { setErr(e.message) }
            }}>rotate key</button>
            <button className="danger" onClick={async () => {
              if (!confirm("Revoke this service? All its tokens are invalidated immediately.")) return
              try { await api.revokeService(svc.id); onChanged(); onClose() } catch (e: any) { setErr(e.message) }
            }}>revoke</button>
          </div>
        </>
      )}
    </Drawer>
  )
}
