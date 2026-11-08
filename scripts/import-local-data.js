// One-off: copies data from the old local JSON files (backend/data/*.json) into MongoDB Atlas.
// Safe to re-run: it never overwrites content you've since edited in Atlas.
//
//   npm run import:local
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { closeDb, col, connectDb } from "../src/lib/db.js";

const dataDir = path.resolve(process.env.DATA_DIR || "data");

async function readJson(name, fallback) {
  try {
    return JSON.parse(await readFile(path.join(dataDir, `${name}.json`), "utf8"));
  } catch {
    return fallback;
  }
}

/** Old rows used `id` and ISO-string dates; Atlas documents use `_id` and real Dates. */
function toDoc(row) {
  const { id, createdAt, updatedAt, ...rest } = row;
  return {
    _id: id ?? crypto.randomUUID(),
    ...rest,
    createdAt: createdAt ? new Date(createdAt) : new Date(),
    ...(updatedAt ? { updatedAt: new Date(updatedAt) } : {}),
  };
}

await connectDb();
const report = [];

// Site content (FAQs, works, testimonials): replace the freshly seeded defaults with your local rows,
// unless someone already edited that collection in Atlas.
for (const name of ["faqs", "works", "testimonials"]) {
  const rows = await readJson(name, []);
  if (!rows.length) continue;
  if (await col(name).countDocuments({ updatedAt: { $exists: true } })) {
    report.push(`${name}: skipped (already edited in Atlas)`);
    continue;
  }
  await col(name).deleteMany({});
  await col(name).insertMany(rows.map(toDoc));
  await col("meta").updateOne({ _id: "seeded" }, { $addToSet: { collections: name } }, { upsert: true });
  report.push(`${name}: imported ${rows.length}`);
}

// Leads: added if missing, existing rows are left untouched.
for (const name of ["inquiries", "subscribers"]) {
  const rows = await readJson(name, []);
  let added = 0;
  for (const row of rows) {
    const doc = toDoc(row);
    const { upsertedCount } = await col(name).updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true }).catch((err) => {
      if (err.code === 11000) return { upsertedCount: 0 }; // e.g. that email is already subscribed
      throw err;
    });
    added += upsertedCount;
  }
  report.push(`${name}: ${rows.length ? `added ${added} of ${rows.length}` : "nothing to import"}`);
}

// Admin account (keeps a password you changed in Settings). Only set if Atlas has none yet.
const admin = await readJson("admin", null);
if (admin && !(await col("docs").findOne({ _id: "admin" }))) {
  await col("docs").insertOne({ _id: "admin", value: admin });
  report.push("admin account: imported");
} else {
  report.push(`admin account: ${admin ? "skipped (already exists in Atlas)" : "no local account"}`);
}

console.log(report.map((line) => `  • ${line}`).join("\n"));
await closeDb();
