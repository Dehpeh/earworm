// Loads the song data the game plays from.
//
// This used to be a hand-written array of ~700 [title, artist] pairs plus a
// separate resolved.json manifest. At six packs of 500+ songs those two files
// would be one 1.5MB download before the first note, most of it for packs the
// player did not pick. So the data is generated per pack by
// tools/build-packs.mjs and fetched on demand: the index is a few hundred bytes
// and tells the picker what exists, and a pack file is only read once someone
// selects it.
//
// Nothing here calls a music API. See CLAUDE.md for why that matters.

import { norm, workFromTheme } from './itunes.js';

const BASE = new URL('./packs/', import.meta.url);

/** Pack files are small and immutable between builds, so one fetch each. */
const cache = new Map();

/** Pack metadata for the picker: name, blurb, and per-difficulty counts. */
export async function loadIndex() {
  const res = await fetch(new URL('index.json', BASE), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`pack index ${res.status}`);
  const data = await res.json();
  return data.packs || [];
}

/**
 * Expand the on-disk shape into what the game uses.
 *
 * The stored keys are one letter each because the difference across ~3000
 * tracks is roughly 200KB of JSON, and this is the only place that knows it.
 */
function expand(row, pack) {
  // nt/na are normalized once here rather than per keystroke. The autocomplete
  // scans every loaded track on every input event, and norm() runs an NFD
  // normalize plus five replaces; at ~3000 tracks that was the slowest thing
  // in the typing path.
  const media = row.m || '';
  // The *work* is the guessable name behind the media credit: the show for an
  // anime theme ("Naruto: Shippuuden" out of "Naruto: Shippuuden OP3"), the
  // game for a soundtrack cut (already bare, the slot strip is a no-op).
  // Naming it is as good as naming the song.
  const work = workFromTheme(media);
  return {
    id: String(row.i),
    nt: norm(row.t),
    na: norm(row.a),
    // Anime tracks carry their source ("Kimetsu no Yaiba OP1"), game tracks
    // the game. It is part of the searchable text on purpose: people know
    // openings by show, not title.
    media,
    nm: norm(media),
    work,
    nw: norm(work),
    packId: pack.id,
    packName: pack.name,
    packCode: pack.code,
    title: row.t,
    artist: row.a,
    album: row.b || '',
    year: row.y || '',
    previewUrl: row.p,
    artwork: row.w || '',
    difficulty: row.d,
    label: `${row.t} - ${row.a}`,
    storeUrl: `https://music.apple.com/us/song/${row.i}`,
  };
}

async function loadPack(pack) {
  if (cache.has(pack.id)) return cache.get(pack.id);
  const res = await fetch(new URL(`${pack.id}.json`, BASE), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`pack ${pack.id} ${res.status}`);
  const data = await res.json();
  const tracks = (data.tracks || []).filter((r) => r.p).map((r) => expand(r, pack));
  cache.set(pack.id, tracks);
  return tracks;
}

/** Every track across the given packs, fetched in parallel. */
export async function loadTracks(packs) {
  const lists = await Promise.all(packs.map(loadPack));
  return lists.flat();
}

export const DIFFICULTIES = [
  { id: 1, name: 'Easy', key: 'easy', note: 'The hits' },
  { id: 2, name: 'Medium', key: 'medium', note: 'Known if you know the genre' },
  { id: 3, name: 'Hard', key: 'hard', note: 'Album tracks and B-sides' },
];
