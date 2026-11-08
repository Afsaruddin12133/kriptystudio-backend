import { Router } from "express";
import { list } from "../lib/store.js";
import { getLinks } from "../lib/links.js";
import { getSlideshow } from "../lib/slideshow.js";
import { toUrl } from "./admin-content.js";

// Public, read-only content consumed by the website. Only published rows are exposed.
const router = Router();

const published = async (name) =>
  (await list(name)).filter((r) => r.published).sort((a, b) => a.order - b.order);

router.get("/faqs", async (_req, res, next) => {
  try {
    res.json({ items: (await published("faqs")).map(({ id, q, a }) => ({ id, q, a })) });
  } catch (err) {
    next(err);
  }
});

router.get("/works", async (req, res, next) => {
  try {
    res.json({ items: (await published("works")).map(({ id, src, alt, url }) => ({ id, src: toUrl(src, req), alt, url: url ?? "" })) });
  } catch (err) {
    next(err);
  }
});

// Booking page + Telegram chat used by the "Book a Call" button and the Telegram bubble.
router.get("/links", async (_req, res, next) => {
  try {
    res.json(await getLinks());
  } catch (err) {
    next(err);
  }
});

// How long the Client Stories slider stays on each slide.
router.get("/slideshow", async (_req, res, next) => {
  try {
    res.json(await getSlideshow());
  } catch (err) {
    next(err);
  }
});

router.get("/testimonials", async (req, res, next) => {
  try {
    const items = (await published("testimonials")).map(({ id, name, role, quote, avatar, video }) => ({
      id,
      name,
      role,
      quote,
      avatar: avatar ? toUrl(avatar, req) : null,
      video: video ? toUrl(video, req) : null,
    }));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

export default router;
