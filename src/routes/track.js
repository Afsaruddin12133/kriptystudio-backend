import { Router } from "express";
import { z } from "zod";
import { RESERVED_EVENTS, recordHit } from "../lib/analytics.js";
import { deriveSource, externalReferrerHost, parseUserAgent } from "../lib/useragent.js";

const router = Router();

const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
// Descriptive fields are best-effort: a malformed value is dropped instead of rejecting the whole hit.
const lenient = (schema) => schema.optional().catch(undefined);
const short = (n) => lenient(z.string().trim().max(n));

const TrackSchema = z.object({
  vid: id,
  sid: id,
  type: z.enum(["pageview", "event", "ping"]),
  name: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
  label: short(200),
  path: z.string().trim().startsWith("/").max(300).default("/"),
  referrer: short(500),
  screen: lenient(z.object({ w: z.number().int().min(1).max(20000), h: z.number().int().min(1).max(20000) })),
  lang: short(35),
  tz: short(64),
  utm: z.object({ source: short(100), medium: short(100), campaign: short(100) }).catch({}).default({}),
});

/** Hostnames that count as "our own site" so internal navigation isn't reported as a referrer. */
function selfHosts(req) {
  const hosts = new Set(["localhost", "127.0.0.1"]);
  for (const url of [req.get("origin"), process.env.FRONTEND_URL, ...(process.env.CORS_ORIGIN || "").split(",")]) {
    try {
      hosts.add(new URL(url).hostname.replace(/^www\./, ""));
    } catch {}
  }
  return hosts;
}

/** Country/city come from CDN headers when the site is behind Cloudflare, Vercel or CloudFront. */
function geo(req) {
  const raw = req.get("cf-ipcountry") || req.get("x-vercel-ip-country") || req.get("cloudfront-viewer-country") || "";
  const country = /^[A-Za-z]{2}$/.test(raw) && !["XX", "T1"].includes(raw.toUpperCase()) ? raw.toUpperCase() : null;
  const cityRaw = req.get("x-vercel-ip-city") || req.get("cf-ipcity") || "";
  let city = null;
  try {
    city = cityRaw ? decodeURIComponent(cityRaw).slice(0, 80) : null;
  } catch {}
  return { country, city };
}

/** Stores a truncated IP by default (last IPv4 octet / IPv6 tail removed). Set TRACK_FULL_IP=true to keep it whole. */
function storedIp(ip) {
  if (!ip) return null;
  const clean = ip.replace(/^::ffff:/, "");
  if (process.env.TRACK_FULL_IP === "true" || clean === "::1" || clean === "127.0.0.1") return clean;
  if (clean.includes(".")) return `${clean.split(".").slice(0, 3).join(".")}.0`;
  if (clean.includes(":")) return `${clean.split(":").slice(0, 3).join(":")}::`;
  return null;
}

router.post("/", async (req, res) => {
  // Respect Do Not Track / Global Privacy Control even if the client script didn't.
  if (req.get("dnt") === "1" || req.get("sec-gpc") === "1") return res.status(204).end();

  const parsed = TrackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });
  const p = parsed.data;
  if (p.type === "event" && (!p.name || RESERVED_EVENTS.has(p.name))) return res.status(400).json({ error: "Invalid event" });

  const ua = parseUserAgent(req.get("user-agent"));
  if (ua.isBot) return res.status(204).end();

  const referrerHost = externalReferrerHost(p.referrer, selfHosts(req));
  const utm = { source: p.utm.source || null, medium: p.utm.medium || null, campaign: p.utm.campaign || null };

  try {
    await recordHit({
      ...p,
      utm,
      label: p.label || null,
      screen: p.screen ? `${p.screen.w}x${p.screen.h}` : null,
      lang: p.lang || null,
      tz: p.tz || null,
      referrerHost,
      source: deriveSource({ utmSource: utm.source, referrerHost }),
      ip: storedIp(req.ip),
      ...geo(req),
      device: ua.device,
      browser: ua.browser,
      os: ua.os,
    });
  } catch (err) {
    console.error("[analytics] failed to record hit", err);
  }
  res.status(204).end();
});

export default router;
