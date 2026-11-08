import { Router } from "express";
import { col } from "../lib/db.js";
import { list } from "../lib/store.js";

// Mounted inside the admin router, so every route here already requires a valid admin token.
const router = Router();

const DAY = 86_400_000;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const dayKey = (field) => ({ $dateToString: { format: "%Y-%m-%d", date: field } });
const top = (n = 8) => [{ $sort: { count: -1 } }, { $limit: n }];
const toRows = (docs) => docs.map((d) => ({ label: String(d._id ?? "Unknown"), count: d.count }));
const asMap = (docs) => new Map(docs.map((d) => [d._id, d.count]));
const LEAD_EVENTS = ["inquiry", "subscribe"];

/** visitorId -> the inquiry / subscriber that visitor became (so analytics can show who a person is). */
async function leadIndex() {
  const withVisitor = { visitorId: { $exists: true, $ne: null } };
  const index = new Map();
  for (const i of await list("inquiries", withVisitor)) {
    index.set(i.visitorId, { ...index.get(i.visitorId), inquiry: { id: i.id, name: i.name, email: i.email } });
  }
  for (const s of await list("subscribers", withVisitor)) {
    index.set(s.visitorId, { ...index.get(s.visitorId), subscriber: { id: s.id, email: s.email } });
  }
  return index;
}

const visitorOut = (v) => {
  const { _id, ...rest } = v;
  return { id: _id, ...rest };
};

// --- Overview --------------------------------------------------------------

// Dimension breakdowns use each visitor's latest known device/location; `field` is a fixed literal.
const DIMENSIONS = { countries: "country", timezones: "timezone", devices: "device", browsers: "browser", systems: "os", languages: "language" };

router.get("/overview", async (req, res, next) => {
  try {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const now = new Date();
    // Start of the first day in range (UTC), so the chart and the totals cover the same period.
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
    const onlineSince = new Date(now.getTime() - 5 * 60_000);
    const sessions = col("sessions");

    const [[sess], [ev], newVisitors, onlineIds, [dims], liveSessions] = await Promise.all([
      sessions
        .aggregate([
          { $match: { startedAt: { $gte: since } } },
          {
            $facet: {
              visitors: [{ $group: { _id: "$visitorId" } }, { $count: "n" }],
              totals: [
                {
                  $group: {
                    _id: null,
                    sessions: { $sum: 1 },
                    avgDuration: { $avg: { $divide: [{ $subtract: ["$lastSeen", "$startedAt"] }, 1000] } },
                    bounced: { $sum: { $cond: [{ $and: [{ $lte: ["$pageviews", 1] }, { $eq: ["$events", 0] }] }, 1, 0] } },
                  },
                },
              ],
              visitorsByDay: [{ $group: { _id: { d: dayKey("$startedAt"), v: "$visitorId" } } }, { $group: { _id: "$_id.d", count: { $sum: 1 } } }],
              sources: [{ $group: { _id: { $ifNull: ["$source", "Direct"] }, count: { $sum: 1 } } }, ...top()],
              campaigns: [{ $match: { utmCampaign: { $ne: null } } }, { $group: { _id: "$utmCampaign", count: { $sum: 1 } } }, ...top()],
            },
          },
        ])
        .toArray(),
      col("events")
        .aggregate([
          { $match: { ts: { $gte: since } } },
          {
            $facet: {
              pageviews: [{ $match: { name: "pageview" } }, { $count: "n" }],
              viewsByDay: [{ $match: { name: "pageview" } }, { $group: { _id: dayKey("$ts"), count: { $sum: 1 } } }],
              pages: [{ $match: { name: "pageview" } }, { $group: { _id: "$path", count: { $sum: 1 } } }, ...top()],
              leads: [
                { $match: { name: { $in: LEAD_EVENTS } } },
                { $group: { _id: null, n: { $sum: 1 }, people: { $addToSet: "$visitorId" } } },
                { $project: { n: 1, people: { $size: "$people" } } },
              ],
              leadsByDay: [{ $match: { name: { $in: LEAD_EVENTS } } }, { $group: { _id: dayKey("$ts"), count: { $sum: 1 } } }],
              actions: [
                { $match: { name: { $nin: ["pageview", "scroll", "section_view"] } } },
                { $group: { _id: { name: "$name", label: { $ifNull: ["$label", ""] } }, count: { $sum: 1 } } },
                ...top(12),
              ],
              scroll: [{ $match: { name: "scroll" } }, { $group: { _id: { l: "$label", s: "$sessionId" } } }, { $group: { _id: "$_id.l", count: { $sum: 1 } } }],
              sections: [{ $match: { name: "section_view" } }, { $group: { _id: { l: "$label", s: "$sessionId" } } }, { $group: { _id: "$_id.l", count: { $sum: 1 } } }, { $sort: { count: -1 } }],
            },
          },
        ])
        .toArray(),
      col("visitors").countDocuments({ firstSeen: { $gte: since } }),
      sessions.distinct("visitorId", { lastSeen: { $gte: onlineSince } }),
      sessions
        .aggregate([
          { $match: { startedAt: { $gte: since } } },
          { $group: { _id: "$visitorId" } },
          { $lookup: { from: "visitors", localField: "_id", foreignField: "_id", as: "v" } },
          { $unwind: "$v" },
          {
            $facet: Object.fromEntries(
              Object.entries(DIMENSIONS).map(([key, field]) => [
                key,
                [{ $group: { _id: { $ifNull: [`$v.${field}`, "Unknown"] }, count: { $sum: 1 } } }, ...top()],
              ]),
            ),
          },
        ])
        .toArray(),
      sessions.find({ lastSeen: { $gte: onlineSince } }).sort({ lastSeen: -1 }).limit(40).toArray(),
    ]);

    // Who is on the site right now, and on which page.
    const liveIds = [...new Set(liveSessions.map((s) => s.visitorId))].slice(0, 8);
    const [liveVisitors, livePages] = liveIds.length
      ? await Promise.all([
          col("visitors").find({ _id: { $in: liveIds } }).toArray(),
          col("events")
            .aggregate([
              { $match: { visitorId: { $in: liveIds }, name: "pageview" } },
              { $sort: { _id: -1 } },
              { $group: { _id: "$visitorId", path: { $first: "$path" } } },
            ])
            .toArray(),
        ])
      : [[], []];
    const visitorById = new Map(liveVisitors.map((v) => [v._id, v]));
    const pageById = new Map(livePages.map((p) => [p._id, p.path]));

    const totals = sess.totals[0] ?? { sessions: 0, avgDuration: 0, bounced: 0 };
    const visitorCount = sess.visitors[0]?.n ?? 0;
    const leads = ev.leads[0] ?? { n: 0, people: 0 };

    const visitorsByDay = asMap(sess.visitorsByDay);
    const viewsByDay = asMap(ev.viewsByDay);
    const leadsByDay = asMap(ev.leadsByDay);
    const series = Array.from({ length: days }, (_, n) => {
      const date = new Date(since.getTime() + n * DAY).toISOString().slice(0, 10);
      return { date, visitors: visitorsByDay.get(date) ?? 0, pageviews: viewsByDay.get(date) ?? 0, leads: leadsByDay.get(date) ?? 0 };
    });

    res.json({
      days,
      totals: {
        visitors: visitorCount,
        newVisitors,
        returningVisitors: Math.max(0, visitorCount - newVisitors),
        sessions: totals.sessions,
        pageviews: ev.pageviews[0]?.n ?? 0,
        avgSessionSeconds: Math.round(totals.avgDuration ?? 0),
        bounceRate: totals.sessions ? Math.round((totals.bounced / totals.sessions) * 100) : null,
        leads: leads.n,
        conversionRate: visitorCount ? Math.round((leads.people / visitorCount) * 1000) / 10 : null,
        online: onlineIds.length,
      },
      series,
      live: liveIds.map((id) => {
        const v = visitorById.get(id) ?? {};
        return { id, country: v.country ?? null, city: v.city ?? null, device: v.device ?? "", browser: v.browser ?? "", page: pageById.get(id) ?? null };
      }),
      sources: toRows(sess.sources),
      campaigns: toRows(sess.campaigns),
      pages: toRows(ev.pages),
      ...Object.fromEntries(Object.keys(DIMENSIONS).map((key) => [key, toRows(dims?.[key] ?? [])])),
      actions: ev.actions.map((a) => ({ name: a._id.name, label: a._id.label, count: a.count })),
      scroll: toRows(ev.scroll).sort((a, b) => Number(a.label) - Number(b.label)),
      sections: toRows(ev.sections),
    });
  } catch (err) {
    next(err);
  }
});

// --- Visitors --------------------------------------------------------------

const SEARCH_FIELDS = ["_id", "country", "city", "firstSource", "browser", "os", "ip", "timezone", "firstLanding"];

async function visitorFilter(query) {
  const leads = await leadIndex();
  const and = [];

  const q = String(query.q || "").trim().toLowerCase();
  if (q) {
    const pattern = new RegExp(escapeRegex(q), "i");
    // Also match people by the name/email they gave us in a form.
    const leadIds = [...leads]
      .filter(([, l]) => [l.inquiry?.name, l.inquiry?.email, l.subscriber?.email].some((f) => f?.toLowerCase().includes(q)))
      .map(([id]) => id);
    and.push({ $or: [...SEARCH_FIELDS.map((f) => ({ [f]: pattern })), ...(leadIds.length ? [{ _id: { $in: leadIds } }] : [])] });
  }
  for (const [param, field] of [["country", "country"], ["device", "device"], ["source", "firstSource"]]) {
    if (query[param]) and.push({ [field]: String(query[param]) });
  }
  if (query.converted === "yes") and.push({ _id: { $in: [...leads.keys()] } });
  if (query.converted === "no") and.push({ _id: { $nin: [...leads.keys()] } });

  return { leads, filter: and.length ? { $and: and } : {} };
}

router.get("/visitors", async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit) || 15));
    const { leads, filter } = await visitorFilter(req.query);
    const visitors = col("visitors");

    const [docs, total] = await Promise.all([
      visitors.find(filter).sort({ lastSeen: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      visitors.countDocuments(filter),
    ]);

    const ids = docs.map((v) => v._id);
    const lastPages = new Map(
      ids.length
        ? (
            await col("events")
              .aggregate([
                { $match: { visitorId: { $in: ids }, name: "pageview" } },
                { $sort: { _id: -1 } },
                { $group: { _id: "$visitorId", path: { $first: "$path" } } },
              ])
              .toArray()
          ).map((p) => [p._id, p.path])
        : [],
    );

    res.json({
      items: docs.map((v) => ({ ...visitorOut(v), lastPage: lastPages.get(v._id) ?? null, lead: leads.get(v._id) ?? null })),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
});

// Distinct values for the filter dropdowns.
router.get("/visitors/filters", async (_req, res, next) => {
  try {
    const values = async (field) => (await col("visitors").distinct(field)).filter(Boolean).sort().slice(0, 100);
    const [countries, devices, sources] = await Promise.all([values("country"), values("device"), values("firstSource")]);
    res.json({ countries, devices, sources });
  } catch (err) {
    next(err);
  }
});

function csvCell(v) {
  let s = v instanceof Date ? v.toISOString() : v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formulas
  return `"${s.replace(/"/g, '""')}"`;
}

router.get("/visitors/export", async (req, res, next) => {
  try {
    const { leads, filter } = await visitorFilter(req.query);
    const docs = await col("visitors").find(filter).sort({ lastSeen: -1 }).limit(10_000).toArray();
    const cols = [
      ["Visitor ID", "id"], ["First seen", "firstSeen"], ["Last seen", "lastSeen"], ["Sessions", "sessions"], ["Page views", "pageviews"],
      ["Country", "country"], ["City", "city"], ["Timezone", "timezone"], ["Language", "language"], ["Device", "device"],
      ["Browser", "browser"], ["OS", "os"], ["Screen", "screen"], ["IP", "ip"], ["First source", "firstSource"],
      ["First referrer", "firstReferrer"], ["Landing page", "firstLanding"], ["UTM source", "utmSource"], ["UTM medium", "utmMedium"], ["UTM campaign", "utmCampaign"],
    ];
    const header = [...cols.map((c) => c[0]), "Lead name", "Lead email"];
    const lines = docs.map((doc) => {
      const v = visitorOut(doc);
      const l = leads.get(v.id);
      return [...cols.map(([, k]) => v[k]), l?.inquiry?.name, l?.inquiry?.email ?? l?.subscriber?.email].map(csvCell).join(",");
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="visitors.csv"');
    res.send(`﻿${[header.map(csvCell).join(","), ...lines].join("\r\n")}`);
  } catch (err) {
    next(err);
  }
});

router.get("/visitors/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const visitor = await col("visitors").findOne({ _id: id });
    if (!visitor) return res.status(404).json({ error: "Visitor not found" });

    const [sessions, events, leads] = await Promise.all([
      col("sessions").find({ visitorId: id }).sort({ startedAt: -1 }).limit(30).toArray(),
      col("events").find({ visitorId: id }).sort({ _id: -1 }).limit(300).toArray(),
      leadIndex(),
    ]);

    res.json({
      visitor: visitorOut(visitor),
      lead: leads.get(id) ?? null,
      sessions: sessions.map((s) => ({
        id: s._id,
        startedAt: s.startedAt,
        lastSeen: s.lastSeen,
        landing: s.landing ?? null,
        referrer: s.referrer ?? null,
        source: s.source ?? null,
        utmSource: s.utmSource ?? null,
        utmMedium: s.utmMedium ?? null,
        utmCampaign: s.utmCampaign ?? null,
        pageviews: s.pageviews,
        events: s.events,
        seconds: Math.round((s.lastSeen - s.startedAt) / 1000),
      })),
      events: events.map((e) => ({ sessionId: e.sessionId, ts: e.ts, name: e.name, path: e.path ?? null, label: e.label ?? null })),
    });
  } catch (err) {
    next(err);
  }
});

// Erasure: removes the visitor with all their sessions and events (e.g. a privacy request).
router.delete("/visitors/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const { deletedCount } = await col("visitors").deleteOne({ _id: id });
    if (!deletedCount) return res.status(404).json({ error: "Visitor not found" });
    await Promise.all([col("sessions").deleteMany({ visitorId: id }), col("events").deleteMany({ visitorId: id })]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
