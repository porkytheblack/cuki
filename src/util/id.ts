import { ulid } from "ulidx"

/** A fresh ULID — sortable, URL-safe, used for all primary keys (design 02). */
export const newId = (): string => ulid()

/** A prefixed public handle, e.g. `svc_01H...` for service ids. */
export const newHandle = (prefix: string): string => `${prefix}_${ulid()}`
