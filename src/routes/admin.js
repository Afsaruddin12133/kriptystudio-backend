import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { ensureAdmin, requireAdmin, setAdminEmail, setAdminPassword, signToken, verifyPassword } from "../lib/auth.js";
import { col } from "../lib/db.js";
import { list, page, remove, update } from "../lib/store.js";
import { BUDGETS } from "./contact.js";
import contentRouter from "./admin-content.js";
import analyticsRouter from "./admin-analytics.js";

export const STATUSES = ["new", "contacted", "in_progress", "won", "lost"];

const router = Router();

const DAY = 86_400_000;
const withStatus = (row) => ({ status: "new", notes: "", ...row });
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function toCsv(rows, columns) {
  // Prefix cells that start with a formula character so spreadsheets don't execute them.
  const cell = (v) => {
    let s = v instanceof Date ? v.toISOString() : v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [columns.map((c) => cell(c.label)).join(","), ...rows.map((r) => columns.map((c) => cell(r[c.key])).join(","))].join("\r\n");
}

function sendCsv(res, name, csv) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.send(`﻿${csv}`);
}

const pagingOf = (query) => {
  const pageNumber = Math.max(1, Number.parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit) || 10));
  return { pageNumber, limit, skip: (pageNumber - 1) * limit };
};

// --- Auth ------------------------------------------------------------------

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." },
});

const LoginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) });

router.post("/login", loginLimiter, async (req, res, next) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Email and password are required" });
  try {
    const admin = await ensureAdmin();
    // Always verify a hash so response time doesn't reveal whether the email exists.
    const passwordOk = verifyPassword(parsed.data.password, admin.passwordHash);
    if (parsed.data.email !== admin.email || !passwordOk) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    res.json({ token: signToken(admin), email: admin.email });
  } catch (err) {
    next(err);
  }
});

router.use(requireAdmin);
router.use(contentRouter); // FAQs, works, testimonials
router.use("/analytics", analyticsRouter); // visitor tracking reports

router.get("/me", (req, res) => res.json({ email: req.admin.email }));

const PasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10, "Use at least 10 characters").max(200),
});

// Both account changes ask for the current password, so limit guessing it with a stolen session.
const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again later." },
});

const EmailSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newEmail: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
});

router.post("/email", accountLimiter, async (req, res, next) => {
  const parsed = EmailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
  }
  try {
    const admin = await ensureAdmin();
    if (!verifyPassword(parsed.data.currentPassword, admin.passwordHash)) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }
    if (parsed.data.newEmail === admin.email) {
      return res.status(400).json({ error: "That is already your sign-in email" });
    }
    const updated = await setAdminEmail(parsed.data.newEmail);
    // Other sessions are signed out; this one continues with a fresh token.
    res.json({ ok: true, email: updated.email, token: signToken(updated) });
  } catch (err) {
    next(err);
  }
});

router.post("/password", accountLimiter, async (req, res, next) => {
  const parsed = PasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
  }
  try {
    const admin = await ensureAdmin();
    if (!verifyPassword(parsed.data.currentPassword, admin.passwordHash)) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }
    await setAdminPassword(parsed.data.newPassword);
    res.json({ ok: true }); // Existing tokens are now invalid; the client must sign in again.
  } catch (err) {
    next(err);
  }
});

// --- Dashboard -------------------------------------------------------------

router.get("/stats", async (_req, res, next) => {
  try {
    const now = new Date();
    const start14 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 13));
    const last7 = { createdAt: { $gte: new Date(now.getTime() - 7 * DAY) } };
    const perDay = (since) => [
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
    ];

    const [total, statusRows, budgetRows, inquiryDays, subscribers, subscribers7, subscriberDays, inquiries7, recent] = await Promise.all([
      col("inquiries").countDocuments(),
      // Rows created before statuses existed count as "new".
      col("inquiries").aggregate([{ $group: { _id: { $ifNull: ["$status", "new"] }, count: { $sum: 1 } } }]).toArray(),
      col("inquiries").aggregate([{ $group: { _id: "$budget", count: { $sum: 1 } } }]).toArray(),
      col("inquiries").aggregate(perDay(start14)).toArray(),
      col("subscribers").countDocuments(),
      col("subscribers").countDocuments(last7),
      col("subscribers").aggregate(perDay(start14)).toArray(),
      col("inquiries").countDocuments(last7),
      list("inquiries", {}, { sort: { createdAt: -1 }, limit: 5 }),
    ]);

    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of statusRows) byStatus[r._id] = r.count;
    const byBudget = Object.fromEntries(BUDGETS.map((b) => [b, 0]));
    for (const r of budgetRows) byBudget[r._id] = r.count;

    const inquiriesByDay = new Map(inquiryDays.map((r) => [r._id, r.count]));
    const subscribersByDay = new Map(subscriberDays.map((r) => [r._id, r.count]));
    const series = Array.from({ length: 14 }, (_, n) => {
      const date = new Date(start14.getTime() + n * DAY).toISOString().slice(0, 10);
      return { date, inquiries: inquiriesByDay.get(date) ?? 0, subscribers: subscribersByDay.get(date) ?? 0 };
    });

    const decided = byStatus.won + byStatus.lost;
    res.json({
      totals: {
        inquiries: total,
        newInquiries: byStatus.new,
        inquiriesLast7Days: inquiries7,
        subscribers,
        subscribersLast7Days: subscribers7,
        winRate: decided ? Math.round((byStatus.won / decided) * 100) : null,
      },
      byStatus,
      byBudget,
      series,
      recent: recent.map(withStatus),
    });
  } catch (err) {
    next(err);
  }
});

// --- Inquiries -------------------------------------------------------------

function inquiryFilter({ q, status, budget }) {
  const filter = {};
  // Rows without a status are "new", and a null match also matches missing fields.
  if (status) filter.status = status === "new" ? { $in: ["new", null] } : String(status);
  if (budget) filter.budget = String(budget);
  const needle = String(q || "").trim();
  if (needle) {
    const pattern = new RegExp(escapeRegex(needle), "i");
    filter.$or = ["name", "email", "telegram", "details"].map((f) => ({ [f]: pattern }));
  }
  return filter;
}

router.get("/inquiries", async (req, res, next) => {
  try {
    const { pageNumber, limit, skip } = pagingOf(req.query);
    const { items, total } = await page("inquiries", { filter: inquiryFilter(req.query), sort: { createdAt: -1 }, skip, limit });
    res.json({ items: items.map(withStatus), total, page: pageNumber, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    next(err);
  }
});

router.get("/inquiries/export", async (req, res, next) => {
  try {
    const rows = (await list("inquiries", inquiryFilter(req.query), { sort: { createdAt: -1 } })).map(withStatus);
    sendCsv(
      res,
      "inquiries.csv",
      toCsv(rows, [
        { key: "createdAt", label: "Date" },
        { key: "name", label: "Name" },
        { key: "email", label: "Email" },
        { key: "telegram", label: "Telegram" },
        { key: "budget", label: "Budget" },
        { key: "status", label: "Status" },
        { key: "details", label: "Details" },
        { key: "notes", label: "Notes" },
      ]),
    );
  } catch (err) {
    next(err);
  }
});

const PatchSchema = z
  .object({ status: z.enum(STATUSES), notes: z.string().max(5000) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

router.patch("/inquiries/:id", async (req, res, next) => {
  const parsed = PatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
  try {
    const row = await update("inquiries", req.params.id, parsed.data);
    if (!row) return res.status(404).json({ error: "Inquiry not found" });
    res.json(withStatus(row));
  } catch (err) {
    next(err);
  }
});

router.delete("/inquiries/:id", async (req, res, next) => {
  try {
    if (!(await remove("inquiries", req.params.id))) return res.status(404).json({ error: "Inquiry not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Subscribers -----------------------------------------------------------

const subscriberFilter = ({ q }) => {
  const needle = String(q || "").trim();
  return needle ? { email: new RegExp(escapeRegex(needle), "i") } : {};
};

router.get("/subscribers", async (req, res, next) => {
  try {
    const { pageNumber, limit, skip } = pagingOf(req.query);
    const { items, total } = await page("subscribers", { filter: subscriberFilter(req.query), sort: { createdAt: -1 }, skip, limit });
    res.json({ items, total, page: pageNumber, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    next(err);
  }
});

router.get("/subscribers/export", async (_req, res, next) => {
  try {
    const rows = await list("subscribers", {}, { sort: { createdAt: -1 } });
    sendCsv(res, "subscribers.csv", toCsv(rows, [{ key: "email", label: "Email" }, { key: "createdAt", label: "Subscribed" }]));
  } catch (err) {
    next(err);
  }
});

router.delete("/subscribers/:id", async (req, res, next) => {
  try {
    if (!(await remove("subscribers", req.params.id))) return res.status(404).json({ error: "Subscriber not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
