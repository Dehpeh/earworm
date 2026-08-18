// Builds src/packs/*.json — the static song data the deployed game reads.
// Nothing here runs in the browser; the shipped site makes zero API calls.
//
//   node tools/build-packs.mjs             # fetch whatever isn't cached, then pack
//   node tools/build-packs.mjs pop rap     # limit to these genres
//   node tools/build-packs.mjs --repack    # re-derive from cache, no network at all
//   node tools/build-packs.mjs --refresh   # re-mint preview URLs via /lookup
//
// WHY IT SEEDS ON ARTISTS, NOT SONGS
//
// The old pipeline started from hand-written [title, artist] pairs and had to
// prove each one existed, which meant a throttled /search per artist *plus* a
// matcher strict enough to stop "Holocene" resolving to the Vitamin String
// Quartet. Seeding on artists deletes that entire problem: one /search returns
// the artist's own catalog, so every track harvested is real by construction.
// No unresolved rows, no wrong matches, no matcher to tune.
//
// THE CACHE IS THE POINT
//
// /search is capped near 20 calls/min and answers a burst with 403s that last
// minutes. So every raw response is written to tools/cache/ before anything is
// derived from it. Filtering, difficulty banding and per-artist caps can then
// be re-tuned as often as you like with --repack, which touches no network.
// Only adding new artists costs requests.

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { GENRES } from '../src/artists.js';
import { norm, coreTitle, artistMatches, lookupIds, JUNK, RateLimited } from '../src/itunes.js';

const SEARCH = 'https://itunes.apple.com/search';
const LOOKUP_URL = 'https://itunes.apple.com/lookup';
const CACHE = new URL('./cache/', import.meta.url);
const OUT = new URL('../src/packs/', import.meta.url);

const GAP_MS = Number(process.env.GAP_MS) || 4000;
const COOLDOWNS = [60_000, 120_000, 300_000, 600_000, 900_000];
// 200 is the API ceiling. Asking for the max costs the same one throttled call
// as asking for 20, and a deeper list is what feeds the hard difficulty band.
const SEARCH_LIMIT = 200;
const PER_ARTIST = Number(process.env.PER_ARTIST) || 6;
// Smoke-test escape hatch: LIMIT=3 exercises the whole pipeline for 3 requests
// instead of 750, which matters when a bad run costs an hour in the penalty box.
const LIMIT = Number(process.env.LIMIT) || Infinity;
const MIN_MS = 60_000; // below this it's a skit, an interlude or an intro

const argv = process.argv.slice(2);
const repack = argv.includes('--repack');
const refreshOnly = argv.includes('--refresh');
const only = argv.filter((a) => !a.startsWith('--'));
const genres = only.length ? GENRES.filter((g) => only.includes(g.id)) : GENRES;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ------------------------------------------------------------------- fetch */

/** Wait out a throttle rather than banking a false miss. */
async function patient(fn, label) {
  for (let cool = 0; ; cool++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof RateLimited)) throw e;
      const nap = COOLDOWNS[Math.min(cool, COOLDOWNS.length - 1)];
      process.stdout.write(`\n  throttled on ${label} — sleeping ${nap / 1000}s\n`);
      await sleep(nap);
    }
  }
}

/**
 * Resolve an artist NAME to Apple's artistId, then pull their songs by id.
 *
 * The plain artistTerm search is useless for one-word Japanese acts: "LiSA"
 * returns 200 tracks of Lisa Loeb, TLC and BLACKPINK's LISA, and the artist
 * actually asked for barely appears. A musicArtist search returns *artists*,
 * which can be exact-matched on name and disambiguated on Apple's own genre
 * field (LiSA is Anime/J-Pop, LISA is K-Pop) — and once the id is known, the
 * unthrottled /lookup returns that artist's songs and nobody else's.
 */
const JP_GENRES = /anime|j-pop|jpop|soundtrack|japan/i;

async function searchArtistById(artist) {
  const url =
    `${SEARCH}?term=${encodeURIComponent(artist)}` +
    `&media=music&entity=musicArtist&limit=25&country=US`;
  const res = await fetch(url);
  if (res.status === 403 || res.status === 429) throw new RateLimited();
  if (!res.ok) return [];
  const data = await res.json();
  const exact = (data?.results || []).filter((a) => norm(a.artistName) === norm(artist));
  if (!exact.length) return []; // unresolvable: drop, never guess
  exact.sort(
    (a, b) =>
      Number(JP_GENRES.test(b.primaryGenreName || '')) -
      Number(JP_GENRES.test(a.primaryGenreName || ''))
  );
  const hit = exact[0];
  const lookup = await fetch(
    `${LOOKUP_URL}?id=${hit.artistId}&entity=song&limit=200&country=US`
  );
  if (!lookup.ok) return [];
  const songs = await lookup.json();
  return (songs?.results || []).filter((r) => r.kind === 'song');
}

async function searchArtistRaw(artist) {
  const url =
    `${SEARCH}?term=${encodeURIComponent(artist)}` +
    `&media=music&entity=song&attribute=artistTerm&limit=${SEARCH_LIMIT}&country=US`;
  const res = await fetch(url);
  if (res.status === 403 || res.status === 429) throw new RateLimited();
  if (!res.ok) return [];
  const data = await res.json();
  return data?.results || [];
}

/** Cached artist fetch. Returns raw iTunes results, from disk when possible. */
async function artistResults(genre, artist) {
  const file = new URL(`${genre.id}/${slug(artist)}.json`, CACHE);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    /* not cached yet */
  }
  if (repack) return null; // --repack never touches the network
  const fetcher = genre.lookupArtist ? searchArtistById : searchArtistRaw;
  const results = await patient(() => fetcher(artist), artist);
  await mkdir(new URL(`${genre.id}/`, CACHE), { recursive: true });
  await writeFile(file, JSON.stringify(results));
  await sleep(GAP_MS);
  return results;
}

/* ------------------------------------------------------------------ derive */

/**
 * AnimeThemes.moe catalog, keyed norm(artist)|coreTitle(song) -> "Anime OP1".
 *
 * This is what makes the anime pack possible: nothing on an iTunes record says
 * which anime a song opened, so provenance has to come from a database whose
 * whole purpose is that mapping. When one song served several shows (covers,
 * re-uses), the earliest anime wins — that is the original use.
 */
async function themeIndex() {
  let raw;
  try {
    raw = JSON.parse(await readFile(new URL('./cache/animethemes.json', import.meta.url), 'utf8'));
  } catch {
    throw new Error('themeMatch genre needs the AnimeThemes catalog: run node tools/fetch-animethemes.mjs first');
  }
  if (raw.next) console.log(`WARNING: AnimeThemes download incomplete (${raw.rows.length} themes so far)`);
  const idx = new Map();
  for (const r of raw.rows) {
    const tkey = coreTitle(r.title);
    if (!tkey) continue;
    const label = `${r.anime} ${r.slug}`;
    for (const a of r.artists) {
      const k = norm(a) + '|' + tkey;
      const prev = idx.get(k);
      if (!prev || (r.year || 9999) < prev.year) idx.set(k, { label, year: r.year || 9999 });
    }
  }
  console.log(`AnimeThemes index: ${idx.size} artist|title keys from ${raw.rows.length} themes`);
  return idx;
}

/**
 * Which anime does this Apple track open, if any?
 *
 * Store titles carry suffixes the theme database does not ("Gurenge (TV
 * Version)", JP bracket text that norms down to stray tokens), so several
 * candidate title keys are tried, and both the seed name and the store credit
 * are tried as the artist.
 */
function themeFor(themes, seedArtist, r) {
  const raw = r.trackName || '';
  const titles = new Set([
    coreTitle(raw),
    norm(raw.split('(')[0]),
    norm(raw.split(/\s[-–—]\s/)[0]),
    norm(raw),
  ]);
  const artists = new Set([norm(seedArtist), norm(r.artistName || '')]);
  for (const a of artists) {
    if (!a) continue;
    for (const t of titles) {
      if (!t) continue;
      const hit = themes.get(a + '|' + t);
      if (hit) return hit.label;
    }
  }
  return null;
}

// Cuts that are not the song as people know it. Unlike the variant list in
// itunes.js — which only strips tags for *matching* — these are dropped
// outright, because guessing a song from 0.1s of a live recording or an
// instrumental is a different and much worse game.
const REJECT_TITLE =
  /\b(live|karaoke|instrumental|commentary|a[\s-]?cappella|acapella|demo|rehearsal|interlude|skit|reprise|intro|outro|medley|megamix|continuous mix|dj mix|backing track|sing[\s-]?along)\b/i;

// Remasters and radio edits are frequently the *only* version an old catalog
// sells, so they stay. Dedup by core title then keeps one per song.
// Compilations, label samplers and "X presents" albums put an artist's name on
// tracks that are not really theirs to be known for, and they rank high in an
// artistTerm search because the credit matches. A Wu-Tang family album cut is a
// real Raekwon song and a terrible thing to guess from 0.1 seconds.
const REJECT_ALBUM = /\b(presents|compilation|mixtape|sampler|various artists|riddim)\b/i;

function usable(r, genre) {
  if (r.kind !== 'song' || !r.previewUrl || !r.trackName) return false;
  if (REJECT_ALBUM.test(r.collectionName || '')) return false;
  if (/various artists/i.test(r.artistName || '')) return false;
  // A genre can carry an era. Filtering on release year rather than on the seed
  // list means an artist who spans the boundary contributes only the side of it
  // the pack wants, instead of being dropped whole.
  if (genre.minYear && Number((r.releaseDate || '').slice(0, 4)) < genre.minYear) return false;
  if ((r.trackTimeMillis || 0) < MIN_MS) return false;
  if (REJECT_TITLE.test(r.trackName)) return false;
  if (JUNK.test(r.trackName) || JUNK.test(r.artistName || '') || JUNK.test(r.collectionName || ''))
    return false;
  if (r.trackName.length > (genre.maxTitle || 60)) return false;
  return true;
}

/**
 * An artistTerm search mostly returns the artist you asked for, but features
 * and same-name acts leak in. Grouping by artistId and taking the group whose
 * credited name matches the seed is the reliable filter.
 *
 * For J-pop and K-pop the store credits in kana, kanji or hangul while the seed
 * is romanized, so no group matches by name. There the largest group is the
 * right answer: it is the artist whose catalog the query actually returned.
 */
function pickArtistGroup(results, artist, { nativeScript, anyArtist }) {
  // Classical is credited to the performer, not the composer, so a search for
  // one composer comes back spread across hundreds of orchestra artistIds.
  // Grouping at all throws most of it away; the artistTerm search itself is
  // already the filter that matters.
  if (anyArtist) return results;
  const groups = new Map();
  for (const r of results) {
    if (!r.artistId) continue;
    if (!groups.has(r.artistId)) groups.set(r.artistId, []);
    groups.get(r.artistId).push(r);
  }
  if (!groups.size) return [];

  // Rank the name-matching groups by how *well* they match, not by how big they
  // are. Taking the largest was the bug: searching the UK rapper "Dave" also
  // matches "Dave Matthews Band", whose catalog is far larger, so the band won.
  // Same for the Korean artist "DEAN" against "Olivia Dean". Exact credit beats
  // a leading-token match beats bare containment; size only breaks ties.
  const want = norm(artist);
  const quality = (g) => {
    const got = norm(g[0].artistName);
    if (got === want) return 0;
    if (got.startsWith(want + ' ')) return 1;
    return 2;
  };
  const byName = [...groups.values()].filter((g) => artistMatches(artist, g[0].artistName));
  if (byName.length) {
    byName.sort((a, b) => quality(a) - quality(b) || b.length - a.length);
    // A one-word seed with no exactly-credited group is unresolvable, not
    // merely fuzzy: the US store returns no solo "Dave" at all, so the best
    // remaining candidate is "Dave Matthews Band" — six wrong songs in a rap
    // pack. Losing the artist beats importing someone else.
    const oneWord = want.split(' ').length === 1;
    if (oneWord && !nativeScript && quality(byName[0]) !== 0) return [];
    return byName[0];
  }
  if (!nativeScript) return [];
  return [...groups.values()].sort((a, b) => b.length - a.length)[0];
}

function harvest(genre, themes) {
  const cap = genre.perArtist || PER_ARTIST;
  const rows = [];
  for (const [artist, tier, results] of genre.fetched) {
    const group = pickArtistGroup(results || [], artist, genre);
    const seen = new Set();
    let rank = 0;
    for (const r of group) {
      if (!usable(r, genre)) continue;
      const key = coreTitle(r.trackName);
      if (!key || seen.has(key)) continue; // same song, different release
      seen.add(key);
      let media = null;
      if (genre.themeMatch) {
        // The theme catalog is the real filter here: a track with no anime
        // behind it is not an anime theme, however good the artist.
        media = themeFor(themes, artist, r);
        if (!media) continue;
      }
      rows.push({ r, tier, rank, media });
      rank++;
      if (rank >= cap) break;
    }
  }
  return rows;
}

/**
 * Difficulty by rank, not by taste.
 *
 * Two signals combine: the artist's fame tier from artists.js, and where the
 * track sits inside that artist's own catalog (iTunes orders an artistTerm
 * search roughly by popularity, so rank 0 is the song they are known for).
 * Sorting on the pair and cutting into equal thirds means each band is always
 * a third of the pack, whatever mix of artists a genre happens to have — no
 * threshold to retune when the seed list changes.
 */
function assignDifficulty(rows) {
  rows.sort((a, b) => a.tier - b.tier || a.rank - b.rank || a.r.trackId - b.r.trackId);
  const third = Math.ceil(rows.length / 3);
  rows.forEach((row, i) => {
    row.difficulty = i < third ? 1 : i < third * 2 ? 2 : 3;
  });
  return rows;
}

function record(row) {
  const r = row.r;
  return {
    i: r.trackId,
    t: r.trackName,
    a: r.artistName,
    b: r.collectionName || '',
    y: (r.releaseDate || '').slice(0, 4),
    p: r.previewUrl,
    w: (r.artworkUrl100 || '').replace('100x100bb', '400x400bb'),
    d: row.difficulty,
    ...(row.media ? { m: row.media } : {}),
  };
}

/* ------------------------------------------------------------------- build */

async function build() {
  await mkdir(OUT, { recursive: true });

  // Fetch first, so a throttle stops the run before anything is half-written.
  for (const g of genres) {
    g.fetched = [];
    let missing = 0;
    const list = g.artists.slice(0, LIMIT);
    process.stdout.write(`\n[${g.code}] ${list.length} artists\n`);
    for (let i = 0; i < list.length; i++) {
      const [artist, tier] = list[i];
      const results = await artistResults(g, artist);
      if (results === null) missing++;
      g.fetched.push([artist, tier, results]);
      if ((i + 1) % 20 === 0) process.stdout.write(`  ${i + 1}/${list.length}\n`);
    }
    if (missing) process.stdout.write(`  ${missing} artists not cached (--repack skips network)\n`);
  }

  const themes = genres.some((g) => g.themeMatch) ? await themeIndex() : null;

  // One song belongs to one pack. Packs are processed in artists.js order, so
  // an overlap like an artist seeded in two genres lands wherever they appear
  // first.
  const claimed = new Set();
  const index = [];

  for (const g of genres) {
    const rows = harvest(g, themes).filter((row) => {
      const key = `${norm(row.r.artistName)}|${coreTitle(row.r.trackName)}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    });
    assignDifficulty(rows);
    const tracks = rows.map(record);
    const counts = { 1: 0, 2: 0, 3: 0 };
    for (const t of tracks) counts[t.d]++;

    await writeFile(new URL(`${g.id}.json`, OUT), JSON.stringify({ id: g.id, tracks }) + '\n');
    index.push({
      id: g.id,
      name: g.name,
      code: g.code,
      blurb: g.blurb,
      color: g.color,
      total: tracks.length,
      easy: counts[1],
      medium: counts[2],
      hard: counts[3],
    });
    console.log(
      `[${g.code}] ${tracks.length} songs · ${counts[1]} easy / ${counts[2]} medium / ${counts[3]} hard`
    );
  }

  // Merge into any existing index so a single-genre run doesn't drop the rest.
  let prev = [];
  try {
    prev = JSON.parse(await readFile(new URL('index.json', OUT), 'utf8')).packs || [];
  } catch {
    /* first run */
  }
  const merged = [...prev.filter((p) => !index.some((n) => n.id === p.id)), ...index];
  merged.sort((a, b) => GENRES.findIndex((g) => g.id === a.id) - GENRES.findIndex((g) => g.id === b.id));
  await writeFile(new URL('index.json', OUT), JSON.stringify({ packs: merged }, null, 1) + '\n');

  console.log(`\nTotal: ${merged.reduce((n, p) => n + p.total, 0)} songs across ${merged.length} packs.`);
  const thin = merged.filter((p) => p.total < 500);
  if (thin.length) {
    console.log(`\nUnder 500 — raise PER_ARTIST or add artists to src/artists.js:`);
    for (const p of thin) console.log(`  ${p.id}: ${p.total}`);
  }
}

/* ----------------------------------------------------------------- refresh */

// Apple's preview URLs are unsigned and long-lived, but they do rotate. /lookup
// takes ~200 ids at a time and is not throttled, so the entire catalog can be
// re-minted in a handful of requests. Run this if previews start 404ing.
async function refresh() {
  const files = (await readdir(OUT)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  for (const file of files) {
    const url = new URL(file, OUT);
    const pack = JSON.parse(await readFile(url, 'utf8'));
    const byId = new Map();
    for (let i = 0; i < pack.tracks.length; i += 190) {
      const chunk = pack.tracks.slice(i, i + 190).map((t) => t.i);
      for (const r of await patient(() => lookupIds(chunk), file)) byId.set(r.trackId, r);
    }
    let updated = 0;
    let gone = 0;
    pack.tracks = pack.tracks.filter((t) => {
      const r = byId.get(t.i);
      if (!r?.previewUrl) {
        gone++;
        return false;
      }
      t.p = r.previewUrl;
      t.w = (r.artworkUrl100 || '').replace('100x100bb', '400x400bb');
      updated++;
      return true;
    });
    await writeFile(url, JSON.stringify(pack) + '\n');
    console.log(`${file}: refreshed ${updated}, dropped ${gone}`);
  }
}

await (refreshOnly ? refresh() : build());
