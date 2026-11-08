import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import adminRouter from "./routes/admin.js";
import contactRouter from "./routes/contact.js";
import contentRouter from "./routes/content.js";
import subscribeRouter from "./routes/subscribe.js";
import trackRouter from "./routes/track.js";
import { defaultFaqs, defaultTestimonials, defaultWorks } from "./lib/defaults.js";
import { cloudinaryEnabled } from "./lib/cloudinary.js";
import { closeDb, connectDb, pingDb } from "./lib/db.js";
import { seedOnce } from "./lib/store.js";
import { uploadsDir } from "./lib/uploads.js";

// In production a missing setting would not fail loudly: sessions would silently die on every restart (JWT_SECRET)
// or the website would be blocked by CORS (CORS_ORIGIN). Refuse to start instead, so a bad deploy is obvious.
if (process.env.NODE_ENV === "production") {
  const missing = ["JWT_SECRET", "CORS_ORIGIN", "MONGODB_URI"].filter((name) => !process.env[name]);
  // Uploaded images and videos must go to Cloudinary: the server's own disk is wiped on every deploy.
  if (!cloudinaryEnabled()) missing.push("CLOUDINARY_URL (or CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET)");
  if (missing.length) {
    console.error(`\nMissing required environment variable(s): ${missing.join(", ")}. See backend/.env.example.\n`);
    process.exit(1);
  }
}

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

app.disable("x-powered-by");
// Behind a proxy/CDN, set TRUST_PROXY (e.g. 1) so req.ip is the real visitor address.
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === "true" ? true : trustProxy);
// Uploaded images are embedded by the website on another origin, so allow cross-origin loading.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: "20kb" }));

// Admin-uploaded images. Names are random, so they can be cached for a long time.
app.use("/uploads", express.static(uploadsDir(), { maxAge: "30d", immutable: true, index: false, dotfiles: "deny" }));

// Limit public form spam: 20 submissions per IP per 15 minutes (admin routes have their own limits).
const publicLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });

app.get("/api/health", async (_req, res) => {
  try {
    await pingDb();
    res.json({ status: "ok", database: "connected" });
  } catch {
    res.status(503).json({ status: "degraded", database: "unreachable" });
  }
});
app.use("/api/content", contentRouter);
// Visitor tracking beacons: generous limit because every page view, scroll milestone and heartbeat is a request.
app.use("/api/track", rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false }), trackRouter);
app.use("/api/contact", publicLimiter, contactRouter);
app.use("/api/subscribe", publicLimiter, subscribeRouter);
app.use("/api/admin", adminRouter);

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

try {
  await connectDb();
} catch (err) {
  console.error(`
${err.message}
`);
  process.exit(1);
}

await seedOnce("faqs", defaultFaqs);
await seedOnce("works", defaultWorks);
await seedOnce("testimonials", defaultTestimonials);

const server = app.listen(PORT, () => {
  console.log(`Kripty Studio API listening on port ${PORT} (MongoDB: ${process.env.MONGODB_DB || "kripty"}, uploads: ${cloudinaryEnabled() ? "Cloudinary" : "local folder"})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => closeDb().finally(() => process.exit(0))));
}
