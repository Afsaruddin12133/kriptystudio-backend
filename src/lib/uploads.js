import { mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";

export const uploadsDir = () => path.resolve(process.env.UPLOADS_DIR || "uploads");

const MAX_BYTES = 5 * 1024 * 1024;

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

/** Identify the image from its leading bytes; the client-supplied mimetype/filename is never trusted. */
function sniff(buf) {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

/** Validates and stores an uploaded image. Returns its public path (e.g. /uploads/ab12.png). */
export async function saveImage(file) {
  const ext = sniff(file.buffer);
  if (!ext) {
    const err = new Error("Only PNG, JPEG or WebP images are allowed");
    err.status = 400;
    throw err;
  }
  await mkdir(uploadsDir(), { recursive: true });
  const name = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
  await writeFile(path.join(uploadsDir(), name), file.buffer);
  return `/uploads/${name}`;
}

/** Deletes a previously uploaded file; ignores frontend-bundled images and missing files. */
export async function deleteUpload(src) {
  if (typeof src !== "string" || !/^\/uploads\/[a-f0-9]{24}\.(png|jpg|webp|mp4|webm)$/.test(src)) return;
  await unlink(path.join(uploadsDir(), path.basename(src))).catch(() => {});
}
export const deleteImage = deleteUpload;

// --- Media uploads (testimonial avatar + video) ---------------------------------------------
// Videos can be large, so they are streamed to a temp folder on disk instead of held in memory,
// then validated by their leading bytes and moved into place.

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const tmpDir = () => path.join(uploadsDir(), ".tmp");

const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => mkdir(tmpDir(), { recursive: true }).then(() => cb(null, tmpDir()), cb),
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString("hex")),
  }),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 2 },
});

function sniffVideo(head) {
  if (head.length > 12 && head.toString("ascii", 4, 8) === "ftyp") return "mp4";
  if (head.length > 4 && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "webm";
  return null;
}

async function readHead(file, bytes = 32) {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Removes any temp files multer wrote for this request (call whenever a request is rejected). */
export async function discardUploads(req) {
  const files = Object.values(req.files ?? {}).flat();
  await Promise.all(files.map((f) => unlink(f.path).catch(() => {})));
}

/** Multer middleware for a form with an optional "avatar" image and an optional "video". */
export const avatarAndVideo = () => (req, res, next) =>
  mediaUpload.fields([{ name: "avatar", maxCount: 1 }, { name: "video", maxCount: 1 }])(req, res, async (err) => {
    if (!err) return next();
    await discardUploads(req);
    res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Video must be 50 MB or smaller" : "Invalid upload" });
  });

/**
 * Validates the uploaded avatar/video of a request and moves them into the public uploads folder.
 * Returns { avatar?, video? } (public paths). Everything is cleaned up if either file is invalid.
 */
export async function commitAvatarAndVideo(req) {
  const result = {};
  const avatar = req.files?.avatar?.[0];
  const video = req.files?.video?.[0];
  const reject = async (message) => {
    await Promise.all([deleteUpload(result.avatar), deleteUpload(result.video), discardUploads(req)]);
    throw Object.assign(new Error(message), { status: 400 });
  };

  if (avatar) {
    const ext = sniff(await readHead(avatar.path));
    if (!ext) return reject("Avatar must be a PNG, JPEG or WebP image");
    if ((await stat(avatar.path)).size > MAX_BYTES) return reject("Avatar must be 5 MB or smaller");
    const name = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
    await rename(avatar.path, path.join(uploadsDir(), name));
    result.avatar = `/uploads/${name}`;
  }
  if (video) {
    const ext = sniffVideo(await readHead(video.path));
    if (!ext) return reject("Video must be an MP4 or WebM file");
    const name = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
    await rename(video.path, path.join(uploadsDir(), name));
    result.video = `/uploads/${name}`;
  }
  return result;
}

/** Wraps multer so its errors (too large, bad field) become clean 400 responses. */
export const singleImage = (field) => (req, res, next) =>
  upload.single(field)(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Image must be 5 MB or smaller" : "Invalid upload" });
  });
