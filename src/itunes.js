// iTunes Search API helpers. Used only by tools/build-index.mjs at build time —
// the game itself never calls a network API for song metadata, it reads the
// prebaked src/resolved.json. See README for why.
//
// Two endpoints, two very different rate limits:
//
//   /search  — throttled to roughly 20 calls/minute per IP, then 403s for
//              minutes at a time. Needed once per artist to discover trackIds.
//   /lookup  — accepts up to ~200 comma-separated ids per call and appears to
//              be unthrottled (25 rapid calls all returned 200). This is how
//              preview URLs get refreshed later, essentially for free.
//
// Runs in both Node and the browser; it never touches the DOM.

const SEARCH = 'https://itunes.apple.com/search';
const LOOKUP = 'https://itunes.apple.com/lookup';

/** Thrown when Apple is throttling, to distinguish it from "no match". */
export class RateLimited extends Error {
  constructor() {
    super('iTunes Search API rate limit');
    this.name = 'RateLimited';
  }
}

/** Strip case, accents, punctuation and filler so fuzzy title matching works. */
export function norm(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Stable cache/index key for a catalog entry. */
export function trackKey(entry) {
  return `${norm(entry.artist)}|${norm(entry.title)}`;
}

// Qualifiers that describe *which cut* of a song this is, rather than being
// part of the name. Stripping them lets "Creep" match Radiohead's own
// "Creep (Acoustic)" when that's the only version the store will sell us —
// while the artist gate still keeps every cover band out.
const VARIANT =
  /\b(feat|ft|with|acoustic|live|remix|mixed|edit|version|remaster(ed)?|mono|stereo|demo|instrumental|radio|extended|single|album|deluxe|bonus|reprise|take|anniversary|original mix)\b/i;

/** Drop the parts of a store title that we never want to match on. */
function coreTitle(s) {
  let t = String(s);
  // Only strip a bracketed group when it actually looks like a variant tag, so
  // real titles survive: "Untitled (How Does It Feel)", "Doo Wop (That Thing)".
  t = t.replace(/\s*[([][^)\]]*[)\]]/g, (m) => (VARIANT.test(m) ? '' : m));
  t = t.replace(/\s[-–—]\s.*$/, (m) => (VARIANT.test(m) ? '' : m));
  return norm(t);
}

/** Cheap bounded edit distance, for romanization wobble like shinzou/shinzo. */
function within(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      best = Math.min(best, cur[j]);
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/**
 * True when an iTunes result plausibly *is* the catalog entry.
 *
 * This is a hard gate, not a scoring signal. The artist sweep asks for "every
 * song by X", so without it a missing track quietly resolves to some *other*
 * song by the same artist — three different Bad Bunny entries all collapsed
 * onto "NUEVAYoL" before this existed.
 *
 * Containment counts because classical and soundtrack entries get long store
 * names ("Symphony No. 5 in C Minor, Op. 67: I. Allegro con brio"), but only
 * for titles long enough that containment means something — otherwise "She"
 * matches half the store.
 */
function titleMatches(want, got) {
  const a = coreTitle(want);
  const b = coreTitle(got);
  if (!a || !b) return false;
  if (a === b) return true;

  const ax = a.replace(/ /g, '');
  const bx = b.replace(/ /g, '');
  if (ax === bx) return true;
  if (within(ax, bx, Math.max(1, Math.floor(ax.length * 0.12)))) return true;

  if (a.length >= 6 && b.includes(a)) return true;
  if (b.length >= 6 && a.includes(b)) return true;
  return false;
}

function artistMatches(want, got) {
  const a = norm(want);
  const b = norm(got);
  if (!a || !b) return false;
  if (a === b || b.includes(a) || a.includes(b)) return true;
  // "Seatbelts" vs "SEAT BELTS"
  const ax = a.replace(/ /g, '');
  const bx = b.replace(/ /g, '');
  if (ax === bx || bx.includes(ax) || ax.includes(bx)) return true;
  // Every meaningful word of the shorter name must appear in the longer one.
  // A single shared token is not enough: "Frank Ocean" and "Billy Ocean" share
  // a surname and are not the same artist.
  const at = a.split(' ').filter((t) => t.length > 2);
  const bt = b.split(' ').filter((t) => t.length > 2);
  if (!at.length || !bt.length) return false;
  const [short, long] = at.length <= bt.length ? [at, new Set(bt)] : [bt, new Set(at)];
  return short.every((t) => long.has(t));
}

/**
 * Cover mills, lullaby renditions and bootleg re-uploads. The store is full of
 * these and they match the title perfectly, so they have to be named to be
 * excluded — "Holocene" by Vitamin String Quartet is a real search result.
 */
const JUNK =
  /(karaoke|tribute|made popular|in the style of|cover version|instrumental version|string quartet|rockabye baby|twinkle twinkle|lullaby|8[-\s]?bit|sped up|sped now|nightcore|slowed|piano guys|music box|workout mix|drillhub|ringtone)/i;

function score(entry, r) {
  let s = 0;
  if (titleMatches(entry.title, r.trackName)) s += 10;
  if (artistMatches(entry.artist, r.artistName)) s += 8;
  if (coreTitle(entry.title) === coreTitle(r.trackName)) s += 4;
  if (norm(entry.artist) === norm(r.artistName)) s += 4;
  if (JUNK.test(r.collectionName || '') || JUNK.test(r.artistName || '')) s -= 30;
  if (/\blive\b/i.test(r.trackName || '') && !/\blive\b/i.test(entry.title)) s -= 6;
  return s;
}

/** Shape an iTunes result into what the game stores and uses. */
export function toRecord(r) {
  return {
    trackId: r.trackId,
    title: r.trackName,
    artist: r.artistName,
    album: r.collectionName || '',
    artwork: (r.artworkUrl100 || '').replace('100x100bb', '400x400bb'),
    previewUrl: r.previewUrl,
    storeUrl: r.trackViewUrl || '',
    year: (r.releaseDate || '').slice(0, 4),
  };
}

/**
 * Best result for `entry` out of `results`, or null when nothing matches.
 *
 * The title gate is mandatory. `requireArtist` is on for the artist sweep
 * (where we already know whose catalog we're reading, so a mismatch means a
 * cover or a wrong hit) and off for the targeted per-track fallback, which is
 * how classical entries resolve at all — the catalog credits the composer,
 * the store credits the performer.
 */
export function pickBest(entry, results, { requireArtist = false } = {}) {
  let best = null;
  let bestScore = -Infinity;
  for (const r of results || []) {
    if (!r.previewUrl || r.kind !== 'song') continue;
    if (!titleMatches(entry.title, r.trackName)) continue;
    if (requireArtist && !artistMatches(entry.artist, r.artistName)) continue;
    if (JUNK.test(r.artistName || '') || JUNK.test(r.collectionName || '')) continue;
    const s = score(entry, r);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  return best;
}

/**
 * Two-pass pick. Insisting on the credited artist first is what keeps
 * "Holocene — Bon Iver" from resolving to the Vitamin String Quartet cover.
 * `loose` then permits a performer who isn't the credited artist, which is the
 * only way classical and score packs resolve at all — the catalog credits the
 * composer and the store credits an orchestra.
 */
export function pickTrack(entry, results, { loose = false } = {}) {
  return (
    pickBest(entry, results, { requireArtist: true }) ||
    (loose ? pickBest(entry, results, { requireArtist: false }) : null)
  );
}

/** Does an already-stored manifest record still satisfy the current matcher? */
export function isGoodRecord(entry, record, { loose = false } = {}) {
  if (!record?.previewUrl || !record.trackId) return false;
  if (!titleMatches(entry.title, record.title)) return false;
  if (JUNK.test(record.artist || '') || JUNK.test(record.album || '')) return false;
  return loose || artistMatches(entry.artist, record.artist);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { fetchImpl = fetch, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchImpl(url);
      if (res.status === 403 || res.status === 429) {
        if (attempt >= retries) throw new RateLimited();
        await sleep(4000 * (attempt + 1));
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      if (e instanceof RateLimited) throw e;
      if (attempt >= retries) return null;
      await sleep(1000 * (attempt + 1));
    }
  }
}

/**
 * One throttled call that returns up to `limit` of an artist's songs, so every
 * catalog track by that artist can be matched from a single request.
 */
export async function searchArtist(artist, { country = 'US', limit = 200, ...opts } = {}) {
  const url =
    `${SEARCH}?term=${encodeURIComponent(artist)}` +
    `&media=music&entity=song&attribute=artistTerm&limit=${limit}&country=${country}`;
  const data = await getJson(url, opts);
  return data?.results || [];
}

/** Throttled single-song search — the fallback when the artist sweep misses. */
export async function searchTrack(entry, { country = 'US', ...opts } = {}) {
  const url =
    `${SEARCH}?term=${encodeURIComponent(`${entry.artist} ${entry.title}`)}` +
    `&media=music&entity=song&limit=25&country=${country}`;
  const data = await getJson(url, opts);
  return data?.results || [];
}

/**
 * Batch lookup by trackId. Unthrottled in practice, so this refreshes the whole
 * catalog's preview URLs in a handful of calls. Max ~200 ids per request.
 */
export async function lookupIds(ids, { country = 'US', ...opts } = {}) {
  if (!ids.length) return [];
  const url = `${LOOKUP}?id=${ids.join(',')}&entity=song&limit=200&country=${country}`;
  const data = await getJson(url, opts);
  return (data?.results || []).filter((r) => r.kind === 'song');
}
