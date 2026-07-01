/** Byte + encoding helpers. `Buffer` is available under Node, Bun, and the compiled binary. */

const enc = new TextEncoder()
const dec = new TextDecoder()

export const utf8ToBytes = (s: string): Uint8Array => enc.encode(s)
export const bytesToUtf8 = (b: Uint8Array): string => dec.decode(b)

export const toBase64 = (b: Uint8Array): string => Buffer.from(b).toString("base64")
export const fromBase64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"))

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex")
export const fromHex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"))

/** Concatenate byte arrays into one. */
export const concatBytes = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Best-effort zeroization (design 03): reduces exposure window; JS gives no hard guarantee. */
export const zeroize = (...arrs: ReadonlyArray<Uint8Array | undefined>): void => {
  for (const a of arrs) if (a) a.fill(0)
}

/** A 4-byte big-endian encoding of a non-negative integer, for AAD construction. */
export const u32be = (n: number): Uint8Array => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0, false)
  return b
}
