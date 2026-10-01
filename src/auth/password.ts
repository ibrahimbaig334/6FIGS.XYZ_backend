import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";

// scrypt parameters targeting ~100ms per hash on commodity hardware.
const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

function scryptKey(
  password: string,
  salt: Buffer,
  keyLen: number,
  params: { N: number; r: number; p: number } = { N, r: R, p: P },
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCb(
      password,
      salt,
      keyLen,
      { ...params, maxmem: 64 * 1024 * 1024 },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived as Buffer);
      },
    );
  });
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MIN_PASSWORD_LEN = 10;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Stored form: scrypt$N$r$p$saltHex$derivedHex. Never the password itself. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = await scryptKey(password, salt, KEY_LEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, n, r, p, saltHex, derivedHex] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const derived = await scryptKey(
      password,
      Buffer.from(saltHex, "hex"),
      Buffer.from(derivedHex, "hex").length,
      { N: Number(n), r: Number(r), p: Number(p) },
    );
    const expected = Buffer.from(derivedHex, "hex");
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}