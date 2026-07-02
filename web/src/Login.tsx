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
    setBusy(true)
    setErr(undefined)
    try {
      const me = mode === "login" ? await api.login({ email, password }) : await api.register({ email, name, password })
      onAuthed(me)
    } catch (er: any) {
      setErr(er?.message ?? "Something went wrong")
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="row" style={{ marginBottom: 6 }}>
          <div className="brand-mark" />
          <div className="brand-name" style={{ fontSize: 20 }}>cuki</div>
        </div>
        <div className="muted" style={{ marginBottom: 24, fontSize: 13 }}>secrets &amp; config, self-hosted</div>

        <div className="segmented" style={{ marginBottom: 20, width: "100%" }}>
          <button className={"block " + (mode === "login" ? "on" : "")} onClick={() => { setMode("login"); setErr(undefined) }}>Sign in</button>
          <button className={"block " + (mode === "register" ? "on" : "")} onClick={() => { setMode("register"); setErr(undefined) }}>Create account</button>
        </div>

        <form onSubmit={submit}>
          {mode === "register" && (
            <div className="field">
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" required />
            </div>
          )}
          <div className="field">
            <label>Email</label>
            <input className="mono" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
          </div>
          <div className="field">
            <label>Password</label>
            <input className="mono" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required minLength={8} />
            {mode === "register" && <div className="hint">At least 8 characters.</div>}
          </div>
          {err && <div className="errbox">{err}</div>}
          <button className="primary block" disabled={busy} type="submit" style={{ marginTop: 4 }}>
            {busy ? <span className="spin" /> : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  )
}
