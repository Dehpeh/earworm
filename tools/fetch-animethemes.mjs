// Downloads the AnimeThemes.moe catalog: every anime opening/ending/insert,
// with the song title, credited artists, the anime it belongs to and the
// OP1/ED2 slug. This is the mapping Apple's metadata simply does not have —
// nothing on an iTunes record says which anime a song opened.
//
//   node tools/fetch-animethemes.mjs
//
// Build-time only, like everything else in tools/. The output feeds
// build-packs.mjs, which labels each harvested anime track with its source
// ("Kimetsu no Yaiba OP1"). Roughly 200 pages at 100 rows each; the API is
// keyless and asks for reasonable pacing, so there is a gap between requests
// and progress is saved as it goes — ^C costs nothing.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const OUT = new URL('./cache/animethemes.json', import.meta.url);
const FIRST =
  'https://api.animethemes.moe/animetheme?page[size]=100' +
  '&fields[animetheme]=type,sequence,slug' +
  '&fields[anime]=name,year' +
  '&fields[song]=title' +
  '&fields[artist]=name' +
  '&include=anime,song.artists';
const GAP_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let state = { next: FIRST, rows: [] };
try {
  state = JSON.parse(await readFile(OUT, 'utf8'));
  if (!state.next) {
    console.log(`Already complete: ${state.rows.length} themes. Delete the file to refetch.`);
    process.exit(0);
  }
  console.log(`Resuming at ${state.rows.length} themes.`);
} catch {
  await mkdir(new URL('./cache/', import.meta.url), { recursive: true });
}

let page = 0;
while (state.next) {
  let data;
  try {
    // Their edge 403s a UA-less request; curl passes, bare Node fetch does not.
    const res = await fetch(state.next, {
      headers: { 'User-Agent': 'earworm-build/1.0 (song guessing game; one-time catalog build)' },
    });
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch (e) {
    // Transient failure: save and back off rather than losing the run.
    await writeFile(OUT, JSON.stringify(state));
    console.log(`  fetch failed (${e.message}) — saved, retrying in 15s`);
    await sleep(15_000);
    continue;
  }

  for (const t of data.animethemes || []) {
    if (!t.anime?.name || !t.song?.title) continue;
    state.rows.push({
      anime: t.anime.name,
      year: t.anime.year || 0,
      slug: t.slug || `${t.type || 'OP'}${t.sequence || 1}`,
      title: t.song.title,
      artists: (t.song.artists || []).map((a) => a.name).filter(Boolean),
    });
  }

  state.next = data.links?.next || null;
  page++;
  if (page % 20 === 0) {
    await writeFile(OUT, JSON.stringify(state));
    process.stdout.write(`  page ${page} · ${state.rows.length} themes\n`);
  }
  await sleep(GAP_MS);
}

await writeFile(OUT, JSON.stringify(state));
console.log(`Done: ${state.rows.length} themes.`);
