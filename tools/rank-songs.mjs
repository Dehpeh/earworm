// Assigns difficulty from real listening data instead of my guesswork.
//
//   node tools/rank-songs.mjs              # rank every pack
//   node tools/rank-songs.mjs pop rap      # limit to these
//   node tools/rank-songs.mjs --reband     # re-cut bands from cache, no network
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

async function deezerRank(track) {
  const url =
    'https://api.deezer.com/search?limit=5&q=' +
    encodeURIComponent(`${track.t} ${track.a}`);
  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }
  if (data?.error) return null;
  for (const hit of data.data || []) {
    if (isMatch(track, hit)) return hit.rank ?? null;
  }
  return null;
}

/**
 * Cut a pack into equal thirds by rank.
 *
 * Tracks Deezer could not identify keep a null rank and are pushed to the hard
 * end rather than dropped: an unmatched track is usually genuinely obscure, and
 * guessing wrong about that is much cheaper than losing the song.
 */
function reband(tracks, ranks) {
  const scored = tracks.map((t) => ({ t, r: ranks[t.i] ?? -1 }));
  scored.sort((a, b) => b.r - a.r); // most listened first
  const third = Math.ceil(scored.length / 3);
  scored.forEach((s, i) => {
    s.t.d = i < third ? 1 : i < third * 2 ? 2 : 3;
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
      const todo = pack.tracks.filter((t) => !(t.i in ranks));
      if (todo.length) {
        process.stdout.write(`[${id}] ${todo.length} to look up\n`);
        for (let n = 0; n < todo.length; n++) {
          const t = todo[n];
          ranks[t.i] = await deezerRank(t);
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

    const matched = pack.tracks.filter((t) => ranks[t.i] != null).length;
    const top = scored.slice(0, 3).map((s) => `${s.t.a} - ${s.t.t}`);
    console.log(
      `[${id}] ${matched}/${pack.tracks.length} ranked` +
        ` (${Math.round((100 * matched) / pack.tracks.length)}%) · top: ${top.join(' | ')}`
    );
  }
}

await run();
