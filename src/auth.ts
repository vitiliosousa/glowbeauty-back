import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export type AuthUser = { email: string; name: string };

function required(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta ${name} no .env`);
  return v;
}

export function adminEmail() {
  return required("ADMIN_EMAIL").trim().toLowerCase();
}

export function adminName() {
  return (process.env.ADMIN_NAME || "Administradora").trim();
}

export function adminPassword() {
  return required("ADMIN_PASSWORD");
}

function authSecret() {
  return required("AUTH_SECRET");
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const next = scryptSync(password, salt, 64);
  const prev = Buffer.from(hash, "hex");
  if (next.length !== prev.length) return false;
  return timingSafeEqual(next, prev);
}

export function checkPassword(
  password: string,
  passwordHash: string | null | undefined
) {
  if (passwordHash) return verifyPassword(password, passwordHash);
  const expected = Buffer.from(adminPassword());
  const got = Buffer.from(password);
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function signToken(email: string) {
  const payload = Buffer.from(
    JSON.stringify({ email, exp: Date.now() + 7 * DAY_MS })
  ).toString("base64url");
  const sig = createHmac("sha256", authSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyToken(token: string): { email: string } | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", authSecret())
    .update(payload)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      email?: string;
      exp?: number;
    };
    if (!data.email || !data.exp || data.exp < Date.now()) return null;
    if (data.email !== adminEmail()) return null;
    return { email: data.email };
  } catch {
    return null;
  }
}
