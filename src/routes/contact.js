import { Router } from "express";
import { z } from "zod";
import { append } from "../lib/store.js";
import { recordServerEvent } from "../lib/analytics.js";

export const BUDGETS = ["<1k", "1k-5k", "5k-10k", "10k-20k", "20k-50k", ">50k"];

const ContactSchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(100),
  telegram: z.string().trim().max(64).optional().or(z.literal("")),
  email: z.string().trim().email("A valid email is required").max(200),
  budget: z.enum(BUDGETS),
  details: z.string().trim().min(10, "Tell us a bit more about your project").max(5000),
  visitorId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
});

const router = Router();

router.post("/", async (req, res, next) => {
  const parsed = ContactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.flatten().fieldErrors });
  }
  try {
    const row = await append("inquiries", { ...parsed.data, status: "new", notes: "" });
    recordServerEvent(row.visitorId, "inquiry", row.budget);
    res.status(201).json({ ok: true, id: row.id });
  } catch (err) {
    next(err);
  }
});

export default router;
