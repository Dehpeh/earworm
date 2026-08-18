// iTunes API helpers.
//
// Almost everything here runs at build time, inside tools/build-packs.mjs. The
// shipped game reads src/packs/*.json and makes exactly one kind of network
// request during a round: the audio file itself. See CLAUDE.md.
//
// Two endpoints, two very different rate limits:
//
//   /search  — throttled to roughly 20 calls/minute per IP, then 403s for
//              minutes at a time. Spent once per seed artist, at build time.
//   /lookup  — accepts up to ~200 comma-separated ids per call and appears to
//              be unthrottled (25 rapid calls all returned 200). This is how
//              preview URLs get refreshed, essentially for free, and it is the
//              one call the browser is ever allowed to make.
//
// Runs in both Node and the browser; it never touches the DOM.

const LOOKUP = 'https://itunes.apple.com/lookup';

/** Thrown when Apple is throttling, to distinguish it from "no match". */
export class RateLimited extends Error {
  constructor() {
    super('iTunes Search API rate limit');
    this.name = 'RateLimited';
  }
}

/** Strip case, accents, punctuation and filler so fuzzy matching works. */
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

// Qualifiers that describe *which cut* of a song this is, rather than being
// part of its name. Stripping them is what lets a remastered "Whole Lotta Love
// (2012 Remaster)" collapse onto the same song as the original when both are
// in an artist's catalog.
const VARIANT =
  /\b(feat|ft|with|acoustic|live|remix|mixed|edit|version|remaster(ed)?|mono|stereo|demo|instrumental|radio|extended|single|album|deluxe|bonus|reprise|take|anniversary|original mix)\b/i;

/** Normalized title with variant tags removed. The dedup key for a song. */
export function coreTitle(s) {
  let t = String(s);
  // Only strip a bracketed group when it actually looks like a variant tag, so
  // real titles survive: "Untitled (How Does It Feel)", "Doo Wop (That Thing)".
  t = t.replace(/\s*[([][^)\]]*[)\]]/g, (m) => (VARIANT.test(m) ? '' : m));
  t = t.replace(/\s[-–—]\s.*$/, (m) => (VARIANT.test(m) ? '' : m));
  return norm(t);
}

/**
 * The game (or show, or film) a soundtrack album belongs to.
 *
 * Apple's metadata has no "from the game" field; the game's name is buried in
 * the album title with a soundtrack tag hung off it, in a dozen house styles:
 * "Hades: Original Soundtrack", "Undertale Soundtrack", "DOOM (Original Game
 * Soundtrack)", "Cyberpunk 2077 - Original Score", "Minecraft - Volume Alpha".
 * This peels the tags off so a player can answer "Hades" and be right. It is a
 * heuristic — an artist album like "Endless Fantasy" comes back unchanged,
 * which is harmless: it becomes an alias for that album's songs and nothing
 * else.
 */
export function workFromAlbum(album) {
  let t = String(album || '').trim();
  if (!t) return '';
  // Leading framing: 'Anime "Kimetsu no Yaiba" ...', 'TV Animation "Steins;Gate 0"',
  // 'Piano Collections FINAL FANTASY ...', 'SYMPHONIC SUITE DRAGON QUEST VIII'.
  t = t.replace(/^(tv animation|anime|piano collections|symphonic suite)\s+/i, '');
  t = t.replace(/["“”]/g, '');
  // Bracketed soundtrack / edition tags anywhere in the title.
  t = t.replace(/\s*[([][^)\]]*[)\]]/g, (m) => (SOUNDTRACK_TAG.test(m) ? '' : m));
  // Trailing "Original Soundtrack", ": The Complete Soundtrack", " - Original
  // Score", " OST" and anything after them.
  t = t.replace(
    /\s*[-–—:,]?\s*(the\s+)?(complete\s+|official\s+|original\s+|super\s+)*(video\s?game\s+|game\s+|motion picture\s+|television\s+)?(sound\s?track|score|ost|music collection)\b.*$/i,
    ''
  );
  // Trailing volume markers: "Minecraft - Volume Alpha", "Halo 2, Vol. 1".
  t = t.replace(/\s*[-–—:,]?\s*(volume|vol\.?)\s+[\w.]+$/i, '');
  return t.replace(/\s*[-–—:,]\s*$/, '').trim() || String(album).trim();
}

const SOUNDTRACK_TAG =
  /(sound\s?track|score|\bost\b|game music|original tracks|version|edition|recording|remix|arranged|\bvol\b|disc)/i;

/**
 * The show behind an anime theme credit. The builder stores "Naruto: Shippuuden
 * OP3"; the guessable name is the part before the slot.
 */
export function workFromTheme(media) {
  return String(media || '')
    .replace(/\s+(OP|ED|IN|OST)\d*(-[A-Za-z0-9]+)?$/i, '')
    .trim();
}

/**
 * Whether two artist credits name the same act.
 *
 * Used to pick the right artistId out of a search that returned features and
 * same-name acts alongside the artist actually asked for.
 */
export function artistMatches(want, got) {
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
 * these and they credit themselves convincingly, so they have to be named to be
 * excluded — "Holocene" by Vitamin String Quartet is a real search result.
 */
export const JUNK =
  /(karaoke|tribute|made popular|in the style of|cover version|instrumental version|string quartet|rockabye baby|twinkle twinkle|lullaby|8[-\s]?bit|sped up|sped now|nightcore|slowed|piano guys|music box|workout mix|drillhub|ringtone)/i;

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

const SEARCH = 'https://itunes.apple.com/search';

/**
 * One throttled /search. Used at build time by the pack builder, and by the
 * "Your Music" import in the browser, which is the only runtime path allowed
 * to touch it — a one-off, paced at GAP_MS, never during a round. Throws
 * RateLimited on 403 so the caller can back off rather than cache a miss.
 */
export async function searchSongs(term, { attribute, limit = 200, country = 'US', ...opts } = {}) {
  const url =
    `${SEARCH}?term=${encodeURIComponent(term)}` +
    (attribute ? `&attribute=${attribute}` : '') +
    `&media=music&entity=song&limit=${limit}&country=${country}`;
  const data = await getJson(url, { retries: 0, ...opts });
  return (data?.results || []).filter((r) => r.kind === 'song');
}

/**
 * Batch lookup by trackId. Unthrottled in practice, so this re-mints the whole
 * catalog's preview URLs in a handful of calls at build time, and re-mints a
 * single dead URL from the browser on the rare occasion one rotates.
 * Max ~200 ids per request.
 */
export async function lookupIds(ids, { country = 'US', ...opts } = {}) {
  if (!ids.length) return [];
  const url = `${LOOKUP}?id=${ids.join(',')}&entity=song&limit=200&country=${country}`;
  const data = await getJson(url, opts);
  return (data?.results || []).filter((r) => r.kind === 'song');
}
