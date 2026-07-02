import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react"
import { Modal } from "./ui"

/* ── Toasts ─────────────────────────────────────────────────────────────── */

type ToastType = "ok" | "error" | "info"
interface ToastItem { id: number; type: ToastType; msg: string }
interface ToastApi {
  toast: (msg: string, type?: ToastType) => void
  success: (msg: string) => void
  error: (msg: string) => void
  info: (msg: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)
export function useToast(): ToastApi {
  const c = useContext(ToastContext)
  if (!c) throw new Error("useToast must be used within <AppProviders>")
  return c
}

const ICON: Record<ToastType, string> = { ok: "✓", error: "!", info: "i" }

function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const idRef = useRef(0)
  const remove = useCallback((id: number) => setItems((x) => x.filter((t) => t.id !== id)), [])
  const push = useCallback(
    (msg: string, type: ToastType) => {
      const id = ++idRef.current
      setItems((x) => [...x, { id, type, msg }])
      window.setTimeout(() => remove(id), type === "error" ? 6000 : 3500)
    },
    [remove],
  )
  const api = useMemo<ToastApi>(
    () => ({
      toast: (m, t = "info") => push(m, t),
      success: (m) => push(m, "ok"),
      error: (m) => push(m, "error"),
      info: (m) => push(m, "info"),
    }),
    [push],
  )
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-host">
        {items.map((t) => (
          <div key={t.id} className={"toast " + t.type} role="status">
            <span className="ic">{ICON[t.type]}</span>
            <span className="msg">{t.msg}</span>
            <button className="x" aria-label="dismiss" onClick={() => remove(t.id)}>✕</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/* ── Confirm dialog ─────────────────────────────────────────────────────── */

export interface ConfirmOpts {
  title: string
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}
type ConfirmFn = (opts: ConfirmOpts) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)
export function useConfirm(): ConfirmFn {
  const c = useContext(ConfirmContext)
  if (!c) throw new Error("useConfirm must be used within <AppProviders>")
  return c
}

function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ opts: ConfirmOpts; resolve: (b: boolean) => void } | null>(null)
  const confirm = useCallback<ConfirmFn>(
    (opts) => new Promise<boolean>((resolve) => setPending({ opts, resolve })),
    [],
  )
  const close = (val: boolean) => {
    pending?.resolve(val)
    setPending(null)
  }
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <Modal
          sm
          title={pending.opts.title}
          onClose={() => close(false)}
          footer={
            <>
              <button className="ghost" onClick={() => close(false)}>
                {pending.opts.cancelLabel ?? "Cancel"}
              </button>
              <button className={pending.opts.danger ? "danger" : "primary"} onClick={() => close(true)}>
                {pending.opts.confirmLabel ?? "Confirm"}
              </button>
            </>
          }
        >
          <div style={{ color: "var(--fg-muted)", fontSize: 13, lineHeight: 1.6 }}>
            {pending.opts.message}
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  )
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>{children}</ConfirmProvider>
    </ToastProvider>
  )
}
