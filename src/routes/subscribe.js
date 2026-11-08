import { Router } from "express";
import { z } from "zod";
import { append } from "../lib/store.js";
import { recordServerEvent } from "../lib/analytics.js";

const SubscribeSchema = z.object({
  email: z.string().trim().toLowerCase().email("A valid email is required").max(200),
  visitorId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
});

const router = Router();

router.post("/", async (req, res, next) => {
  const parsed = SubscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.flatten().fieldErrors });
  }
  try {
    const { email, visitorId } = parsed.data;
    const row = await append("subscribers", { email, visitorId });
    recordServerEvent(row.visitorId, "subscribe");
    res.status(201).json({ ok: true });
  } catch (err) {
    // The unique index on email makes a repeat sign-up a no-op instead of a duplicate row.
    if (err.code === 11000) return res.status(200).json({ ok: true, alreadySubscribed: true });
    next(err);
  }
});

export default router;
