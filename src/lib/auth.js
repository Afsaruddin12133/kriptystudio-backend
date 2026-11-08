import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { getDoc, setDoc } from "./store.js";

const TOKEN_TTL = "8h";
let fallbackSecret;

function secret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  // Without a configured secret, sessions only live until the server restarts.
  fallbackSecret ??= crypto.randomBytes(32).toString("hex");
  return fallbackSecret;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/** Loads the admin account, creating it from ADMIN_EMAIL / ADMIN_PASSWORD on first run. */
export async function ensureAdmin() {
  const existing = await getDoc("admin");
  if (existing) return existing;

  const email = (process.env.ADMIN_EMAIL || "admin@kripty.studio").toLowerCase();
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(9).toString("base64url");
    console.log(`\n[admin] No ADMIN_PASSWORD set. Generated one-time password for ${email}: ${password}\n`);
  }
  const admin = { email, passwordHash: hashPassword(password), updatedAt: new Date().toISOString() };
  await setDoc("admin", admin);
  return admin;
}

export async function setAdminPassword(newPassword) {
  const admin = await ensureAdmin();
  const next = { ...admin, passwordHash: hashPassword(newPassword), updatedAt: new Date().toISOString() };
  await setDoc("admin", next);
  return next;
}

/** Changes the sign-in email. Bumping updatedAt also invalidates every token issued before the change. */
export async function setAdminEmail(newEmail) {
  const admin = await ensureAdmin();
  const next = { ...admin, email: String(newEmail).trim().toLowerCase(), updatedAt: new Date().toISOString() };
  await setDoc("admin", next);
  return next;
}

export const signToken =(admin) => jwt.sign({ sub: admin.email, pv: admin.updatedAt }, secret(), { expiresIn: TOKEN_TTL });

/** Express middleware: requires a valid Bearer token issued for the current password version. */
export async function requireAdmin(req, res, next) {
  try {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const payload = jwt.verify(token, secret());
    const admin = await ensureAdmin();
    if (payload.sub !== admin.email || payload.pv !== admin.updatedAt) throw new Error("stale");
    req.admin = { email: admin.email };
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}
