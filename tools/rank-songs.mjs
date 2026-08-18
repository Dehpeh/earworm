// Assigns difficulty from real listening data instead of my guesswork.
//
//   node tools/rank-songs.mjs              # rank every pack
//   node tools/rank-songs.mjs pop rap      # limit to these
//   node tools/rank-songs.mjs --reband     # re-cut bands from cache, no network
//   node tools/rank-songs.mjs --retry-nulls # look up cached misses again
//
// Deezer allows ~10 requests/s. A cold run is ~12k lookups; run the packs as
// separate processes with GAP_MS=400 (about 45 min) rather than one at the
// default gap. Progress is saved every 50 tracks and a re-run resumes.
//
// WHY A SECOND API
//
// Difficulty used to be an artist fame tier I assigned by hand, combined with
// each track's position in an iTunes artist search. Measured, that came out ~93%
// determined by the tier alone, which made difficulty mean "how famous is the
// artist" rather than "how famous is the song". Turnstile's biggest song was
// hard; a soundtrack cut by a famous artist was easy.
//
// Apple's API has no popularity field of any kind. Deezer's does: every track
// carries a `rank`, and the endpoint needs no key, no OAuth and no account. So
// the catalog still comes from Apple (whose preview URLs are unsigned and
// long-lived, which is the whole reason the game has no backend) and only the
// difficulty signal comes from Deezer. No Deezer URL is ever stored or played —
// theirs expire in ~14 minutes, which is exactly why we don't use them.
//
// WHAT THE NUMBER IS AND IS NOT
//
// Deezer's rank tracks *recent* listening, not all-time recognition. "The Fate
// of Ophelia" outranks "Bohemian Rhapsody" on it. It is a far better signal
// than what it replaces, but it still skews current, and it is Deezer's
// audience rather than everyone's.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { norm, coreTitle, artistMatches } from '../src/itunes.js';

const PACKS = new URL('../src/packs/', import.meta.url);
const CACHE = new URL('./cache/deezer/', import.meta.url);
// Deezer allows about 50 requests per 5 seconds. 120ms keeps us at ~8/s with
// room to spare; there is no penalty box worth discovering.
const GAP_MS = Number(process.env.GAP_MS) || 120;

const argv = process.argv.slice(2);
const rebandOnly = argv.includes('--reband');
// Look up cached misses again — after the query got smarter, say. A hit is
// never re-fetched; ranks drift daily and re-cutting bands on noise is churn.
const retryNulls = argv.includes('--retry-nulls');
const only = argv.filter((a) => !a.startsWith('--'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is this Deezer hit actually the track we asked about? */
function isMatch(track, hit) {
  if (!hit?.title || !hit?.artist?.name) return false;
  if (!artistMatches(track.a, hit.artist.name)) return false;
  const a = coreTitle(track.t);
  const b = coreTitle(hit.title);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** Thrown when Deezer says slow down, so the caller retries instead of caching a null. */
class Throttled extends Error {}

async function deezerSearch(q) {
  const url = 'https://api.deezer.com/search?limit=10&q=' + encodeURIComponent(q);
  let data;
  try {
    const res = await fetch(url);
    if (res.status === 429) throw new Throttled();
    if (!res.ok) return [];
    data = await res.json();
  } catch (e) {
    if (e instanceof Throttled) throw e;
    return [];
  }
  // code 4 is "Quota limit exceeded". Anything else is a real miss.
  if (data?.error) {
    if (data.error.code === 4) throw new Throttled();
    return [];
  }
  return data.data || [];
}

/** "Lady Gaga & Bruno Mars" → "Lady Gaga"; Deezer's artist field is the lead. */
const leadArtist = (a) => String(a).split(/\s*[,&]\s*|\s+(?:feat|ft|featuring|with|x|vs)\.?\s+/i)[0].trim();

/** Title without bracketed tags or a dash suffix, for the query only. */
const bareTitle = (t) =>
  String(t)
    .replace(/\s*[([][^)\]]*[)\]]/g, '')
    .replace(/\s[-–—]\s.*$/, '')
    .trim();

/**
 * The song's rank on Deezer, or null.
 *
 * Two queries, most precise first. Deezer's free-text search for "Someone Like
 * You Adele" returns nothing but covers — the fielded form
 * `artist:"Adele" track:"Someone Like You"` finds the record. Titles are
 * stripped of their bracketed tags for the query, because "21 Questions (feat.
 * Nate Dogg)" verbatim returns zero hits. Both queries were measured: the old
 * free-text form alone left ~10% unmatched, and the misses included "Take On
 * Me", "Nothing Else Matters" and "Party In the U.S.A." — songs that then sank
 * to hard, which is precisely backwards.
 *
 * Among the hits that are this song, take the *highest* rank, not the first:
 * the first hit is often a live cut, a remix or a "(nightmare)" edit that
 * streams a fraction of the original, and difficulty is about the song.
 */
async function deezerRank(track) {
  const strip = (s) => String(s).replace(/"/g, '');
  const queries = [
    `artist:"${strip(leadArtist(track.a))}" track:"${strip(bareTitle(track.t))}"`,
    `${bareTitle(track.t)} ${leadArtist(track.a)}`,
  ];
  for (const q of queries) {
    const hits = (await deezerSearch(q)).filter((h) => isMatch(track, h));
    if (hits.length) return Math.max(...hits.map((h) => h.rank ?? 0)) || null;
    await sleep(GAP_MS);
  }
  return null;
}

async function rankWithRetry(track) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await deezerRank(track);
    } catch (e) {
      if (!(e instanceof Throttled) || attempt >= 6) throw e;
      const wait = 5000 * (attempt + 1);
      process.stdout.write(`  throttled, waiting ${wait / 1000}s\n`);
      await sleep(wait);
    }
  }
}

/**
 * Band shares. Not thirds.
 *
 * Equal thirds made "easy" the top 700 of a 2100-song pack, and the tail of that
 * is album cuts by mid-tier artists — nobody gets 80% of those. Easy is meant to
 * be the songs almost everyone knows, so it is the top slice only; medium is
 * the next slice; hard is everything else, including the unmatched tail. The
 * target is roughly 80-90% / 50% / 20% success for someone who knows the genre.
 */
export const BANDS = { easy: 0.15, medium: 0.3 };

/**
 * Cut a pack into bands by rank.
 *
 * Tracks Deezer could not identify keep a null rank and are pushed to the hard
 * end rather than dropped: an unmatched track is usually genuinely obscure, and
 * guessing wrong about that is much cheaper than losing the song.
 */
function reband(tracks, ranks) {
  const scored = tracks.map((t) => ({ t, r: ranks[t.i] ?? -1 }));
  scored.sort((a, b) => b.r - a.r); // most listened first
  const easyEnd = Math.ceil(scored.length * BANDS.easy);
  const mediumEnd = Math.ceil(scored.length * (BANDS.easy + BANDS.medium));
  scored.forEach((s, i) => {
    s.t.d = i < easyEnd ? 1 : i < mediumEnd ? 2 : 3;
  });
  return scored;
}

async function run() {
  await mkdir(CACHE, { recursive: true });
  const files = (await readdir(PACKS)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  const targets = only.length ? files.filter((f) => only.includes(f.replace('.json', ''))) : files;

  for (const file of targets) {
    const id = file.replace('.json', '');
    const pack = JSON.parse(await readFile(new URL(file, PACKS), 'utf8'));
    const cacheFile = new URL(`${id}.json`, CACHE);

    let ranks = {};
    try {
      ranks = JSON.parse(await readFile(cacheFile, 'utf8'));
    } catch {
      /* first run */
    }

    if (!rebandOnly) {
      const todo = pack.tracks.filter((t) => !(t.i in ranks) || (retryNulls && ranks[t.i] == null));
      if (todo.length) {
        process.stdout.write(`[${id}] ${todo.length} to look up\n`);
        for (let n = 0; n < todo.length; n++) {
          const t = todo[n];
          ranks[t.i] = await rankWithRetry(t);
          // Save as we go: a long run must survive ^C without losing progress.
          if (n % 50 === 0 || n === todo.length - 1) {
            await writeFile(cacheFile, JSON.stringify(ranks));
            process.stdout.write(`  ${n + 1}/${todo.length}\n`);
          }
          await sleep(GAP_MS);
        }
        await writeFile(cacheFile, JSON.stringify(ranks));
      }
    }

    const scored = reband(pack.tracks, ranks);
    await writeFile(new URL(file, PACKS), JSON.stringify(pack) + '\n');
    await updateIndex(id, pack.tracks);

    const matched = pack.tracks.filter((t) => ranks[t.i] != null).length;
    const top = scored.slice(0, 3).map((s) => `${s.t.a} - ${s.t.t}`);
    const n = (d) => pack.tracks.filter((t) => t.d === d).length;
    console.log(
      `[${id}] ${matched}/${pack.tracks.length} ranked` +
        ` (${Math.round((100 * matched) / pack.tracks.length)}%)` +
        ` · ${n(1)} easy / ${n(2)} medium / ${n(3)} hard · top: ${top.join(' | ')}`
    );
  }
}

/** The picker reads per-band counts from index.json; keep them honest. */
async function updateIndex(id, tracks) {
  const url = new URL('index.json', PACKS);
  let index;
  try {
    index = JSON.parse(await readFile(url, 'utf8'));
  } catch {
    return; // no index yet — build-packs writes it
  }
  const p = (index.packs || []).find((p) => p.id === id);
  if (!p) return;
  p.total = tracks.length;
  p.easy = tracks.filter((t) => t.d === 1).length;
  p.medium = tracks.filter((t) => t.d === 2).length;
  p.hard = tracks.filter((t) => t.d === 3).length;
  await writeFile(url, JSON.stringify(index, null, 1) + '\n');
}

await run();
