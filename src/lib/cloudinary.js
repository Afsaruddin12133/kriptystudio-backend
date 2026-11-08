import { v2 as cloudinary } from "cloudinary";

// Where admin uploads (work images, testimonial avatars and videos) are stored.
//
// Configure either CLOUDINARY_URL (the single "cloudinary://key:secret@cloud" string from the Cloudinary dashboard)
// or the three CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET variables.
// Without credentials the API falls back to the local uploads folder, which is only meant for development.

const FOLDER = (process.env.CLOUDINARY_FOLDER || "kripty-studio").replace(/^\/+|\/+$/g, "");

function credentials() {
  const { CLOUDINARY_URL, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (CLOUDINARY_URL) {
    try {
      const url = new URL(CLOUDINARY_URL);
      if (url.protocol === "cloudinary:" && url.hostname && url.username && url.password) {
        return { cloud_name: url.hostname, api_key: decodeURIComponent(url.username), api_secret: decodeURIComponent(url.password) };
      }
    } catch {}
    return null;
  }
  if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
    return { cloud_name: CLOUDINARY_CLOUD_NAME, api_key: CLOUDINARY_API_KEY, api_secret: CLOUDINARY_API_SECRET };
  }
  return null;
}

let ready;
/** True when Cloudinary credentials are present (and the SDK has been configured with them). */
export function cloudinaryEnabled() {
  if (ready === undefined) {
    const creds = credentials();
    if (creds) cloudinary.config({ ...creds, secure: true });
    ready = Boolean(creds);
  }
  return ready;
}

const cloudName = () => cloudinary.config().cloud_name;

const failed = (what, err) => {
  console.error(`[cloudinary] ${what} failed:`, err?.message || err);
  return Object.assign(new Error("The file could not be uploaded. Try again in a moment."), { status: 502 });
};

const baseOptions = (resourceType) => ({
  resource_type: resourceType,
  folder: FOLDER,
  use_filename: false,
  unique_filename: true,
  overwrite: false,
});

/** Uploads an in-memory image. Resolves to its public https URL. */
export async function uploadImageBuffer(buffer) {
  try {
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(baseOptions("image"), (err, res) => (err ? reject(err) : resolve(res))).end(buffer);
    });
    return result.secure_url;
  } catch (err) {
    throw failed("image upload", err);
  }
}

/** Uploads a file from disk (chunked, so large videos are fine). Resolves to its public https URL. */
export async function uploadFromPath(filePath, resourceType) {
  try {
    const options = baseOptions(resourceType);
    const result = await new Promise((resolve, reject) => {
      const done = (err, res) => (err ? reject(err) : resolve(res));
      if (resourceType === "video") cloudinary.uploader.upload_large(filePath, { ...options, chunk_size: 6_000_000 }, done);
      else cloudinary.uploader.upload(filePath, options, done);
    });
    return result.secure_url;
  } catch (err) {
    throw failed(`${resourceType} upload`, err);
  }
}

// https://res.cloudinary.com/<cloud>/<image|video>/upload/v<version>/<folder>/<id>.<ext>
const URL_PATTERN = /^https:\/\/res\.cloudinary\.com\/([^/]+)\/(image|video)\/upload\/v\d+\/(.+)\.[A-Za-z0-9]+$/;

/** True for a Cloudinary address of ours (right account, inside our folder). Anything else is never touched. */
export function isOurCloudinaryUrl(src) {
  if (typeof src !== "string" || !cloudinaryEnabled()) return false;
  const match = URL_PATTERN.exec(src);
  return Boolean(match) && match[1] === cloudName() && match[3].startsWith(`${FOLDER}/`);
}

/** Deletes an uploaded file from Cloudinary. Ignores other addresses; a failure is logged, never thrown. */
export async function destroyByUrl(src) {
  if (!isOurCloudinaryUrl(src)) return;
  const [, , resourceType, publicId] = URL_PATTERN.exec(src);
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
  } catch (err) {
    console.warn(`[cloudinary] could not delete ${publicId}: ${err?.message || err}`);
  }
}

/** Serves images in the best format and quality for each browser (WebP/AVIF) by adding Cloudinary's f_auto,q_auto. */
export function optimizedImageUrl(src) {
  if (typeof src !== "string") return src;
  return src.replace(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(v\d+\/)/, "$1f_auto,q_auto/$2");
}
