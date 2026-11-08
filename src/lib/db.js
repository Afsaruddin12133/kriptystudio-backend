import { MongoClient } from "mongodb";

let client;
let db;

const redact = (message) => String(message).replace(/\/\/[^@\s]*@/g, "//***@");

/** Connects to MongoDB Atlas once and makes sure the indexes exist. Throws a readable error on failure. */
export async function connectDb() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set. Copy it from atlas-credentials.env into backend/.env.");

  client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000, appName: "kripty-studio-api", ignoreUndefined: true });
  try {
    await client.connect();
  } catch (err) {
    client = undefined;
    throw new Error(
      `Could not connect to MongoDB Atlas: ${redact(err.message)}\n` +
        "Check the username/password in MONGODB_URI and that this machine's IP address is allowed under Network Access in Atlas.",
    );
  }
  db = client.db(process.env.MONGODB_DB || "kripty");
  await ensureIndexes(db);
  return db;
}

export function getDb() {
  if (!db) throw new Error("Database is not connected yet");
  return db;
}

export const col = (name) => getDb().collection(name);

export async function pingDb() {
  await getDb().command({ ping: 1 });
}

export async function closeDb() {
  await client?.close();
  client = undefined;
  db = undefined;
}

/** Creates a TTL index, or updates its lifetime if the retention setting changed. */
async function ensureTtl(collection, field, seconds) {
  try {
    await collection.createIndex({ [field]: 1 }, { expireAfterSeconds: seconds });
  } catch (err) {
    if (err.code !== 85 && err.code !== 86) throw err; // index exists with a different lifetime
    await collection.s.db.command({ collMod: collection.collectionName, index: { keyPattern: { [field]: 1 }, expireAfterSeconds: seconds } });
  }
}

async function ensureIndexes(database) {
  const c = (name) => database.collection(name);
  const retention = (Number(process.env.TRACK_RETENTION_DAYS) || 395) * 86_400;

  await Promise.all([
    c("subscribers").createIndex({ email: 1 }, { unique: true }),
    c("subscribers").createIndex({ createdAt: -1 }),
    c("inquiries").createIndex({ createdAt: -1 }),
    c("inquiries").createIndex({ status: 1 }),
    c("inquiries").createIndex({ visitorId: 1 }, { sparse: true }),
    c("faqs").createIndex({ order: 1 }),
    c("works").createIndex({ order: 1 }),
    c("testimonials").createIndex({ order: 1 }),

    // Analytics. Old data expires on its own after TRACK_RETENTION_DAYS (default 395).
    ensureTtl(c("visitors"), "lastSeen", retention),
    c("visitors").createIndex({ firstSeen: 1 }),
    ensureTtl(c("sessions"), "lastSeen", retention),
    c("sessions").createIndex({ startedAt: 1 }),
    c("sessions").createIndex({ visitorId: 1, lastSeen: -1 }),
    ensureTtl(c("events"), "ts", retention),
    c("events").createIndex({ visitorId: 1, name: 1, _id: -1 }),
    c("events").createIndex({ name: 1, ts: 1 }),
    c("events").createIndex({ sessionId: 1 }),
  ]);
}
