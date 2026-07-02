import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

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

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** Overlay accessibility: Escape-to-close, focus trap, autofocus, body scroll lock, restore focus. */
function useOverlayA11y(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prevFocused = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const panel = ref.current
    const focusables = () => Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    // Prefer the first form field (forms), else the first focusable, else the panel.
    const firstField = panel?.querySelector<HTMLElement>(
      'input:not([disabled]),select:not([disabled]),textarea:not([disabled])',
    )
    ;(firstField ?? focusables()[0] ?? panel)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      } else if (e.key === "Tab") {
        const f = focusables()
        if (f.length === 0) return
        const first = f[0]!
        const last = f[f.length - 1]!
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("keydown", onKey, true)
      document.body.style.overflow = prevOverflow
      prevFocused?.focus?.()
    }
  }, [onClose])
  return ref
}

function OverlayHead({ title, desc, onClose }: { title: string; desc?: string; onClose: () => void }) {
  return (
    <div className="overlay-head">
      <div>
        <h2>{title}</h2>
        {desc && <div className="desc">{desc}</div>}
      </div>
      <button className="xbtn" aria-label="Close" onClick={onClose}>
        ✕
      </button>
    </div>
  )
}

export function Modal(props: {
  title: string
  onClose: () => void
  children: ReactNode
  desc?: string
  footer?: ReactNode
  wide?: boolean
  sm?: boolean
}) {
  const ref = useOverlayA11y(props.onClose)
  return (
    <div className="overlay" onMouseDown={props.onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        className={"modal" + (props.sm ? " sm" : "")}
        style={props.wide ? { width: 720 } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <OverlayHead title={props.title} desc={props.desc} onClose={props.onClose} />
        {props.children}
        {props.footer && <div className="overlay-foot">{props.footer}</div>}
      </div>
    </div>
  )
}

export function Drawer(props: {
  title: string
  onClose: () => void
  children: ReactNode
  desc?: string
}) {
  const ref = useOverlayA11y(props.onClose)
  return (
    <div className="overlay" onMouseDown={props.onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <OverlayHead title={props.title} desc={props.desc} onClose={props.onClose} />
        {props.children}
      </div>
    </div>
  )
}

export function EmptyState({
  emoji,
  title,
  hint,
  action,
}: {
  emoji?: string
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      {emoji && <span className="emoji">{emoji}</span>}
      <div style={{ color: "var(--fg-muted)", fontSize: 14 }}>{title}</div>
      {hint && <div style={{ marginTop: 6 }}>{hint}</div>}
      {action && <div className="cta">{action}</div>}
    </div>
  )
}

export function Loading({ label = "loading" }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spin" /> {label}
    </div>
  )
}

/** Skeleton table body while data loads. */
export function SkeletonTable({ rows = 4, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="table-wrap">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="skel-row" style={{ display: "flex", alignItems: "center", gap: 16, padding: "0 14px" }}>
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c} className="skel" style={{ width: `${[40, 22, 14, 24][c % 4]}%` }} />
          ))}
        </div>
      ))}
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
      {done ? "✓ copied" : (label ?? "copy")}
    </button>
  )
}

export function fmtDate(s: string | null): string {
  if (!s) return "—"
  const d = new Date(s)
  return d.toLocaleString(undefined, {
    year: "2-digit",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
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
