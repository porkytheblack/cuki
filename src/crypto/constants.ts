import { utf8ToBytes } from "../util/bytes"

/** Domain-separation tag for service auth challenge signatures (design 04). */
export const AUTH_DS = "cuki-auth-v1"

/** HPKE `info` prefix for sealed retrieval responses (design 03). */
export const SECRETS_INFO = "cuki-secrets-v1"

/**
 * Signing message for challenge–response:
 *   msg = "cuki-auth-v1" ∥ 0x00 ∥ service_id ∥ 0x00 ∥ nonce
 * The server always reconstructs this from its own stored service_id + nonce; it never
 * trusts a client-supplied message.
 */
export const buildAuthMessage = (serviceId: string, nonce: Uint8Array): Uint8Array => {
  const ds = utf8ToBytes(AUTH_DS)
  const sid = utf8ToBytes(serviceId)
  const out = new Uint8Array(ds.length + 1 + sid.length + 1 + nonce.length)
  let o = 0
  out.set(ds, o); o += ds.length
  out[o++] = 0x00
  out.set(sid, o); o += sid.length
  out[o++] = 0x00
  out.set(nonce, o)
  return out
}

/**
 * HPKE `info` for sealing a retrieval batch to a service:
 *   info = "cuki-secrets-v1" ∥ 0x00 ∥ service_id
 */
export const buildSecretsInfo = (serviceId: string): Uint8Array => {
  const tag = utf8ToBytes(SECRETS_INFO)
  const sid = utf8ToBytes(serviceId)
  const out = new Uint8Array(tag.length + 1 + sid.length)
  out.set(tag, 0)
  out[tag.length] = 0x00
  out.set(sid, tag.length + 1)
  return out
}
