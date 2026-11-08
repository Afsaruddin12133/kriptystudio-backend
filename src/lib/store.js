import { col } from "./db.js";

// Thin data layer over MongoDB. Documents use a string UUID as `_id`; the API exposes it as `id`.

const toRow = (doc) => {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
};

export async function append(collection, record) {
  const doc = { _id: crypto.randomUUID(), createdAt: new Date(), ...record };
  await col(collection).insertOne(doc);
  return toRow(doc);
}

export async function list(collection, filter = {}, options = {}) {
  return (await col(collection).find(filter, options).toArray()).map(toRow);
}

export async function findOne(collection, filter) {
  return toRow(await col(collection).findOne(filter));
}

export const count = (collection, filter = {}) => col(collection).countDocuments(filter);

/** One page of rows plus the total number of matches. */
export async function page(collection, { filter = {}, sort = { createdAt: -1 }, skip = 0, limit = 10 } = {}) {
  const c = col(collection);
  const [items, total] = await Promise.all([c.find(filter).sort(sort).skip(skip).limit(limit).toArray(), c.countDocuments(filter)]);
  return { items: items.map(toRow), total };
}

export async function update(collection, id, patch) {
  const doc = await col(collection).findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" });
  return toRow(doc);
}

export async function remove(collection, id) {
  return (await col(collection).deleteOne({ _id: id })).deletedCount === 1;
}

/** Rewrites `order` so rows follow `ids`; rows not listed keep their relative order after them. */
export async function reorder(collection, ids) {
  const c = col(collection);
  const rows = await c.find({}, { projection: { order: 1 } }).toArray();
  const rank = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (rank.get(a._id) ?? 1e9 + (a.order ?? 0)) - (rank.get(b._id) ?? 1e9 + (b.order ?? 0)));
  if (rows.length) await c.bulkWrite(rows.map((r, i) => ({ updateOne: { filter: { _id: r._id }, update: { $set: { order: i } } } })));
  return list(collection, {}, { sort: { order: 1 } });
}

/** Inserts default rows the first time a collection is used (never again, even if emptied later). */
export async function seedOnce(collection, rows) {
  const meta = col("meta");
  // Marking first makes this safe if two servers start at the same time: only one wins the marker.
  const marked = await meta.updateOne({ _id: "seeded" }, { $addToSet: { collections: collection } }, { upsert: true });
  if (!marked.upsertedCount && !marked.modifiedCount) return false;
  try {
    if ((await col(collection).estimatedDocumentCount()) === 0) {
      const now = new Date();
      await col(collection).insertMany(rows.map((r) => ({ _id: crypto.randomUUID(), createdAt: now, ...r })));
    }
  } catch (err) {
    await meta.updateOne({ _id: "seeded" }, { $pull: { collections: collection } });
    throw err;
  }
  return true;
}

// Single-document storage (used for the admin account).
export async function getDoc(name, fallback = null) {
  const doc = await col("docs").findOne({ _id: name });
  return doc ? doc.value : fallback;
}

export async function setDoc(name, value) {
  await col("docs").replaceOne({ _id: name }, { _id: name, value }, { upsert: true });
}
