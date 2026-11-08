import { col } from "./db.js";

const MAX_ROWS_PER_SESSION = 400; // stops a single tab from flooding the database
const DUPLICATE_KEY = 11000;

/** Event names only the server may record (so visitors can't fake conversions). */
export const RESERVED_EVENTS = new Set(["pageview", "inquiry", "subscribe"]);

/** Concurrent first hits from one visitor can race on the upsert; the loser just retries once. */
async function retryOnDuplicate(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.code !== DUPLICATE_KEY) throw err;
    return fn();
  }
}

/**
 * Stores one hit. `h` holds the validated client payload plus server-derived fields
 * (ip, country, device, source, ...). Returns false if the hit was ignored.
 */
export async function recordHit(h) {
  const sessions = col("sessions");
  const visitors = col("visitors");
  const now = new Date();
  const isPageview = h.type === "pageview";

  // 1) The session: created on its first hit, touched afterwards. The filter includes the visitor, so a
  //    session id that belongs to someone else collides on _id and is rejected.
  let created;
  try {
    const result = await sessions.updateOne(
      { _id: h.sid, visitorId: h.vid },
      {
        $set: { lastSeen: now },
        $setOnInsert: {
          startedAt: now,
          landing: h.path,
          referrer: h.referrerHost,
          source: h.source,
          utmSource: h.utm.source,
          utmMedium: h.utm.medium,
          utmCampaign: h.utm.campaign,
          pageviews: 0,
          events: 0,
        },
      },
      { upsert: true },
    );
    created = result.upsertedCount === 1;
  } catch (err) {
    if (err.code === DUPLICATE_KEY) return false;
    throw err;
  }

  // 2) The visitor: latest device/location details, plus first-touch details when first seen.
  const latest = { lastSeen: now, device: h.device, browser: h.browser, os: h.os };
  for (const [key, value] of Object.entries({ country: h.country, city: h.city, timezone: h.tz, language: h.lang, screen: h.screen, ip: h.ip })) {
    if (value) latest[key] = value;
  }
  await retryOnDuplicate(() =>
    visitors.updateOne(
      { _id: h.vid },
      {
        $set: latest,
        $setOnInsert: {
          firstSeen: now,
          firstReferrer: h.referrerHost,
          firstLanding: h.path,
          firstSource: h.source,
          utmSource: h.utm.source,
          utmMedium: h.utm.medium,
          utmCampaign: h.utm.campaign,
        },
        $inc: { sessions: created ? 1 : 0, pageviews: 0 },
      },
      { upsert: true },
    ),
  );

  if (h.type === "ping") return true;

  // 3) The event, within a per-session cap. The cap is checked atomically while bumping the counter.
  const bumped = await sessions.findOneAndUpdate(
    { _id: h.sid, $expr: { $lt: [{ $add: ["$pageviews", "$events"] }, MAX_ROWS_PER_SESSION] } },
    { $inc: isPageview ? { pageviews: 1 } : { events: 1 } },
  );
  if (!bumped) return true;

  await col("events").insertOne({
    visitorId: h.vid,
    sessionId: h.sid,
    ts: now,
    name: isPageview ? "pageview" : h.name,
    path: h.path,
    label: h.label ?? null,
  });
  if (isPageview) await visitors.updateOne({ _id: h.vid }, { $inc: { pageviews: 1 } });
  return true;
}

/** Records a conversion (e.g. "inquiry") against the visitor's most recent session, if we know them. */
export async function recordServerEvent(visitorId, name, label = null) {
  if (!visitorId) return;
  try {
    const session = await col("sessions").find({ visitorId }).sort({ lastSeen: -1 }).limit(1).next();
    if (!session) return;
    await col("events").insertOne({ visitorId, sessionId: session._id, ts: new Date(), name, path: null, label });
    await col("sessions").updateOne({ _id: session._id }, { $inc: { events: 1 } });
  } catch (err) {
    console.error("[analytics] could not record server event", err);
  }
}
