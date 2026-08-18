// Builds src/resolved.json — the static song manifest the deployed game reads.
// Nothing here runs in the browser; the shipped site makes zero API calls.
//
//   node tools/build-index.mjs             # discover whatever is missing
//   node tools/build-index.mjs --refresh   # re-mint preview URLs (fast, free)
//   node tools/build-index.mjs --force     # rediscover everything
//   node tools/build-index.mjs kpop jazz   # limit to these packs
//
// TWO STAGES, because Apple's two endpoints have wildly different limits:
//
//   discover  /search is throttled to ~20 calls/min. We spend one call per
//             *artist* (limit=200) and match every catalog track by that artist
//             out of the single response — 502 calls instead of 690. Slow and
//             patient, but it only ever has to happen once, because it records
//             each song's trackId.
//
//   refresh   /lookup takes ~200 ids per call and is effectively unthrottled,
//             so once trackIds are known the entire catalog's preview URLs can
//             be re-minted in about four requests. Run this if previews ever
//             start 404ing.
//
// Resumable and durable: it merges into the existing file and saves after every
// hit, so ^C costs you nothing.

import { readFile, writeFile } from 'node:fs/promises';
import { PACKS } from '../src/catalog.js';
import {
  searchArtist,
  searchTrack,
  lookupIds,
  pickBest,
  pickTrack,
  toRecord,
  trackKey,
  isGoodRecord,
  RateLimited,
} from '../src/itunes.js';

const OUT = new URL('../src/resolved.json', import.meta.url);
const GAP_MS = Number(process.env.GAP_MS) || 4000;
const COOLDOWNS = [60_000, 120_000, 300_000, 600_000, 900_000];
const BATCH = 190;

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const refreshOnly = argv.includes('--refresh');
// Repair runs: skip the artist sweep and go straight to per-track searches.
// The sweep has already failed for whatever is still missing, so re-running it
// just burns throttled requests.
const targeted = argv.includes('--targeted');
const only = argv.filter((a) => !a.startsWith('--'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let index = {};
try {
  index = JSON.parse(await readFile(OUT, 'utf8'));
} catch {
  /* first run */
}
const save = () => writeFile(OUT, JSON.stringify(index, null, 0) + '\n');

const packs = only.length ? PACKS.filter((p) => only.includes(p.id)) : PACKS;
const entries = packs.flatMap((p) =>
  p.tracks.map(([title, artist]) => ({ packId: p.id, title, artist, loose: !!p.looseArtist }))
);

/** Wait out a throttle instead of banking a false failure. */
async function patient(fn) {
  for (let cool = 0; ; cool++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof RateLimited)) throw e;
      const nap = COOLDOWNS[Math.min(cool, COOLDOWNS.length - 1)];
      process.stdout.write(`\n  throttled — sleeping ${nap / 1000}s\n`);
      await sleep(nap);
    }
  }
}

/* ------------------------------------------------------------------ refresh */

async function refresh() {
  const keyed = entries.map((e) => [trackKey(e), e]).filter(([k]) => index[k]?.trackId);
  const ids = keyed.map(([k]) => index[k].trackId);
  console.log(`Refreshing ${ids.length} known trackIds via /lookup…`);

  const byId = new Map();
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const results = await patient(() => lookupIds(chunk));
    for (const r of results) byId.set(r.trackId, r);
    console.log(`  batch ${i / BATCH + 1}: asked ${chunk.length}, got ${results.length}`);
  }

  let updated = 0;
  let gone = 0;
  for (const [key] of keyed) {
    const r = byId.get(index[key].trackId);
    if (r?.previewUrl) {
      index[key] = toRecord(r);
      updated++;
    } else {
      gone++;
    }
  }
  await save();
  console.log(`\nRefreshed ${updated}. No longer available: ${gone}.`);
  if (gone) console.log('Re-run without --refresh to rediscover those.');
}

/* ----------------------------------------------------------------- discover */

async function discover() {
  // Drop anything that no longer satisfies the matcher, so tightening the
  // matching rules automatically re-resolves the entries it now rejects.
  let pruned = 0;
  for (const e of entries) {
    const k = trackKey(e);
    if (index[k] && !isGoodRecord(e, index[k], { loose: e.loose })) {
      delete index[k];
      pruned++;
    }
  }
  if (pruned) {
    await save();
    console.log(`Pruned ${pruned} entries that failed the current matcher.`);
  }

  const todo = entries.filter((e) => force || !index[trackKey(e)]);
  console.log(
    `${Object.keys(index).length} already indexed · ${todo.length} to resolve` +
      ` · ${new Set(todo.map((e) => e.artist)).size} artist queries`
  );

  // Group by artist so one search can satisfy several catalog entries.
  const byArtist = new Map();
  for (const e of targeted ? [] : todo) {
    if (!byArtist.has(e.artist)) byArtist.set(e.artist, []);
    byArtist.get(e.artist).push(e);
  }

  const stragglers = targeted ? todo.slice() : [];
  let done = 0;

  for (const [artist, group] of byArtist) {
    const results = await patient(() => searchArtist(artist, { retries: 1 }));
    for (const e of group) {
      const hit = pickBest(e, results, { requireArtist: true });
      if (hit) index[trackKey(e)] = toRecord(hit);
      else stragglers.push(e);
    }
    await save();
    done++;
    if (done % 10 === 0) {
      process.stdout.write(
        `  ${done}/${byArtist.size} artists · ${Object.keys(index).length} indexed` +
          ` · ${stragglers.length} to retry\n`
      );
    }
    await sleep(GAP_MS);
  }

  // Anything the artist sweep missed gets one targeted per-track search.
  console.log(`\nArtist sweep done. Retrying ${stragglers.length} individually…`);
  const failures = [];
  for (const e of stragglers) {
    const results = await patient(() => searchTrack(e, { retries: 1 }));
    const hit = pickTrack(e, results, { loose: e.loose });
    if (hit) {
      index[trackKey(e)] = toRecord(hit);
      await save();
    } else {
      failures.push(e);
    }
    await sleep(GAP_MS);
  }

  await save();
  report(failures);
}

function report(failures) {
  console.log(`\nIndexed: ${Object.keys(index).length}/${entries.length}`);
  console.log(`Unresolved: ${failures.length}`);
  for (const f of failures) console.log(`  [${f.packId}] ${f.title} — ${f.artist}`);

  // Flag anything that landed on a clearly different artist — usually a typo.
  const odd = [];
  for (const e of entries) {
    const r = index[trackKey(e)];
    if (!r) continue;
    const a = e.artist.toLowerCase().replace(/[^a-z]/g, '').slice(0, 6);
    if (a && !r.artist.toLowerCase().replace(/[^a-z]/g, '').includes(a)) {
      odd.push(`  [${e.packId}] ${e.title} — ${e.artist}\n      -> ${r.title} — ${r.artist}`);
    }
  }
  console.log(`\nResolved to a different artist — review: ${odd.length}`);
  for (const o of odd) console.log(o);
}

await (refreshOnly ? refresh() : discover());
