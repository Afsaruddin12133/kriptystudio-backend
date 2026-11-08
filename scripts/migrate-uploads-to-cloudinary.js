// One-off: moves files that were uploaded before Cloudinary (saved under /uploads/ on this machine's disk)
// to Cloudinary, and points the database at the new addresses. Safe to re-run: rows that already use a
// Cloudinary address are skipped, and the local files are left in place.
//
//   Needs CLOUDINARY_URL, MONGODB_URI and UPLOADS_DIR (the folder that holds the old files) in backend/.env
//   npm run migrate:cloudinary
import "dotenv/config";
import { access } from "node:fs/promises";
import path from "node:path";
import { cloudinaryEnabled, uploadFromPath } from "../src/lib/cloudinary.js";
import { closeDb, col, connectDb } from "../src/lib/db.js";
import { notifyFrontend } from "../src/lib/revalidate.js";
import { uploadsDir } from "../src/lib/uploads.js";

if (!cloudinaryEnabled()) {
  console.error("Cloudinary is not configured. Set CLOUDINARY_URL in backend/.env first.");
  process.exit(1);
}

// Which fields of which collection can hold an uploaded file.
const TARGETS = [
  { collection: "works", fields: ["src"] },
  { collection: "testimonials", fields: ["avatar", "video"] },
];

await connectDb();
let moved = 0;
const problems = [];

for (const { collection, fields } of TARGETS) {
  for (const doc of await col(collection).find({}).toArray()) {
    for (const field of fields) {
      const value = doc[field];
      if (typeof value !== "string" || !value.startsWith("/uploads/")) continue;

      const file = path.join(uploadsDir(), path.basename(value));
      try {
        await access(file);
      } catch {
        problems.push(`${collection}/${doc._id} ${field}: file not found at ${file}`);
        continue;
      }
      try {
        const url = await uploadFromPath(file, /\.(mp4|webm)$/i.test(value) ? "video" : "image");
        await col(collection).updateOne({ _id: doc._id }, { $set: { [field]: url, updatedAt: new Date() } });
        moved++;
        console.log(`moved ${collection}/${doc._id} ${field} -> ${url}`);
      } catch (err) {
        problems.push(`${collection}/${doc._id} ${field}: ${err.message}`);
      }
    }
  }
}

console.log(`\nDone: ${moved} file(s) moved to Cloudinary.`);
if (problems.length) console.log(`Needs attention (${problems.length}):\n- ${problems.join("\n- ")}`);
if (moved) notifyFrontend();
await closeDb();
