import { useState } from "react"
import { api, type KeyMeta, type Role, type Service, type ServiceCreated } from "../api"
import { useConfirm, useToast } from "../feedback"
import { Copy, Drawer, EmptyState, Modal, SkeletonTable, relTime, useAsync } from "../ui"

const rank: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }

export function ServicesView({ envId, role, serverOrigin }: { envId: string; role: Role; serverOrigin: string }) {
  const { data, error, loading, reload } = useAsync(() => api.listServices(envId), [envId])
  const [create, setCreate] = useState(false)
  const [created, setCreated] = useState<ServiceCreated | null>(null)
  const [manage, setManage] = useState<Service | null>(null)
  const toast = useToast()

  const canWrite = rank[role] >= 1
  const canAdmin = rank[role] >= 2

  return (
    <div>
      <div className="section-head">
        <div className="muted mono small">{data ? `${data.length} ${data.length === 1 ? "service" : "services"}` : ""}</div>
        {canWrite && <button className="primary" onClick={() => setCreate(true)}>+ New service</button>}
      </div>
      {error && <div className="errbox">{error}</div>}

      {loading ? (
        <SkeletonTable rows={3} cols={5} />
      ) : data && data.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>name</th><th>service_id</th><th>status</th><th>last auth</th><th>grants</th><th className="right"></th></tr></thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id}>
                  <td className="mono" style={{ fontWeight: 500 }}>{s.name}</td>
                  <td className="data muted">{s.serviceId}</td>
                  <td><span className={"chip dot " + (s.status === "active" ? "ok" : "danger")}>{s.status}</span></td>
                  <td className="mono muted">{relTime(s.lastAuthAt)}</td>
                  <td className="mono">{s.grants}</td>
                  <td><div className="rowactions"><button className="sm ghost" onClick={() => setManage(s)}>manage</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          emoji="◆"
          title="No services yet"
          hint="Create a service identity so a workload can fetch its granted secrets."
          action={canWrite ? <button className="primary" onClick={() => setCreate(true)}>+ New service</button> : undefined}
        />
      )}

      {create && (
        <CreateServiceDrawer
          envId={envId}
          onClose={() => setCreate(false)}
          onCreated={(c) => { setCreate(false); setCreated(c); reload(); toast.success(`Service “${c.service.name}” created`) }}
        />
      )}
      {created && <CredentialModal created={created} serverOrigin={serverOrigin} onClose={() => setCreated(null)} />}
      {manage && (
        <ManageServiceDrawer
          svc={manage}
          envId={envId}
          canAdmin={canAdmin}
          onClose={() => setManage(null)}
          onChanged={reload}
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
    if (!name) return
    setBusy(true); setErr(undefined)
    try {
      const cidrs = allow.split(",").map((s) => s.trim()).filter(Boolean)
      onCreated(await api.createService(envId, name, cidrs.length ? cidrs : undefined))
    } catch (e: any) { setErr(e.message); setBusy(false) }
  }
  return (
    <Drawer title="New service" desc="Generates an Ed25519 identity; the private key is shown once." onClose={onClose}>
      {err && <div className="errbox">{err}</div>}
      <div className="field">
        <label>Name</label>
        <input className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="api" onKeyDown={(e) => e.key === "Enter" && submit()} />
      </div>
      <div className="field">
        <label>IP allowlist <span className="dim">(optional, comma-separated CIDRs)</span></label>
        <input className="mono" value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="10.0.0.0/8, 127.0.0.1" />
        <div className="hint">Restricts where this service may authenticate from.</div>
      </div>
      <div className="overlay-foot">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !name} onClick={submit}>{busy ? "Creating…" : "Create service"}</button>
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
    <Modal
      title="Service credentials"
      desc="Save these now — the private key is never shown again."
      onClose={onClose}
      wide
      footer={<button className="primary" onClick={onClose}>I've saved it</button>}
    >
      <div className="warnbox">⚠ The private key is shown once and never again. cuki keeps only the public key.</div>
      <div className="field">
        <label>service_id</label>
        <div className="row"><code className="codeblock grow">{service.serviceId}</code><Copy text={service.serviceId} /></div>
      </div>
      <div className="field">
        <label>private_key</label>
        <div className="row"><code className="codeblock grow">{privateKey}</code><Copy text={privateKey} /></div>
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        <button onClick={download}>⬇ Download cuki.svc</button>
      </div>
      <div className="field">
        <div className="spread"><label style={{ marginBottom: 0 }}>Environment variables</label><Copy text={envSnippet} label="copy" /></div>
        <code className="codeblock" style={{ marginTop: 6 }}>{envSnippet}</code>
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label>Run your app with injected secrets</label>
        <code className="codeblock">{runSnippet}</code>
      </div>
    </Modal>
  )
}

function ManageServiceDrawer({ svc, envId, canAdmin, onClose, onChanged, onRotated }: {
  svc: Service; envId: string; canAdmin: boolean; onClose: () => void; onChanged: () => void; onRotated: (pk: string) => void
}) {
  const grants = useAsync(() => api.listGrants(svc.id), [svc.id])
  const keys = useAsync(() => api.listKeys(envId), [envId])
  const activity = useAsync(() => api.serviceActivity(svc.id), [svc.id])
  const toast = useToast()
  const confirm = useConfirm()

  const grantedIds = new Set(grants.data?.map((g) => g.keyId))
  const ungranted = (keys.data ?? []).filter((k: KeyMeta) => !grantedIds.has(k.id))

  const addGrant = async (keyId: string, name: string) => {
    try { await api.addGrants(svc.id, [keyId]); grants.reload(); onChanged(); toast.success(`Granted ${name}`) }
    catch (e: any) { toast.error(e.message) }
  }
  const removeGrant = async (id: string, name: string) => {
    try { await api.deleteGrant(id); grants.reload(); onChanged(); toast.info(`Removed grant for ${name}`) }
    catch (e: any) { toast.error(e.message) }
  }

  return (
    <Drawer title={svc.name} onClose={onClose}>
      <div className="row" style={{ marginBottom: 20 }}>
        <span className={"chip dot " + (svc.status === "active" ? "ok" : "danger")}>{svc.status}</span>
        <span className="grow" />
        <span className="data muted small">{svc.serviceId}<Copy text={svc.serviceId} label="⧉" /></span>
      </div>

      <label>Granted keys</label>
      <div className="row wrap" style={{ marginBottom: 14 }}>
        {grants.data?.length ? grants.data.map((g) => (
          <span key={g.id} className="chip removable" onClick={() => removeGrant(g.id, g.keyName)} title="remove grant">
            {g.keyName} ✕
          </span>
        )) : <span className="dim mono small">no grants yet</span>}
      </div>
      {ungranted.length > 0 && (
        <div className="field">
          <label>Grant a key</label>
          <div className="row wrap">
            {ungranted.map((k) => (
              <button key={k.id} className="sm" onClick={() => addGrant(k.id, k.name)}>+ {k.name}</button>
            ))}
          </div>
        </div>
      )}

      <hr className="sep" />
      <label>Recent activity</label>
      {activity.loading ? (
        <div className="loading"><span className="spin" /></div>
      ) : activity.data?.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>action</th><th>result</th><th>when</th></tr></thead>
            <tbody>
              {activity.data.slice(0, 8).map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.action}</td>
                  <td><span className={"chip dot " + (a.result === "success" ? "ok" : "danger")}>{a.result}</span></td>
                  <td className="mono muted">{relTime(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="dim mono small">no reads yet</div>}

      {canAdmin && svc.status === "active" && (
        <>
          <hr className="sep" />
          <div className="row wrap">
            <button onClick={async () => {
              if (!(await confirm({ title: "Rotate key", message: <>Generate a new keypair for <b>{svc.name}</b>? The current private key stops working immediately.</>, confirmLabel: "Rotate key" }))) return
              try { const r = await api.rotateServiceKey(svc.id); onRotated(r.privateKey); toast.success("Key rotated — save the new credentials") } catch (e: any) { toast.error(e.message) }
            }}>Rotate key</button>
            <button className="danger" onClick={async () => {
              if (!(await confirm({ title: "Revoke service", message: <>Revoke <b>{svc.name}</b>? All its access tokens are invalidated immediately and it can no longer authenticate.</>, confirmLabel: "Revoke", danger: true }))) return
              try { await api.revokeService(svc.id); onChanged(); onClose(); toast.success(`Revoked ${svc.name}`) } catch (e: any) { toast.error(e.message) }
            }}>Revoke</button>
          </div>
        </>
      )}
    </Drawer>
  )
}
