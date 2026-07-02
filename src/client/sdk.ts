import { readFileSync } from "node:fs"
import { buildAuthMessage, buildSecretsInfo } from "../crypto/constants"
import { openFromRecipient } from "../crypto/hpke"
import { ed25519Sign, toX25519Private } from "../crypto/keys"
import { bytesToUtf8, fromBase64, toBase64 } from "../util/bytes"
import { authFailed, configError, network, notFound, serverError, unauthorized } from "./errors"

/**
 * The cuki client SDK (design 09). Performs the challenge–response, caches the access token,
 * refreshes on expiry, opens HPKE-sealed responses locally, and exposes getSecret / getAll /
 * intoEnv. The Ed25519 private key never leaves the process; secrets are never written to disk.
 */

export interface CukiConfig {
  readonly url: string
  readonly serviceId: string
  readonly privateKey: Uint8Array
}

interface KeyEntry {
  readonly name: string
  readonly type: string
  readonly value: string
}

const REFRESH_SKEW_MS = 10_000

export class Cuki {
  private readonly url: string
  private readonly serviceId: string
  private readonly privateKey: Uint8Array
  private token: { value: string; expiresAt: number } | undefined

  constructor(config: CukiConfig) {
    this.url = config.url.replace(/\/+$/, "")
    this.serviceId = config.serviceId
    this.privateKey = config.privateKey
  }

  static make(options: {
    url: string
    serviceId: string
    privateKey: string | Uint8Array
  }): Cuki {
    const privateKey =
      typeof options.privateKey === "string" ? fromBase64(options.privateKey) : options.privateKey
    if (privateKey.length !== 32) throw configError("private key must be 32 bytes")
    return new Cuki({ url: options.url, serviceId: options.serviceId, privateKey })
  }

  /** Read credentials from a `cuki.svc` JSON file ({ url, service_id, private_key }). */
  static fromCredsFile(path: string): Cuki {
    let parsed: { url?: string; service_id?: string; private_key?: string }
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"))
    } catch (e) {
      throw configError(`cannot read creds file ${path}: ${String(e)}`)
    }
    if (!parsed.url || !parsed.service_id || !parsed.private_key) {
      throw configError(`creds file ${path} missing url/service_id/private_key`)
    }
    return Cuki.make({ url: parsed.url, serviceId: parsed.service_id, privateKey: parsed.private_key })
  }

  /** Read CUKI_URL / CUKI_SERVICE_ID / CUKI_PRIVATE_KEY[_FILE], or CUKI_CREDS (cuki.svc). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Cuki {
    if (env.CUKI_CREDS) return Cuki.fromCredsFile(env.CUKI_CREDS)
    const url = env.CUKI_URL
    const serviceId = env.CUKI_SERVICE_ID
    let privateKey = env.CUKI_PRIVATE_KEY
    if (!privateKey && env.CUKI_PRIVATE_KEY_FILE) {
      privateKey = readFileSync(env.CUKI_PRIVATE_KEY_FILE, "utf8").trim()
    }
    if (!url || !serviceId || !privateKey) {
      throw configError("set CUKI_URL, CUKI_SERVICE_ID, and CUKI_PRIVATE_KEY (or CUKI_CREDS)")
    }
    return Cuki.make({ url, serviceId, privateKey })
  }

  async getSecret(name: string): Promise<string> {
    const entry = await this.fetchOpened<KeyEntry>(`/v1/secrets/${encodeURIComponent(name)}`)
    return entry.value
  }

  async getAll(): Promise<Record<string, string>> {
    const payload = await this.fetchOpened<{ keys: KeyEntry[] }>("/v1/secrets")
    const out: Record<string, string> = {}
    for (const k of payload.keys) out[k.name] = k.value
    return out
  }

  /** Assign granted keys into `process.env` (optionally only a subset). */
  async intoEnv(options: { only?: string[]; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
    const all = await this.getAll()
    const target = options.env ?? process.env
    const only = options.only ? new Set(options.only) : undefined
    for (const [name, value] of Object.entries(all)) {
      if (!only || only.has(name)) target[name] = value
    }
  }

  // ── internals ──

  private async ensureToken(force = false): Promise<string> {
    const now = Date.now()
    if (!force && this.token && this.token.expiresAt - REFRESH_SKEW_MS > now) {
      return this.token.value
    }
    const challenge = await this.post<{ challenge_id: string; nonce: string }>(
      "/v1/auth/challenge",
      { service_id: this.serviceId },
      authFailed,
    )
    const nonce = fromBase64(challenge.nonce)
    const signature = ed25519Sign(this.privateKey, buildAuthMessage(this.serviceId, nonce))
    const token = await this.post<{ access_token: string; expires_at: string }>(
      "/v1/auth/token",
      { challenge_id: challenge.challenge_id, signature: toBase64(signature) },
      authFailed,
    )
    this.token = { value: token.access_token, expiresAt: new Date(token.expires_at).getTime() }
    return this.token.value
  }

  private async fetchOpened<T>(path: string): Promise<T> {
    let attempt = 0
    for (;;) {
      const bearer = await this.ensureToken(attempt > 0)
      let res: Response
      try {
        res = await fetch(this.url + path, { headers: { authorization: `Bearer ${bearer}` } })
      } catch (e) {
        throw network(`request to ${path} failed: ${String(e)}`)
      }
      if (res.status === 401 && attempt === 0) {
        this.token = undefined
        attempt++
        continue
      }
      if (res.status === 401) throw unauthorized("access token rejected")
      if (res.status === 404) throw notFound(`not found: ${path}`)
      if (!res.ok) throw serverError(`server error ${res.status} for ${path}`)
      const sealed = (await res.json()) as { enc: string; ciphertext: string }
      return this.open<T>(sealed)
    }
  }

  private async open<T>(sealed: { enc: string; ciphertext: string }): Promise<T> {
    const skR = toX25519Private(this.privateKey)
    const info = buildSecretsInfo(this.serviceId)
    let opened: Uint8Array
    try {
      opened = await openFromRecipient(
        fromBase64(sealed.enc),
        skR,
        info,
        new Uint8Array(0),
        fromBase64(sealed.ciphertext),
      )
    } catch (e) {
      throw serverError(`failed to open sealed response: ${String(e)}`)
    }
    return JSON.parse(bytesToUtf8(opened)) as T
  }

  private async post<T>(
    path: string,
    body: unknown,
    onError: (m: string) => Error,
  ): Promise<T> {
    let res: Response
    try {
      res = await fetch(this.url + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    } catch (e) {
      throw network(`request to ${path} failed: ${String(e)}`)
    }
    if (res.status === 401) throw onError("service authentication failed")
    if (!res.ok) throw serverError(`server error ${res.status} for ${path}`)
    return (await res.json()) as T
  }
}
