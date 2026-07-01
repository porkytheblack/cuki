import { useState } from "react"
import { api, type Me } from "./api"

export function Login({ onAuthed }: { onAuthed: (me: Me) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login")
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr(undefined)
    try {
      const me = mode === "login"
        ? await api.login({ email, password })
        : await api.register({ email, name, password })
      onAuthed(me)
    } catch (er: any) {
      setErr(er.message ?? "failed"); setBusy(false)
    }
  }

  return (
    <div className="center-screen">
      <div className="card login-card">
        <div className="brand" style={{ border: "none", padding: 0, marginBottom: 24 }}>
          <div className="brand-mark" />
          <div className="brand-name" style={{ fontSize: 20 }}>cuki</div>
        </div>
        <div className="muted" style={{ marginBottom: 20, fontSize: 13 }}>secrets &amp; config, self-hosted</div>
        <form onSubmit={submit}>
          {mode === "register" && (
            <div className="field"><label>name</label><input value={name} onChange={(e) => setName(e.target.value)} required /></div>
          )}
          <div className="field"><label>email</label><input className="mono" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div className="field"><label>password</label><input className="mono" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></div>
          {err && <div className="err">{err}</div>}
          <button className="primary" style={{ width: "100%" }} disabled={busy} type="submit">
            {busy ? "…" : mode === "login" ? "sign in" : "create account"}
          </button>
        </form>
        <div style={{ marginTop: 16, textAlign: "center", fontSize: 13 }} className="muted">
          {mode === "login" ? "no account?" : "have an account?"}{" "}
          <a onClick={() => { setMode(mode === "login" ? "register" : "login"); setErr(undefined) }} style={{ cursor: "pointer" }}>
            {mode === "login" ? "register" : "sign in"}
          </a>
        </div>
      </div>
    </div>
  )
}
