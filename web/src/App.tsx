import { useEffect, useState } from "react"
import { api, ApiError, type Environment, type Me, type Org, type Project, type Role } from "./api"
import { useConfirm, useToast } from "./feedback"
import { Login } from "./Login"
import { EmptyState, Loading, Modal, useAsync } from "./ui"
import { KeysView } from "./views/Keys"
import { ServicesView } from "./views/Services"
import { ActivityView } from "./views/Activity"
import { AnalyticsView } from "./views/Analytics"
import { MembersView } from "./views/Members"

type OrgView = "audit" | "analytics" | "members"
type Selection =
  | { kind: "env"; env: Environment; project: Project; tab: "keys" | "services" | "activity" }
  | { kind: "org"; view: OrgView }
  | { kind: "home" }

const canWriteRole = (r: Role) => r === "member" || r === "admin" || r === "owner"

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null))
  }, [])
  if (me === undefined) return <div className="center-screen"><span className="spin" /></div>
  if (me === null) return <Login onAuthed={setMe} />
  return <Shell me={me} onLogout={() => setMe(null)} />
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const orgsQ = useAsync(() => api.listOrgs(), [])
  const [orgId, setOrgId] = useState<string | undefined>(me.memberships[0]?.orgId)
  const [sel, setSel] = useState<Selection>({ kind: "home" })
  const [newOrg, setNewOrg] = useState(false)
  const toast = useToast()
  const confirm = useConfirm()

  const orgs = orgsQ.data ?? []
  const org: Org | undefined = orgs.find((o) => o.id === orgId) ?? orgs[0]
  const role: Role = org?.role ?? "viewer"

  useEffect(() => {
    if (!orgId && orgs[0]) setOrgId(orgs[0].id)
  }, [orgs, orgId])

  const logout = async () => {
    if (!(await confirm({ title: "Sign out?", message: "You'll need to sign in again.", confirmLabel: "Sign out" })))
      return
    await api.logout().catch(() => {})
    onLogout()
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" />
          <div className="brand-name">cuki</div>
          <div className="brand-tag">secrets</div>
        </div>

        <div className="side-section">
          <div className="side-label">organization</div>
          <div style={{ padding: "0 8px" }}>
            <select
              aria-label="Organization"
              value={org?.id ?? ""}
              onChange={(e) => {
                setOrgId(e.target.value)
                setSel({ kind: "home" })
              }}
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <button className="nav-item add" onClick={() => setNewOrg(true)}>+ new organization</button>
        </div>

        {org && (
          <>
            <div className="side-section">
              <div className="side-label">organization views</div>
              <NavItem icon="◷" active={sel.kind === "org" && sel.view === "audit"} onClick={() => setSel({ kind: "org", view: "audit" })}>Audit</NavItem>
              <NavItem icon="▚" active={sel.kind === "org" && sel.view === "analytics"} onClick={() => setSel({ kind: "org", view: "analytics" })}>Analytics</NavItem>
              <NavItem icon="◆" active={sel.kind === "org" && sel.view === "members"} onClick={() => setSel({ kind: "org", view: "members" })}>Members</NavItem>
            </div>
            <ProjectsNav org={org} role={role} sel={sel} onSelect={setSel} />
          </>
        )}

        <div className="grow" />
        <div className="side-section" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="mono muted" style={{ fontSize: 12, padding: "6px 10px", overflow: "hidden", textOverflow: "ellipsis" }}>
            {me.user.email}
          </div>
          <button className="nav-item" onClick={logout}>Sign out</button>
        </div>
      </aside>

      <main className="main">
        <Content org={org} role={role} sel={sel} setSel={setSel} loading={orgsQ.loading} />
      </main>

      {newOrg && (
        <NameModal
          title="New organization"
          desc="Groups your projects, members, and audit trail."
          label="Organization name"
          placeholder="Acme Inc."
          submitLabel="Create organization"
          onClose={() => setNewOrg(false)}
          onSubmit={async (name) => {
            const o = await api.createOrg(name)
            orgsQ.reload()
            setOrgId(o.id)
            setSel({ kind: "home" })
            toast.success(`Organization “${o.name}” created`)
          }}
        />
      )}
    </div>
  )
}

function NavItem({
  active,
  onClick,
  children,
  sub,
  icon,
  caret,
  dot,
}: {
  active?: boolean
  onClick: () => void
  children: React.ReactNode
  sub?: boolean
  icon?: string
  caret?: string
  dot?: boolean
}) {
  return (
    <button className={"nav-item" + (active ? " active" : "") + (sub ? " sub" : "")} onClick={onClick}>
      {caret !== undefined && <span className="nav-caret">{caret}</span>}
      {icon && <span className="dim" style={{ fontSize: 11, width: 12, textAlign: "center" }}>{icon}</span>}
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{children}</span>
      {dot && <span className="nav-dot" title="protected" />}
    </button>
  )
}

function ProjectsNav({ org, role, sel, onSelect }: { org: Org; role: Role; sel: Selection; onSelect: (s: Selection) => void }) {
  const projectsQ = useAsync(() => api.listProjects(org.id), [org.id])
  const [creating, setCreating] = useState(false)
  const toast = useToast()

  return (
    <div className="side-section">
      <div className="side-label">projects</div>
      {projectsQ.loading ? (
        <div style={{ padding: "6px 12px" }}><span className="spin" /></div>
      ) : (
        (projectsQ.data ?? []).map((p) => (
          <ProjectNode key={p.id} project={p} role={role} sel={sel} onSelect={onSelect} />
        ))
      )}
      {!projectsQ.loading && (projectsQ.data ?? []).length === 0 && (
        <div className="dim" style={{ padding: "4px 12px", fontSize: 12 }}>no projects yet</div>
      )}
      {canWriteRole(role) && <button className="nav-item add" onClick={() => setCreating(true)}>+ new project</button>}

      {creating && (
        <NameModal
          title="New project"
          desc="A project holds one or more environments (dev, staging, production…)."
          label="Project name"
          placeholder="Web App"
          submitLabel="Create project"
          onClose={() => setCreating(false)}
          onSubmit={async (name) => {
            await api.createProject(org.id, name)
            projectsQ.reload()
            toast.success(`Project “${name}” created`)
          }}
        />
      )}
    </div>
  )
}

function ProjectNode({ project, role, sel, onSelect }: { project: Project; role: Role; sel: Selection; onSelect: (s: Selection) => void }) {
  const [open, setOpen] = useState(true)
  const [creating, setCreating] = useState(false)
  const envsQ = useAsync(() => (open ? api.listEnvironments(project.id) : Promise.resolve([])), [project.id, open])
  const toast = useToast()

  return (
    <div>
      <NavItem caret={open ? "▾" : "▸"} onClick={() => setOpen(!open)}>{project.name}</NavItem>
      {open && (
        <>
          {(envsQ.data ?? []).map((env) => (
            <NavItem
              key={env.id}
              sub
              dot={env.protected}
              active={sel.kind === "env" && sel.env.id === env.id}
              onClick={() => onSelect({ kind: "env", env, project, tab: "keys" })}
            >
              {env.name}
            </NavItem>
          ))}
          {canWriteRole(role) && <button className="nav-item sub add" onClick={() => setCreating(true)}>+ environment</button>}
        </>
      )}

      {creating && (
        <EnvModal
          projectName={project.name}
          onClose={() => setCreating(false)}
          onSubmit={async (name, isProtected) => {
            await api.createEnvironment(project.id, name, isProtected)
            envsQ.reload()
            toast.success(`Environment “${name}” created`)
          }}
        />
      )}
    </div>
  )
}

function Content({
  org,
  role,
  sel,
  setSel,
  loading,
}: {
  org: Org | undefined
  role: Role
  sel: Selection
  setSel: (s: Selection) => void
  loading: boolean
}) {
  if (loading) return <div className="content"><Loading label="loading organizations" /></div>
  if (!org)
    return (
      <div className="content">
        <EmptyState emoji="⬡" title="No organization yet" hint="Create one from the sidebar to get started." />
      </div>
    )

  if (sel.kind === "org") {
    return (
      <>
        <div className="topbar">
          <div className="crumbs">
            <b>{org.name}</b> <span className="sep">/</span> <span style={{ textTransform: "capitalize" }}>{sel.view}</span>
          </div>
          <span className="chip dot accent">{role}</span>
        </div>
        <div className="content enter" key={sel.view}>
          <h1 className="page-title" style={{ textTransform: "capitalize" }}>{sel.view}</h1>
          {sel.view === "audit" && <ActivityView orgId={org.id} />}
          {sel.view === "analytics" && <AnalyticsView orgId={org.id} />}
          {sel.view === "members" && <MembersView orgId={org.id} role={role} />}
        </div>
      </>
    )
  }

  if (sel.kind === "env") {
    const { env, project, tab } = sel
    return (
      <>
        <div className="topbar">
          <div className="crumbs">
            {org.name} <span className="sep">/</span> {project.name} <span className="sep">/</span> <b>{env.name}</b>
            {env.protected && <span className="chip warn dot">protected</span>}
          </div>
          <span className="chip dot accent">{role}</span>
        </div>
        <div className="tabs">
          {(["keys", "services", "activity"] as const).map((t) => (
            <button key={t} className={"tab" + (tab === t ? " active" : "")} onClick={() => setSel({ ...sel, tab: t })}>
              {t}
            </button>
          ))}
        </div>
        <div className="content enter" key={env.id + tab}>
          {tab === "keys" && <KeysView key={env.id} envId={env.id} role={role} envProtected={env.protected} />}
          {tab === "services" && <ServicesView key={env.id} envId={env.id} role={role} serverOrigin={window.location.origin} />}
          {tab === "activity" && <ActivityView key={env.id} orgId={org.id} environmentId={env.id} />}
        </div>
      </>
    )
  }

  return (
    <>
      <div className="topbar">
        <div className="crumbs"><b>{org.name}</b></div>
        <span className="chip dot accent">{role}</span>
      </div>
      <div className="content enter">
        <h1 className="page-title">Welcome to {org.name}</h1>
        <p className="muted" style={{ marginTop: -8, maxWidth: 620 }}>
          Pick a project environment in the sidebar to manage keys and services, or jump to an
          organization view below.
        </p>
        <div className="cards" style={{ marginTop: 24 }}>
          <QuickCard title="Audit" hint="Who read which secret, when." onClick={() => setSel({ kind: "org", view: "audit" })} />
          <QuickCard title="Analytics" hint="Secret-read volume & top consumers." onClick={() => setSel({ kind: "org", view: "analytics" })} />
          <QuickCard title="Members" hint="Manage roles & access." onClick={() => setSel({ kind: "org", view: "members" })} />
        </div>
      </div>
    </>
  )
}

function QuickCard({ title, hint, onClick }: { title: string; hint: string; onClick: () => void }) {
  return (
    <button className="card" style={{ textAlign: "left", cursor: "pointer" }} onClick={onClick}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{title} →</div>
      <div className="muted" style={{ fontSize: 12 }}>{hint}</div>
    </button>
  )
}

/* ── create modals (replace native prompt) ──────────────────────────────── */

function NameModal({
  title,
  desc,
  label,
  placeholder,
  submitLabel,
  mono,
  onClose,
  onSubmit,
}: {
  title: string
  desc?: string
  label: string
  placeholder?: string
  submitLabel: string
  mono?: boolean
  onClose: () => void
  onSubmit: (name: string) => Promise<void>
}) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const toast = useToast()
  const submit = async () => {
    if (!name.trim()) return
    setBusy(true)
    setErr(undefined)
    try {
      await onSubmit(name.trim())
      onClose()
    } catch (e) {
      const m = e instanceof ApiError ? e.message : String(e)
      setErr(m)
      toast.error(m)
      setBusy(false)
    }
  }
  return (
    <Modal
      sm
      title={title}
      desc={desc}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? "Creating…" : submitLabel}
          </button>
        </>
      }
    >
      {err && <div className="errbox">{err}</div>}
      <div className="field" style={{ marginBottom: 0 }}>
        <label>{label}</label>
        <input
          className={mono ? "mono" : undefined}
          value={name}
          placeholder={placeholder}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
    </Modal>
  )
}

function EnvModal({
  projectName,
  onClose,
  onSubmit,
}: {
  projectName: string
  onClose: () => void
  onSubmit: (name: string, isProtected: boolean) => Promise<void>
}) {
  const [name, setName] = useState("")
  const [isProtected, setIsProtected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const toast = useToast()
  const submit = async () => {
    if (!name.trim()) return
    setBusy(true)
    setErr(undefined)
    try {
      await onSubmit(name.trim(), isProtected)
      onClose()
    } catch (e) {
      const m = e instanceof ApiError ? e.message : String(e)
      setErr(m)
      toast.error(m)
      setBusy(false)
    }
  }
  return (
    <Modal
      sm
      title="New environment"
      desc={`In ${projectName}.`}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? "Creating…" : "Create environment"}
          </button>
        </>
      }
    >
      {err && <div className="errbox">{err}</div>}
      <div className="field">
        <label>Environment name</label>
        <input
          className="mono"
          value={name}
          placeholder="production"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label>Protection</label>
        <div className="segmented">
          <button className={!isProtected ? "on" : ""} onClick={() => setIsProtected(false)}>standard</button>
          <button className={isProtected ? "on" : ""} onClick={() => setIsProtected(true)}>protected</button>
        </div>
        <div className="hint">
          {isProtected ? "Writes and grants require admin or owner." : "Any member can write keys."}
        </div>
      </div>
    </Modal>
  )
}
