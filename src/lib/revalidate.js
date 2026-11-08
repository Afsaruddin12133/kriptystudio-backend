/** Tells the Next.js site to refresh cached CMS content. Fire-and-forget; the site also refreshes on its own schedule. */
export function notifyFrontend() {
  const { FRONTEND_URL, REVALIDATE_SECRET } = process.env;
  if (!FRONTEND_URL || !REVALIDATE_SECRET) return;
  fetch(`${FRONTEND_URL}/api/revalidate`, {
    method: "POST",
    headers: { "x-revalidate-secret": REVALIDATE_SECRET },
    signal: AbortSignal.timeout(5000),
  }).catch((err) => console.warn(`[revalidate] frontend not notified: ${err.message}`));
}
