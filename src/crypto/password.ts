import { argon2id } from "@noble/hashes/argon2.js"
import { fromBase64, toBase64, utf8ToBytes } from "../util/bytes"
import { random, timingSafeEqual } from "./keys"

/**
 * Argon2id password hashing (design 04): memory ≥ 19 MiB. Pure-JS (noble) so the single
 * binary needs no native module. Stored as a self-describing `argon2id$m$t$p$salt$hash`
 * string; verification re-derives with the recorded params and compares in constant time.
 */

const PARAMS = { m: 19456, t: 3, p: 1, dkLen: 32 } as const // m is KiB → 19 MiB

export const hashPassword = (password: string): string => {
  const salt = random(16)
  const hash = argon2id(utf8ToBytes(password), salt, PARAMS)
  return `argon2id$${PARAMS.m}$${PARAMS.t}$${PARAMS.p}$${toBase64(salt)}$${toBase64(hash)}`
}

export const verifyPassword = (password: string, stored: string): boolean => {
  const parts = stored.split("$")
  if (parts.length !== 6 || parts[0] !== "argon2id") return false
  const [, m, t, p, saltB64, hashB64] = parts
  try {
    const salt = fromBase64(saltB64!)
    const expected = fromBase64(hashB64!)
    const hash = argon2id(utf8ToBytes(password), salt, {
      m: Number(m),
      t: Number(t),
      p: Number(p),
      dkLen: expected.length,
    })
    return timingSafeEqual(hash, expected)
  } catch {
    return false
  }
}
