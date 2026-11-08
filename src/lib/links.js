import { getDoc, setDoc } from "./store.js";

// Site-wide contact links edited in the admin (Settings -> Contact links):
//   bookingUrl  - Google Calendar appointment page the "Book a Call" button opens
//   telegramUrl - the Telegram chat the floating bubble opens
// Both are optional; the website falls back to the contact form while one is empty.

const BOOKING_HOSTS = new Set(["calendar.google.com", "calendar.app.google"]);
const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog"]);

/** Returns a clean https Google Calendar link, "" for empty input, or throws a readable error. */
export function normalizeBookingUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalid("Enter a full link, e.g. https://calendar.app.google/…");
  }
  if (url.protocol !== "https:" || !BOOKING_HOSTS.has(url.hostname)) {
    throw invalid("Use your Google Calendar booking page link (it starts with https://calendar.app.google/ or https://calendar.google.com/)");
  }
  if (url.pathname.replace(/\//g, "") === "") throw invalid("That link doesn't point to a booking page. Copy the booking page link from Google Calendar.");
  return url.toString();
}

/** Accepts "@name", "name", "t.me/name", "https://t.me/name" or an invite link and returns https://t.me/... */
export function normalizeTelegramUrl(input) {
  let raw = String(input ?? "").trim();
  if (!raw) return "";

  if (/^(https?:\/\/)?(www\.)?(t\.me|telegram\.me|telegram\.dog)\//i.test(raw)) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      throw invalid("That Telegram link isn't valid.");
    }
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!TELEGRAM_HOSTS.has(host) || !/^[A-Za-z0-9_+\-/]{3,100}$/.test(path)) throw invalid("That Telegram link isn't valid.");
    return `https://t.me/${path}`;
  }

  raw = raw.replace(/^@/, "");
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(raw)) {
    throw invalid("Use your Telegram username (5-32 letters, numbers or underscores), like @kriptystudio, or a t.me link.");
  }
  return `https://t.me/${raw}`;
}

/**
 * Cleans up any web address typed in the admin: "behance.net/x" becomes "https://behance.net/x".
 * Returns "" for empty input and throws a readable error for anything that isn't a plain http(s) link
 * (so "javascript:", "data:", "mailto:" and the like can never end up in an href on the website).
 */
export function normalizeWebUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  if (raw.length > 500) throw invalid("That link is too long (500 characters at most).");
  // No scheme (or "host:port/...") means https.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[\w.-]+:\d+(\/|$)/.test(raw);
  let url;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    throw invalid("Enter a valid web address, e.g. https://example.com/project");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid("Only web links (http or https) are allowed.");
  if (!url.hostname.includes(".")) throw invalid("Enter a valid web address, e.g. https://example.com/project");
  if (url.username || url.password) throw invalid("Remove the username and password from the link.");
  return url.toString();
}

const invalid = (message) => Object.assign(new Error(message), { status: 400 });

// Social profiles shown as buttons in the website footer (Telegram uses `telegramUrl`, shared with the chat bubble).
// `profile` turns a bare handle into a profile link; `isHost` decides whether a link really belongs to the platform.
const SOCIALS = {
  behanceUrl: { name: "Behance", profile: (h) => `https://www.behance.net/${h}`, isHost: (host) => matches(host, ["behance.net"]) },
  dribbbleUrl: { name: "Dribbble", profile: (h) => `https://dribbble.com/${h}`, isHost: (host) => matches(host, ["dribbble.com"]) },
  instagramUrl: { name: "Instagram", profile: (h) => `https://www.instagram.com/${h}`, isHost: (host) => matches(host, ["instagram.com"]) },
  xUrl: { name: "X (Twitter)", profile: (h) => `https://x.com/${h}`, isHost: (host) => matches(host, ["x.com", "twitter.com"]) },
  pinterestUrl: {
    name: "Pinterest",
    profile: (h) => `https://www.pinterest.com/${h}`,
    isHost: (host) => matches(host, ["pin.it"]) || /(^|\.)pinterest\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host),
  },
};
export const SOCIAL_KEYS = Object.keys(SOCIALS);

/** True when `host` is one of `domains` or a subdomain of one (www.instagram.com matches instagram.com). */
const matches = (host, domains) => domains.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * Accepts "@handle", "handle", "instagram.com/handle" or a full link and returns the profile URL.
 * Rejects links that belong to a different website, so a button can't silently point somewhere unexpected.
 */
export function normalizeSocialUrl(key, input) {
  const { name, profile, isHost } = SOCIALS[key];
  const raw = String(input ?? "").trim();
  if (!raw) return "";

  // A handle has no slash and doesn't name a website (so "kripty.studio" is a handle, "behance.net" is a site).
  const looksLikeLink = /[/:]/.test(raw) || /\.(com|net|it|co)(\b|$)/i.test(raw) || Object.values(SOCIALS).some((s) => s.isHost(raw.toLowerCase()));
  if (!looksLikeLink || raw.startsWith("@")) {
    const handle = raw.replace(/^@/, "");
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(handle)) throw invalid(`Enter your ${name} username (like @yourname) or the link to your profile.`);
    return profile(handle);
  }

  const url = normalizeWebUrl(raw);
  if (!isHost(new URL(url).hostname.toLowerCase())) throw invalid(`That isn't a link to ${name}. Paste your ${name} profile link or username.`);
  return url;
}

export async function getLinks() {
  const saved = (await getDoc("links")) ?? {};
  return {
    bookingUrl: saved.bookingUrl ?? "",
    telegramUrl: saved.telegramUrl ?? "",
    portfolioUrl: saved.portfolioUrl ?? "",
    ...Object.fromEntries(SOCIAL_KEYS.map((key) => [key, saved[key] ?? ""])),
  };
}

/** Only the fields present in `input` change; the rest keep their saved value. */
export async function saveLinks(input) {
  const current = await getLinks();
  const next = {
    bookingUrl: input.bookingUrl === undefined ? current.bookingUrl : normalizeBookingUrl(input.bookingUrl),
    telegramUrl: input.telegramUrl === undefined ? current.telegramUrl : normalizeTelegramUrl(input.telegramUrl),
    portfolioUrl: input.portfolioUrl === undefined ? current.portfolioUrl : normalizeWebUrl(input.portfolioUrl),
    ...Object.fromEntries(SOCIAL_KEYS.map((key) => [key, input[key] === undefined ? current[key] : normalizeSocialUrl(key, input[key])])),
  };
  await setDoc("links", next);
  return next;
}
