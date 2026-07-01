import { useCallback, useEffect, useState } from "react"

/** Simple data-loading hook with refetch. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): {
  data: T | undefined
  error: string | undefined
  loading: boolean
  reload: () => void
} {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(undefined)
    run()
      .then((d) => alive && (setData(d), setLoading(false)))
      .catch((e) => alive && (setError(e?.message ?? String(e)), setLoading(false)))
    return () => {
      alive = false
    }
  }, [run, nonce])
  return { data, error, loading, reload: () => setNonce((n) => n + 1) }
}

export function Modal(props: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="overlay" onMouseDown={props.onClose}>
      <div
        className="modal"
        style={props.wide ? { width: 720 } : undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="spread" style={{ marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>{props.title}</h2>
          <button className="ghost" onClick={props.onClose}>✕</button>
        </div>
        {props.children}
      </div>
    </div>
  )
}

export function Drawer(props: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="overlay" onMouseDown={props.onClose}>
      <div className="drawer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="spread" style={{ marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>{props.title}</h2>
          <button className="ghost" onClick={props.onClose}>✕</button>
        </div>
        {props.children}
      </div>
    </div>
  )
}

export function Copy({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="sm ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          /* clipboard may be unavailable */
        }
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? "copied" : (label ?? "copy")}
    </button>
  )
}

export function fmtDate(s: string | null): string {
  if (!s) return "—"
  const d = new Date(s)
  return d.toLocaleString(undefined, { year: "2-digit", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}

export function relTime(s: string | null): string {
  if (!s) return "never"
  const diff = Date.now() - new Date(s).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
