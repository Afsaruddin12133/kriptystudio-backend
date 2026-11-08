import { Router } from "express";
import { z } from "zod";
import { append, list, remove, reorder, update } from "../lib/store.js";
import { avatarAndVideo, commitAvatarAndVideo, deleteImage, deleteUpload, discardUploads, saveImage, singleImage } from "../lib/uploads.js";
import { notifyFrontend } from "../lib/revalidate.js";
import { getLinks, normalizeWebUrl, saveLinks } from "../lib/links.js";
import { getSlideshow, saveSlideshow } from "../lib/slideshow.js";

// Mounted inside the admin router, so every route here already requires a valid admin token.
const router = Router();

const byOrder = (a, b) => a.order - b.order;
const bool = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);
const ReorderSchema = z.object({ ids: z.array(z.string().max(64)).max(500) });

const firstIssue = (parsed) => parsed.error.issues[0]?.message || "Invalid input";

/** Registers list / create / patch / delete / reorder for an ordered collection. */
function orderedCollection(name, { createSchema, patchSchema, toPublic = (r) => r, hooks = {} }) {
  const base = `/${name}`;

  router.get(base, async (req, res, next) => {
    try {
      res.json({ items: (await list(name)).sort(byOrder).map((r) => toPublic(r, req)) });
    } catch (err) {
      await hooks.discard?.(req);
      next(err);
    }
  });

  // Declared before "/:id" so "reorder" is not treated as an id.
  router.post(`${base}/reorder`, async (req, res, next) => {
    const parsed = ReorderSchema.safeParse(req.body);
    if (!parsed.success) {
      await hooks.discard?.(req);
      return res.status(400).json({ error: firstIssue(parsed) });
    }
    try {
      const rows = await reorder(name, parsed.data.ids);
      notifyFrontend();
      res.json({ items: rows.map((r) => toPublic(r, req)) });
    } catch (err) {
      await hooks.discard?.(req);
      next(err);
    }
  });

  router.post(base, ...(hooks.upload ? [hooks.upload] : []), async (req, res, next) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      await hooks.discard?.(req);
      return res.status(400).json({ error: firstIssue(parsed) });
    }
    try {
      const extra = hooks.beforeCreate ? await hooks.beforeCreate(req) : {};
      const rows = await list(name);
      const order = rows.reduce((m, r) => Math.max(m, r.order), -1) + 1;
      const row = await append(name, { ...parsed.data, ...extra, order });
      notifyFrontend();
      res.status(201).json(toPublic(row, req));
    } catch (err) {
      await hooks.discard?.(req);
      next(err);
    }
  });

  router.patch(`${base}/:id`, ...(hooks.upload ? [hooks.upload] : []), async (req, res, next) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      await hooks.discard?.(req);
      return res.status(400).json({ error: firstIssue(parsed) });
    }
    try {
      const current = (await list(name)).find((r) => r.id === req.params.id);
      if (!current) {
        await hooks.discard?.(req);
        return res.status(404).json({ error: "Not found" });
      }
      const extra = hooks.beforeUpdate ? await hooks.beforeUpdate(req, current) : {};
      if (Object.keys(parsed.data).length + Object.keys(extra).length === 0) {
        return res.status(400).json({ error: "Nothing to update" });
      }
      const row = await update(name, req.params.id, { ...parsed.data, ...extra });
      if (hooks.afterUpdate) await hooks.afterUpdate(current, row);
      notifyFrontend();
      res.json(toPublic(row, req));
    } catch (err) {
      await hooks.discard?.(req);
      next(err);
    }
  });

  router.delete(`${base}/:id`, async (req, res, next) => {
    try {
      const current = (await list(name)).find((r) => r.id === req.params.id);
      if (!current || !(await remove(name, req.params.id))) return res.status(404).json({ error: "Not found" });
      if (hooks.afterDelete) await hooks.afterDelete(current);
      notifyFrontend();
      res.json({ ok: true });
    } catch (err) {
      await hooks.discard?.(req);
      next(err);
    }
  });
}

// --- Contact links (Book a Call + Telegram bubble) ---------------------------------------

router.get("/links", async (_req, res, next) => {
  try {
    res.json(await getLinks());
  } catch (err) {
    next(err);
  }
});

router.put("/links", async (req, res, next) => {
  try {
    const links = await saveLinks(req.body ?? {});
    notifyFrontend();
    res.json(links);
  } catch (err) {
    next(err);
  }
});

// --- Client Stories slider timing --------------------------------------------------------

router.get("/slideshow", async (_req, res, next) => {
  try {
    res.json(await getSlideshow());
  } catch (err) {
    next(err);
  }
});

router.put("/slideshow", async (req, res, next) => {
  try {
    const settings = await saveSlideshow(req.body ?? {});
    notifyFrontend();
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

// --- FAQs ------------------------------------------------------------------

const FaqFields = {
  q: z.string().trim().min(3, "Question is required").max(300),
  a: z.string().trim().min(3, "Answer is required").max(3000),
  published: bool,
};

orderedCollection("faqs", {
  createSchema: z.object({ ...FaqFields, published: bool.default(true) }),
  patchSchema: z.object(FaqFields).partial(),
});

// --- Works (portfolio images) ---------------------------------------------

// Where a click on the project card goes. Empty = the card is not a link.
const projectUrl = z.string().transform((value, ctx) => {
  try {
    return normalizeWebUrl(value);
  } catch (err) {
    ctx.addIssue({ code: "custom", message: err.message });
    return z.NEVER;
  }
});

const WorkFields = {
  alt: z.string().trim().min(3, "Describe the image (used as alt text)").max(200),
  url: projectUrl,
  published: bool,
};

orderedCollection("works", {
  createSchema: z.object({ alt: WorkFields.alt, url: projectUrl.default(""), published: bool.default(true) }),
  patchSchema: z.object(WorkFields).partial(),
  // Uploaded images are served by this API, so expose an absolute URL; bundled images stay relative.
  toPublic: (r, req) => ({ ...r, src: toUrl(r.src, req) }),
  hooks: {
    upload: singleImage("image"),
    beforeCreate: async (req) => {
      if (!req.file) throw Object.assign(new Error("An image is required"), { status: 400 });
      return { src: await saveImage(req.file) };
    },
    beforeUpdate: async (req) => (req.file ? { src: await saveImage(req.file) } : {}),
    afterUpdate: async (before, after) => {
      if (before.src !== after.src) await deleteImage(before.src);
    },
    afterDelete: (row) => deleteImage(row.src),
  },
});

// --- Testimonials (client stories: quote + optional avatar + optional preview video) ---------

const TestimonialFields = {
  name: z.string().trim().min(2, "Name is required").max(100),
  role: z.string().trim().min(2, "Role is required").max(120),
  quote: z.string().trim().min(10, "Add the testimonial text").max(1200),
  published: bool,
};

orderedCollection("testimonials", {
  createSchema: z.object({ ...TestimonialFields, published: bool.default(true) }),
  patchSchema: z.object(TestimonialFields).partial(),
  toPublic: (r, req) => ({ ...r, avatar: r.avatar ? toUrl(r.avatar, req) : null, video: r.video ? toUrl(r.video, req) : null }),
  hooks: {
    upload: avatarAndVideo(),
    discard: discardUploads,
    beforeCreate: (req) => commitAvatarAndVideo(req),
    beforeUpdate: async (req) => {
      const files = await commitAvatarAndVideo(req);
      // "removeVideo" lets the admin delete the current video without uploading a new one.
      if (!files.video && req.body?.removeVideo === "true") files.video = null;
      return files;
    },
    afterUpdate: async (before, after) => {
      if (before.avatar !== after.avatar) await deleteUpload(before.avatar);
      if (before.video !== after.video) await deleteUpload(before.video);
    },
    afterDelete: (row) => Promise.all([deleteUpload(row.avatar), deleteUpload(row.video)]),
  },
});

export function toUrl(src, req) {
  if (!src.startsWith("/uploads/")) return src;
  return `${process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`}${src}`;
}

export default router;
