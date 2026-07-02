/** Typed client errors (design 09). `AuthFailed` is terminal; `Unauthorized` is retryable. */
export type CukiErrorTag =
  | "AuthFailed"
  | "Unauthorized"
  | "NotFound"
  | "Network"
  | "ServerError"
  | "Config"

export class CukiError extends Error {
  readonly _tag: CukiErrorTag
  constructor(tag: CukiErrorTag, message: string) {
    super(message)
    this.name = `Cuki:${tag}`
    this._tag = tag
  }
}

export const authFailed = (m: string) => new CukiError("AuthFailed", m)
export const unauthorized = (m: string) => new CukiError("Unauthorized", m)
export const notFound = (m: string) => new CukiError("NotFound", m)
export const network = (m: string) => new CukiError("Network", m)
export const serverError = (m: string) => new CukiError("ServerError", m)
export const configError = (m: string) => new CukiError("Config", m)
