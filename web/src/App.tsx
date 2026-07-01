import { useEffect, useState } from "react"
import { api, ApiError, type Environment, type Me, type Org, type Project, type Role } from "./api"
import { Login } from "./Login"
import { useAsync } from "./ui"
import { KeysView } from "./views/Keys"
import { ServicesView } from "./views/Services"
import { ActivityView } from "./views/Activity"
import { AnalyticsView } from "./views/Analytics"
import { MembersView } from "./views/Members"

type Selection =
  | { kind: "env"; env: Environment; project: Project; tab: "keys" | "services" | "activity" }
  | { kind: "org"; view: "audit" | "analytics" | "members" }
  | { kind: "home" }

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

  const orgs = orgsQ.data ?? []
  const org: Org | undefined = orgs.find((o) => o.id === orgId) ?? orgs[0]
  const role: Role = org?.role ?? "viewer"

  useEffect(() => {
    if (!orgId && orgs[0]) setOrgId(orgs[0].id)
  }, [orgs, orgId])

  const logout = async () => { await api.logout().catch(() => {}); onLogout() }

  const createOrg = async () => {
    const name = prompt("Organization name")
    if (!name) return
    try { const o = await api.createOrg(name); orgsQ.reload(); setOrgId(o.id) } catch (e) { alert((e as ApiError).message) }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark" /><div className="brand-name">cuki</div></div>

        <div className="side-section">
          <div className="side-label">organization</div>
          <div className="row" style={{ padding: "0 8px" }}>
            <select className="grow" value={org?.id ?? ""} onChange={(e) => { setOrgId(e.target.value); setSel({ kind: "home" }) }}>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <button className="nav-item" onClick={createOrg}>+ new org</button>
        </div>

        {org && (
          <>
            <div className="side-section">
              <div className="side-label">org</div>
              <NavItem active={sel.kind === "org" && sel.view === "audit"} onClick={() => setSel({ kind: "org", view: "audit" })}>Audit</NavItem>
              <NavItem active={sel.kind === "org" && sel.view === "analytics"} onClick={() => setSel({ kind: "org", view: "analytics" })}>Analytics</NavItem>
              <NavItem active={sel.kind === "org" && sel.view === "members"} onClick={() => setSel({ kind: "org", view: "members" })}>Members</NavItem>
            </div>
            <ProjectsNav org={org} role={role} sel={sel} onSelect={setSel} />
          </>
        )}

        <div className="grow" />
        <div className="side-section" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="mono muted" style={{ fontSize: 12, padding: "4px 10px" }}>{me.user.email}</div>
          <button className="nav-item" onClick={logout}>Sign out</button>
        </div>
      </aside>

      <main className="main">
        <Content org={org} role={role} sel={sel} setSel={setSel} />
      </main>
    </div>
  )
}

function NavItem({ active, onClick, children, sub }: { active?: boolean; onClick: () => void; children: React.ReactNode; sub?: boolean }) {
  return <button className={"nav-item" + (active ? " active" : "") + (sub ? " sub" : "")} onClick={onClick}>{children}</button>
}

function ProjectsNav({ org, role, sel, onSelect }: { org: Org; role: Role; sel: Selection; onSelect: (s: Selection) => void }) {
  const projectsQ = useAsync(() => api.listProjects(org.id), [org.id])
  const canWrite = role === "member" || role === "admin" || role === "owner"
  const createProject = async () => {
    const name = prompt("Project name")
    if (!name) return
    try { await api.createProject(org.id, name); projectsQ.reload() } catch (e) { alert((e as ApiError).message) }
  }
  return (
    <div className="side-section">
      <div className="side-label">projects</div>
      {(projectsQ.data ?? []).map((p) => (
        <ProjectNode key={p.id} project={p} role={role} sel={sel} onSelect={onSelect} />
      ))}
      {canWrite && <button className="nav-item" onClick={createProject}>+ new project</button>}
    </div>
  )
}

function ProjectNode({ project, role, sel, onSelect }: { project: Project; role: Role; sel: Selection; onSelect: (s: Selection) => void }) {
  const [open, setOpen] = useState(true)
  const envsQ = useAsync(() => (open ? api.listEnvironments(project.id) : Promise.resolve([])), [project.id, open])
  const canWrite = role === "member" || role === "admin" || role === "owner"
  const createEnv = async () => {
    const name = prompt("Environment name (e.g. production)")
    if (!name) return
    const isProt = confirm("Protected environment? (writes require admin+)")
    try { await api.createEnvironment(project.id, name, isProt); envsQ.reload() } catch (e) { alert((e as ApiError).message) }
  }
  return (
    <div>
      <NavItem onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} {project.name}</NavItem>
      {open && (
        <>
          {(envsQ.data ?? []).map((env) => {
            const active = sel.kind === "env" && sel.env.id === env.id
            return (
              <NavItem key={env.id} sub active={active} onClick={() => onSelect({ kind: "env", env, project, tab: "keys" })}>
                {env.name}{env.protected ? " ◆" : ""}
              </NavItem>
            )
          })}
          {canWrite && <button className="nav-item sub" onClick={createEnv}>+ env</button>}
        </>
      )}
    </div>
  )
}

function Content({ org, role, sel, setSel }: { org: Org | undefined; role: Role; sel: Selection; setSel: (s: Selection) => void }) {
  if (!org) return <div className="content empty">create or select an organization</div>

  if (sel.kind === "org") {
    return (
      <>
        <div className="topbar">
          <div className="crumbs"><b>{org.name}</b> / {sel.view}</div>
        </div>
        <div className="content">
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
          <div className="crumbs">{org.name} / {project.name} / <b>{env.name}</b> {env.protected && <span className="chip">protected</span>} <span className="chip">{role}</span></div>
        </div>
        <div className="tabs">
          {(["keys", "services", "activity"] as const).map((t) => (
            <button key={t} className={"tab" + (tab === t ? " active" : "")} onClick={() => setSel({ ...sel, tab: t })}>{t}</button>
          ))}
        </div>
        <div className="content">
          {tab === "keys" && <KeysView key={env.id} envId={env.id} role={role} envProtected={env.protected} />}
          {tab === "services" && <ServicesView key={env.id} envId={env.id} role={role} serverOrigin={window.location.origin} />}
          {tab === "activity" && <ActivityView key={env.id} orgId={org.id} environmentId={env.id} />}
        </div>
      </>
    )
  }

  return (
    <>
      <div className="topbar"><div className="crumbs"><b>{org.name}</b></div></div>
      <div className="content">
        <h1 className="page-title">Welcome</h1>
        <p className="muted">Pick a project environment on the left to manage keys and services, or open Audit / Analytics / Members for org-wide views.</p>
        <div className="cards" style={{ marginTop: 24 }}>
          <div className="stat"><div className="l">your role</div><div className="n" style={{ fontSize: 18 }}>{role}</div></div>
        </div>
      </div>
    </>
  )
}
