// Small user-agent classifier (no dependency). Good enough for dashboard breakdowns, not for fingerprinting.
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|headless|lighthouse|pagespeed|preview|curl|wget|python-requests|httpclient|monitor|uptime|scrapy/i;

export function parseUserAgent(ua = "") {
  const s = String(ua);

  let browser = "Other";
  if (/Edg(e|A|iOS)?\//.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/.test(s)) browser = "Opera";
  else if (/SamsungBrowser/.test(s)) browser = "Samsung Internet";
  else if (/Firefox|FxiOS/.test(s)) browser = "Firefox";
  else if (/Chrome|CriOS|Chromium/.test(s)) browser = "Chrome";
  else if (/Safari/.test(s)) browser = "Safari";

  let os = "Other";
  if (/iPhone|iPad|iPod/.test(s)) os = "iOS";
  else if (/Android/.test(s)) os = "Android";
  else if (/Windows NT/.test(s)) os = "Windows";
  else if (/Mac OS X|Macintosh/.test(s)) os = "macOS";
  else if (/CrOS/.test(s)) os = "ChromeOS";
  else if (/Linux/.test(s)) os = "Linux";

  let device = "desktop";
  if (/iPad|Tablet|PlayBook|Silk/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) device = "tablet";
  else if (/Mobi|iPhone|iPod/.test(s)) device = "mobile";

  return { isBot: !s || BOT.test(s), browser, os, device };
}

const KNOWN_SOURCES = [
  [/(^|\.)google\./, "Google"],
  [/(^|\.)bing\.com$/, "Bing"],
  [/duckduckgo/, "DuckDuckGo"],
  [/(^|\.)yahoo\./, "Yahoo"],
  [/baidu/, "Baidu"],
  [/yandex/, "Yandex"],
  [/facebook\.com$|(^|\.)fb\.com$|^l\.facebook/, "Facebook"],
  [/instagram/, "Instagram"],
  [/^t\.co$|twitter\.com$|(^|\.)x\.com$/, "X (Twitter)"],
  [/linkedin|lnkd\.in/, "LinkedIn"],
  [/^t\.me$|telegram/, "Telegram"],
  [/youtube|youtu\.be/, "YouTube"],
  [/reddit/, "Reddit"],
  [/behance/, "Behance"],
  [/dribbble/, "Dribbble"],
  [/pinterest/, "Pinterest"],
  [/github/, "GitHub"],
];

/** Hostname of an external referrer, or null for no/internal/invalid referrers. */
export function externalReferrerHost(referrer, selfHosts) {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, "");
    return selfHosts.has(host) ? null : host;
  } catch {
    return null;
  }
}

// Common spellings of utm_source values -> the same label referrers get, so "linkedin" and a LinkedIn referrer merge.
const UTM_ALIASES = {
  google: "Google", bing: "Bing", duckduckgo: "DuckDuckGo", yahoo: "Yahoo", facebook: "Facebook", fb: "Facebook",
  instagram: "Instagram", ig: "Instagram", twitter: "X (Twitter)", x: "X (Twitter)", linkedin: "LinkedIn",
  telegram: "Telegram", tg: "Telegram", youtube: "YouTube", yt: "YouTube", reddit: "Reddit", behance: "Behance",
  dribbble: "Dribbble", pinterest: "Pinterest", github: "GitHub",
};

/** A short traffic-source label: utm_source wins, then a recognised referrer, then the referrer host, else Direct. */
export function deriveSource({ utmSource, referrerHost }) {
  if (utmSource) return UTM_ALIASES[utmSource.toLowerCase().trim()] ?? utmSource.slice(0, 60);
  if (!referrerHost) return "Direct";
  return KNOWN_SOURCES.find(([re]) => re.test(referrerHost))?.[1] ?? referrerHost;
}
