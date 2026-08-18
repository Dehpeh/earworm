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
 * A credit fit for a row: at most three names, no "(CV: …)" voice-actor tags.
 *
 * Anime and game credits can run to a dozen names — an idol-group cast list
 * with the voice actor bracketed after every one — and the row is 40ch wide.
 * The full credit still drives search and matching; this is only what is
 * shown. "+N" says there is more without pretending it fits.
 */
export function shortArtist(a, max = 3) {
  const clean = String(a || '').replace(/\s*[([]\s*(?:CV|cv|C\.V\.)\s*[:：][^)\]]*[)\]]/g, '');
  const parts = clean
    .split(/\s*(?:,|&|\band\b|;|、|・|\/)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= max) return clean.trim();
  return `${parts.slice(0, max).join(', ')} +${parts.length - max}`;
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
    artistShort: shortArtist(row.a),
    album: row.b || '',
    year: row.y || '',
    previewUrl: row.p,
    artwork: row.w || '',
    difficulty: row.d,
    label: `${row.t} - ${shortArtist(row.a)}`,
    storeUrl: `https://music.apple.com/us/song/${row.i}`,
  };
}

async function loadPack(pack) {
  if (cache.has(pack.id)) return cache.get(pack.id);
  let data;
  if (pack.personal) {
    data = readPersonalPack() || { tracks: [] };
  } else {
    const res = await fetch(new URL(`${pack.id}.json`, BASE), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`pack ${pack.id} ${res.status}`);
    data = await res.json();
  }
  const tracks = (data.tracks || []).filter((r) => r.p).map((r) => expand(r, pack));
  cache.set(pack.id, tracks);
  return tracks;
}

/* ---------------------------------------------------------- personal pack */

// "Your Music" is a pack built in the browser from a connected Spotify
// account, matched to Apple previews and kept in localStorage. It uses the
// same stored shape as the built packs on purpose: one expand(), one loader,
// and every screen that iterates packs picks it up with no special casing.

export const PERSONAL_ID = 'spotify';
const PERSONAL_KEY = 'earworm.spotify.pack';

function readPersonalPack() {
  try {
    return JSON.parse(localStorage.getItem(PERSONAL_KEY));
  } catch {
    return null;
  }
}

/** Index entry for the personal pack, or null if none has been built. */
export function personalPackMeta() {
  const data = readPersonalPack();
  if (!data?.tracks?.length) return null;
  const n = (d) => data.tracks.filter((t) => t.d === d).length;
  return {
    id: PERSONAL_ID,
    name: 'Your Music',
    code: 'YOU',
    blurb: 'Your top and liked tracks, from Spotify',
    color: '#1DB954',
    total: data.tracks.length,
    easy: n(1),
    medium: n(2),
    hard: n(3),
    personal: true,
    builtAt: data.builtAt || null,
    source: data.source || null,
  };
}

/**
 * What an earlier import left behind, for the next one to build on: its rows
 * (with Spotify popularity kept) and which artists it already searched.
 */
export function personalPackState() {
  const data = readPersonalPack();
  return data ? { rows: data.tracks || [], searched: data.searched || {} } : null;
}

/** Store the personal pack (stored-shape rows) and drop the cache. */
export function savePersonalPack(rows, source, searched = {}) {
  cache.delete(PERSONAL_ID);
  localStorage.setItem(
    PERSONAL_KEY,
    JSON.stringify({ id: PERSONAL_ID, builtAt: Date.now(), source, searched, tracks: rows })
  );
}

export function clearPersonalPack() {
  cache.delete(PERSONAL_ID);
  localStorage.removeItem(PERSONAL_KEY);
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
