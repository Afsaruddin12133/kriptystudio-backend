import { getDoc, setDoc } from "./store.js";

// Timing of the Client Stories slider, edited in Admin -> Testimonials:
//   videoSeconds - 0 plays each video to the end; otherwise move on after this many seconds
//                  (a video shorter than that still moves on when it ends)
//   quoteSeconds - how long a testimonial without a video stays on screen
export const SLIDESHOW_LIMITS = { videoSeconds: { min: 3, max: 300 }, quoteSeconds: { min: 2, max: 120 } };
const DEFAULTS = { videoSeconds: 0, quoteSeconds: 6 };

const invalid = (message) => Object.assign(new Error(message), { status: 400 });

function parse(key, value) {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw invalid("Enter the time as a number of seconds.");
  if (key === "videoSeconds" && n === 0) return 0;
  const { min, max } = SLIDESHOW_LIMITS[key];
  if (n < min || n > max) {
    throw invalid(key === "videoSeconds" ? `Video time must be 0 (play the whole video) or ${min}-${max} seconds.` : `Text time must be ${min}-${max} seconds.`);
  }
  return Math.round(n * 10) / 10;
}

export async function getSlideshow() {
  const saved = (await getDoc("slideshow")) ?? {};
  return {
    videoSeconds: Number.isFinite(saved.videoSeconds) ? saved.videoSeconds : DEFAULTS.videoSeconds,
    quoteSeconds: Number.isFinite(saved.quoteSeconds) ? saved.quoteSeconds : DEFAULTS.quoteSeconds,
  };
}

/** Only the fields present in `input` change. */
export async function saveSlideshow(input) {
  const next = await getSlideshow();
  for (const key of Object.keys(DEFAULTS)) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== "") next[key] = parse(key, input[key]);
  }
  await setDoc("slideshow", next);
  return next;
}
