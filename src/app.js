import {
  loadIndex,
  loadTracks,
  DIFFICULTIES,
  PERSONAL_ID,
  personalPackMeta,
  personalPackState,
  savePersonalPack,
  clearPersonalPack,
} from './catalog.js';
import { norm, artistMatches, lookupIds } from './itunes.js';
import { SnippetPlayer } from './audio.js';
import { Sfx } from './sfx.js';
import * as spotify from './spotify.js';

/** How much of the clip you get to hear at each stage. */
const TIERS = [0.1, 0.5, 1, 2, 4, 8, 16];
/** Below this the window is too short for scrubbing to mean anything. */
const SCRUB_MIN = 1;
const LS = 'earworm.';

/* ------------------------------------------------------------------ storage */

const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(LS + k);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(LS + k, JSON.stringify(v));
    } catch {
      /* private mode / quota — the game still works, it just forgets */
    }
  },
};

/* --------------------------------------------------------------- seeded rng */

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

/** Days since epoch, in the player's local calendar. Steps once at local midnight. */
function dayIndex(key = todayKey()) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** Milliseconds until the next local midnight. */
function msToMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 50);
  return Math.max(1000, next - now);
}

/* ------------------------------------------------------------------ colour */

function relLum(hex) {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * Text colour for a filled crate, chosen by whichever of the two candidates
 * actually contrasts better. Twenty-three hand-picked hues span too wide a
 * lightness range for a fixed rule: dark ink is right on the yellows and
 * greens, wrong on the blues and the vermillion.
 */
function inkOn(hex) {
  const L = relLum(hex);
  const onDark = (L + 0.05) / (relLum('#17170e') + 0.05);
  const onLight = (relLum('#f7f7f5') + 0.05) / (L + 0.05);
  return onDark >= onLight ? '#17170e' : '#f7f7f5';
}

/* -------------------------------------------------------------------- state */

const player = new SnippetPlayer();
const sfx = new Sfx(player);

const state = {
  screen: 'home',
  mode: 'endless',
  packs: new Set(store.get('packs', ['pop', 'rap', 'rock'])),
  difficulty: store.get('difficulty', 2),
  index: [],
  pool: [], // candidate answers
  searchPool: [], // autocomplete space
  works: [], // guessable shows/games behind the pool, for autocomplete
  round: null,
  /** The daily being played: { pack, date }. Pinned at start so a round that
   *  crosses midnight still saves under the day it was dealt for. */
  daily: null,
  /** The date the home screen was last drawn for, to catch rollover. */
  homeDate: null,
  /** A running Spotify import: { controller, progress }. */
  importing: null,
  pending: null,
  hi: -1,
  matches: [],
  scrubbing: false,
};

const $ = (sel) => document.querySelector(sel);
const el = {};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const packMeta = (id) => state.index.find((p) => p.id === id);
const playablePacks = () => state.index.filter((p) => p.total > 0);

/* ------------------------------------------------------------------ motion */

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Replay the entrance for whatever is on screen.
 *
 * The screens are toggled with `hidden`, so an IntersectionObserver would only
 * ever fire once for elements that were never really "scrolled into" anything.
 * Resetting and re-arming per screen change is both simpler and what the
 * navigation actually means.
 */
function playReveal(root) {
  const items = [...root.querySelectorAll('[data-reveal]')];
  if (reduced()) {
    items.forEach((el) => el.classList.add('is-in'));
    return;
  }
  items.forEach((el) => el.classList.remove('is-in'));
  // Two frames: one for the removal to land, one for the transition to have a
  // start value to animate from.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      items.forEach((el, i) => {
        if (!el.style.getPropertyValue('--d')) el.style.setProperty('--d', `${i * 55}ms`);
        el.classList.add('is-in');
      });
    })
  );
}

/* ------------------------------------------------------------------ screens */

function show(screen) {
  state.screen = screen;
  el.home.hidden = screen !== 'home';
  el.crate.hidden = screen !== 'crate';
  el.game.hidden = screen !== 'game';
  if (screen !== 'game') player.stop();

  el.breadcrumb.textContent =
    screen === 'crate'
      ? 'Endless'
      : screen === 'game'
      ? state.mode === 'daily'
        ? `Daily · ${state.daily?.pack.name || ''} · ${state.daily?.date || todayKey()}`
        : 'Endless'
      : '';
  window.scrollTo({ top: 0, behavior: 'instant' });
  playReveal(screen === 'home' ? el.home : screen === 'crate' ? el.crate : el.game);
}

/* --------------------------------------------------------------------- home */

/**
 * Daily is one song per genre per day, the same for everyone, every difficulty
 * in play, one attempt each. Results live under `daily.<date>.<packId>`.
 *
 * The song is not a hash of the date. Each pack has one fixed shuffle (seeded
 * on the pack id, over tracks sorted by id so the file order does not matter),
 * and day N plays entry N of that shuffle. That guarantees no repeat until the
 * whole pack has been played — a per-day hash would repeat by chance within a
 * couple of months. A rebuild that adds songs reshuffles, which is fine.
 */
function dailyKey(packId, date) {
  return `daily.${date}.${packId}`;
}

/**
 * Bump this to void every daily result saved before it — the one-time reset
 * for when the deal itself changes (the easy-band switch shipped mid-day and
 * had already dealt people medium/hard songs). Results save the epoch; a
 * result from an older epoch reads as "not played", so the tile re-deals
 * from the current pool. There is no backend, so this is what "refresh
 * everyone" means here.
 */
const DAILY_EPOCH = 2;

/** How deep into a pack's most-streamed-first order the daily may deal. */
const DAILY_POOL = 100;

function dailyResult(packId, date = todayKey()) {
  const res = store.get(dailyKey(packId, date), null);
  return res && res.v === DAILY_EPOCH ? res : null;
}

/** Candidate order for a pack's daily: today's entry first, then walk on. */
function dailyOrder(pool, packId, date) {
  const bag = pool.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rand = mulberry32(hash32('daily|' + packId));
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  const start = dayIndex(date) % bag.length;
  return bag.slice(start).concat(bag.slice(0, start));
}

function renderHome() {
  const date = todayKey();
  state.homeDate = date;
  el.dailyDate.textContent = date;

  el.dailyList.innerHTML = '';
  const packs = playablePacks();
  let played = 0;
  packs.forEach((p, i) => {
    const res = dailyResult(p.id, date);
    if (res) played++;
    const b = document.createElement('button');
    b.className = 'daily-tile' + (res ? (res.won ? ' is-won' : ' is-lost') : '');
    b.type = 'button';
    b.style.setProperty('--c', p.color || '#888');
    b.style.setProperty('--on-c', inkOn(p.color || '#888888'));
    b.style.setProperty('--d', `${120 + i * 45}ms`);
    b.setAttribute('data-reveal', '');
    const status = res
      ? res.won
        ? `Got it at ${TIERS[res.guesses.length - 1]}s`
        : 'Missed'
      : 'Not played';
    b.setAttribute('aria-label', `${p.name} daily, ${status}`);
    b.innerHTML =
      `<span class="daily-tile-name">${escapeHtml(p.name)}</span>` +
      `<span class="daily-tile-status">${escapeHtml(status)}</span>` +
      `<span class="daily-tile-grid" aria-hidden="true">${res ? miniGrid(res.guesses) : ''}</span>`;
    b.addEventListener('click', () => {
      player.unlock();
      startDaily(p);
    });
    el.dailyList.append(b);
  });
  el.dailyBlurb.textContent = !packs.length
    ? 'No crates are built yet.'
    : played === 0
    ? 'One song per genre, the same for everyone. One go at each.'
    : played === packs.length
    ? 'All done for today. New songs at midnight.'
    : `${played} of ${packs.length} played today.`;

  const total = packs.reduce((n, p) => n + p.total, 0);
  el.endlessCount.textContent = total ? `${total.toLocaleString()} songs` : '—';
  el.pickEndless.disabled = !total;
}

/** The share-grid squares as tiny cells, for the home tiles. */
function miniGrid(guesses) {
  return TIERS.map((_, i) => {
    const g = guesses[i];
    return `<i class="cell${g ? ` ${g.kind}` : ''}"></i>`;
  }).join('');
}

/**
 * The tab may sit open across midnight. Nothing here polls: a timer set for
 * the next local midnight, plus a check whenever the tab comes back into view
 * (laptops sleep through timers), redraws the home screen for the new day.
 */
let midnightTimer = 0;

function armMidnight() {
  clearTimeout(midnightTimer);
  midnightTimer = setTimeout(rollover, msToMidnight());
}

function rollover() {
  armMidnight();
  // Other screens redraw home on the way back, so only a visible home is stale.
  if (state.screen !== 'home' || state.homeDate === todayKey()) return;
  renderHome();
  playReveal(el.home);
}

/* --------------------------------------------------------------- pack picker */

function renderCrate() {
  el.packChips.innerHTML = '';
  state.index.forEach((p, i) => {
    const on = state.packs.has(p.id);
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.disabled = p.total === 0;
    b.style.setProperty('--c', p.color || '#888');
    b.style.setProperty('--on-c', inkOn(p.color || '#888888'));
    b.style.setProperty('--i', String(i));
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', `${p.name}, ${p.total} songs`);
    b.innerHTML =
      `<span class="chip-name">${escapeHtml(p.name)}</span>` +
      `<span class="chip-count">${p.total.toLocaleString()}</span>`;
    b.addEventListener('click', () => {
      // An empty selection is allowed; Start just greys out until it isn't.
      if (state.packs.has(p.id)) state.packs.delete(p.id);
      else state.packs.add(p.id);
      store.set('packs', [...state.packs]);
      b.setAttribute('aria-pressed', String(state.packs.has(p.id)));
      renderDifficulty();
    });
    el.packChips.append(b);
  });
  renderSummary();
  renderPersonal();
}

/** Bulk select. Clear really clears; Start is disabled until something is picked. */
function setAllPacks(on) {
  state.packs.clear();
  if (on) for (const p of playablePacks()) state.packs.add(p.id);
  store.set('packs', [...state.packs]);
  renderCrate();
  renderDifficulty();
}

/**
 * "All" — no band filter. Only offered when Your Music is the *only* crate
 * selected: difficulty on your own library is a ranking of your own habits,
 * and the whole point of that crate is that you know it. As soon as another
 * crate joins, the bands are back and mean what they mean everywhere else.
 */
const ALL = { id: 0, name: 'All', key: 'total', note: 'Every song, any difficulty' };

const onlyPersonal = () => state.packs.size === 1 && state.packs.has(PERSONAL_ID);

function difficultyOptions() {
  return onlyPersonal() ? [...DIFFICULTIES, ALL] : DIFFICULTIES;
}

function difficultyMeta(id = state.difficulty) {
  return id === ALL.id ? ALL : DIFFICULTIES.find((d) => d.id === id);
}

function countFor(diff) {
  const key = difficultyMeta(diff).key;
  return [...state.packs].reduce((n, id) => n + (packMeta(id)?.[key] || 0), 0);
}

function renderDifficulty() {
  // "All" only exists while Your Music is alone; fall back if that changed.
  if (state.difficulty === ALL.id && !onlyPersonal()) {
    state.difficulty = 2;
    store.set('difficulty', 2);
  }
  el.difficulty.innerHTML = '';
  for (const d of difficultyOptions()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.difficulty === d.id));
    b.setAttribute('aria-label', `${d.name}, ${d.note}, ${countFor(d.id)} songs`);
    b.title = d.note;
    b.innerHTML = `
      <span class="seg-name">${d.name}</span>
      <span class="seg-note">${countFor(d.id).toLocaleString()} songs</span>`;
    b.addEventListener('click', () => {
      state.difficulty = d.id;
      store.set('difficulty', d.id);
      renderDifficulty();
    });
    el.difficulty.append(b);
  }
  renderSummary();
}

function renderSummary() {
  const n = countFor(state.difficulty);
  const packs = state.packs.size;
  el.packSummary.textContent = `${packs} crate${packs === 1 ? '' : 's'} · ${n.toLocaleString()} song${n === 1 ? '' : 's'} in play`;
  el.startBtn.disabled = n === 0;
}

/* ------------------------------------------------------------ your music */

/**
 * Put the personal pack into the index (or take it out) so every screen that
 * iterates packs — picker chips, daily tiles, counts — sees it with no special
 * casing. It sits last: the built crates are the game, this is yours.
 */
function mergePersonal() {
  state.index = state.index.filter((p) => !p.personal);
  const meta = personalPackMeta();
  if (meta) state.index.push(meta);
  else state.packs.delete(PERSONAL_ID);
}

function renderPersonal() {
  const meta = packMeta(PERSONAL_ID);
  const busy = state.importing;
  const configured = spotify.configured();

  el.spotifyConnect.hidden = busy || !configured || Boolean(meta);
  el.spotifyRefresh.hidden = busy || !meta || !configured;
  el.spotifyRemove.hidden = busy || !meta;
  el.spotifyCancel.hidden = !busy;
  el.personalProgress.hidden = !busy;
  el.personalPct.hidden = !busy;
  el.personal.classList.toggle('is-busy', Boolean(busy));

  if (!configured && !meta) {
    el.personalMeta.textContent = '';
    el.personalBlurb.textContent =
      'Not set up on this deployment. Add a Spotify client id in src/config.js to enable it.';
    return;
  }
  if (busy) {
    const p = busy.progress || {};
    const pct = Math.round(p.pct || 0);
    el.personalPct.textContent = `${pct}%`;
    el.personalMeta.textContent = p.matched ? `${p.matched} matched` : '';
    el.personalBlurb.textContent = p.label || 'Working';
    el.personalBar.style.width = `${pct}%`;
    return;
  }
  if (meta) {
    const when = meta.builtAt ? new Date(meta.builtAt).toLocaleDateString() : '';
    el.personalMeta.textContent = `${meta.total.toLocaleString()} songs${when ? ` · ${when}` : ''}`;
    const s = meta.source || {};
    const left = s.artistsLeft || 0;
    el.spotifyRefresh.textContent = left ? 'Continue' : 'Refresh';
    el.personalBlurb.textContent = left
      ? `Playable now. ${left} artist${left === 1 ? '' : 's'} still to search on Apple — Continue picks up where it stopped (about ${Math.ceil((left * 4) / 60)} min).`
      : `Built from your Spotify top tracks and liked songs` +
        (s.unmatched ? `; ${s.unmatched} had no Apple preview and were left out.` : '.') +
        ' Refresh picks up new likes.';
    return;
  }
  el.personalMeta.textContent = '';
  el.personalBlurb.textContent = spotify.redirectUnsupported()
    ? `Spotify only redirects back to https, or 127.0.0.1 for local work — open this page at http://127.0.0.1:${location.port || 80}/ to connect.`
    : 'Add a crate of your own music: your top tracks and up to 1,000 liked songs, matched to previews. Playable within a minute; a big library finishes over a few sittings, and you can stop any time.';
}

/**
 * The import. Reads the library from Spotify, matches it to Apple previews
 * (built packs first, then a throttled artist search), and stores the result
 * as a pack. Cancelling keeps what has been found so far.
 */
async function importSpotify() {
  if (state.importing) return;
  const controller = new AbortController();
  state.importing = { controller, progress: { pct: 0, label: 'Connecting to Spotify' } };
  renderPersonal();
  const report = (progress) => {
    if (!state.importing) return;
    state.importing.progress = { ...state.importing.progress, ...progress };
    renderPersonal();
  };
  // One number for the whole thing: reading the library is the first 15%,
  // matching is the rest. The library read is a handful of quick calls; the
  // match is the slow part, so it gets the room.
  const LIB_SHARE = 15;
  try {
    let libSteps = 0;
    const wanted = await spotify.fetchLibrary(() => {
      libSteps++;
      report({ pct: Math.min(LIB_SHARE, (libSteps / spotify.LIBRARY_STEPS) * LIB_SHARE), label: 'Reading your library' });
    });
    if (!wanted.length) throw new Error('Spotify returned no tracks for this account.');
    report({ pct: LIB_SHARE, label: `Matching ${wanted.length} songs to previews` });
    const local = await loadTracks(state.index.filter((p) => !p.personal));
    const source = (r) => ({
      wanted: wanted.length,
      unmatched: r.unmatched ?? null,
      artistsLeft: r.artistsLeft ?? 0,
      aborted: Boolean(r.aborted),
    });
    const result = await spotify.matchToApple(wanted, local, {
      prior: personalPackState(),
      onProgress: (p) => {
        const frac = p.phase === 'local' ? 0 : p.total ? p.done / p.total : 1;
        report({
          pct: LIB_SHARE + frac * (100 - LIB_SHARE),
          matched: p.matched,
          label: p.note?.startsWith('Apple is rate-limiting')
            ? p.note
            : p.phase === 'apple' && p.total
            ? `Searching Apple · ${p.done} of ${p.total} artists`
            : `Matching ${wanted.length} songs to previews`,
        });
      },
      // Persist after every artist: Stop, a closed tab or a crash all keep
      // what was found, and the next Refresh continues from here.
      onCheckpoint: (c) => {
        savePersonalPack(c.rows, source({ artistsLeft: c.artistsLeft, aborted: true }), c.searched);
        mergePersonal();
      },
      signal: controller.signal,
    });
    if (!result.rows.length) throw new Error('None of your songs could be matched to a preview.');
    savePersonalPack(result.rows, source(result), result.searched);
    mergePersonal();
    state.packs.add(PERSONAL_ID);
    store.set('packs', [...state.packs]);
  } catch (e) {
    state.importing = null;
    renderPersonal();
    el.personalBlurb.textContent = e.message || 'The import failed.';
    return;
  }
  state.importing = null;
  renderCrate();
  renderDifficulty();
  renderPersonal();
}

function bindPersonal() {
  el.spotifyConnect.addEventListener('click', () => {
    if (spotify.connected()) importSpotify();
    else spotify.connect();
  });
  el.spotifyRefresh.addEventListener('click', () => {
    if (spotify.connected()) importSpotify();
    else spotify.connect();
  });
  el.spotifyRemove.addEventListener('click', () => {
    clearPersonalPack();
    spotify.disconnect();
    mergePersonal();
    store.set('packs', [...state.packs]);
    renderCrate();
    renderDifficulty();
    renderPersonal();
  });
  el.spotifyCancel.addEventListener('click', () => state.importing?.controller.abort());
}

/** Spotify sent the browser back with a code: finish sign-in and import. */
async function resumeSpotify() {
  let handled = false;
  try {
    handled = await spotify.handleRedirect();
  } catch (e) {
    history.replaceState(null, '', location.pathname);
    renderCrate();
    renderDifficulty();
    show('crate');
    el.personalBlurb.textContent = e.message;
    return true;
  }
  if (!handled) return false;
  history.replaceState(null, '', location.pathname);
  renderCrate();
  renderDifficulty();
  show('crate');
  importSpotify();
  return true;
}

/* --------------------------------------------------------------- round setup */

/** Endless order: shuffled, avoiding the last 200 songs, so we can walk it if
 *  the first pick will not load. */
function candidateOrder(pool) {
  const recent = new Set(store.get('recent', []));
  const fresh = pool.filter((t) => !recent.has(t.id));
  const bag = (fresh.length >= 5 ? fresh : pool).slice();
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

/**
 * Self-heal a stale preview URL.
 *
 * Apple's preview URLs are unsigned and long-lived, but they do rotate. The
 * shipped game cannot mint a fresh one server-side, so instead: when a clip
 * fails to load, re-mint it from the stored trackId via /lookup. That endpoint
 * takes batched ids and is not rate-limited (unlike /search), so this costs one
 * cheap call and only ever runs on failure. It is the single tolerated
 * exception to "the play path never calls a music API".
 */
async function remintPreview(track) {
  try {
    const [fresh] = await lookupIds([Number(track.id)]);
    if (!fresh?.previewUrl) return null;
    track.previewUrl = fresh.previewUrl;
    if (fresh.artworkUrl100) track.artwork = fresh.artworkUrl100.replace('100x100bb', '400x400bb');
    return track;
  } catch {
    return null;
  }
}

async function startDaily(pack) {
  state.mode = 'daily';
  state.daily = { pack, date: todayKey() };
  show('game');
  resetGameChrome(`Loading today’s ${pack.name}`);

  try {
    setSearchPool(await loadTracks([pack]));
  } catch {
    el.status.textContent = 'Could not load the song data.';
    return;
  }
  // The daily deals only from the crate's biggest hits: the first DAILY_POOL
  // tracks of the pack, which rank-songs.mjs writes most-streamed first (the
  // personal pack is saved in popularity order too). One shot, the same for
  // everyone — it should be a song nearly everyone would know. The walk
  // repeats after DAILY_POOL days, which is the price of keeping it easy.
  state.pool = state.searchPool.slice(0, DAILY_POOL);

  const saved = dailyResult(pack.id, state.daily.date);
  if (saved) {
    const track = state.searchPool.find((t) => t.id === saved.id);
    if (track) {
      state.round = { track, tier: saved.tier, guesses: saved.guesses, done: false, won: false, cue: 0 };
      renderGuesses();
      const ok = await attachAudio(track);
      finish(saved.won, { silent: true, playable: ok });
      return;
    }
  }
  await dealFrom(dailyOrder(state.pool, pack.id, state.daily.date));
}

/** Install the autocomplete space and derive the guessable works behind it. */
function setSearchPool(tracks) {
  state.searchPool = tracks;
  const byKey = new Map();
  for (const t of tracks) {
    if (!t.nw) continue;
    const w = byKey.get(t.nw);
    if (w) w.count++;
    else byKey.set(t.nw, { kind: 'work', nw: t.nw, work: t.work, packId: t.packId, count: 1 });
  }
  state.works = [...byKey.values()];
  el.guessInput.placeholder = state.works.length
    ? 'Type a title, an artist, or what it’s from'
    : 'Type a title or an artist';
}

async function startEndless() {
  state.mode = 'endless';
  show('game');
  resetGameChrome('Loading genres');

  const packs = state.index.filter((p) => state.packs.has(p.id));
  try {
    setSearchPool(await loadTracks(packs));
  } catch {
    el.status.textContent = 'Could not load the song data. Run node tools/build-packs.mjs.';
    return;
  }
  state.pool =
    state.difficulty === ALL.id
      ? state.searchPool
      : state.searchPool.filter((t) => t.difficulty === state.difficulty);
  if (!state.pool.length) {
    el.status.textContent = 'No songs at this difficulty. Pick another genre or difficulty.';
    return;
  }
  await dealFrom(candidateOrder(state.pool));
}

function resetGameChrome(message) {
  if (el.revealDlg.open) el.revealDlg.close();
  if (el.reveal.parentElement !== el.game) el.game.append(el.reveal);
  state.pending = null;
  el.reveal.hidden = true;
  el.guessWrap.hidden = false;
  el.controls.hidden = false;
  el.guessInput.value = '';
  el.guessInput.disabled = true;
  el.status.textContent = message;
  el.status.hidden = false;
  el.playBtn.disabled = true;
  el.skipBtn.disabled = true;
  el.submitBtn.disabled = true;
}

async function dealFrom(order) {
  for (let i = 0; i < Math.min(order.length, 8); i++) {
    const track = order[i];
    state.round = { track, tier: 0, guesses: [], done: false, won: false, cue: 0 };
    let ok = true;
    try {
      await player.load(track.previewUrl);
    } catch {
      ok = false;
    }
    if (!ok) {
      const fresh = await remintPreview(track);
      if (!fresh) continue;
      try {
        await player.load(fresh.previewUrl);
      } catch {
        continue;
      }
    }
    if (state.mode === 'endless') {
      const recent = store.get('recent', []);
      recent.push(track.id);
      store.set('recent', recent.slice(-200));
    }
    el.status.hidden = true;
    el.guessInput.disabled = false;
    el.playBtn.disabled = false;
    el.skipBtn.disabled = false;
    renderGuesses();
    for (const row of el.guessList.children) row.classList.add('dealt');
    renderLadder();
    renderScope();
    el.guessInput.focus();
    return;
  }
  el.status.textContent = 'Could not load a preview. Check your connection and try again.';
}

/** Reload the audio for a restored daily round so the reveal can still play. */
async function attachAudio(track) {
  try {
    await player.load(track.previewUrl);
    return true;
  } catch {
    const fresh = await remintPreview(track);
    if (!fresh) return false;
    try {
      await player.load(fresh.previewUrl);
      return true;
    } catch {
      return false;
    }
  }
}

/* ------------------------------------------------------------------- ladder */

/** How much audio is currently unlocked, in seconds. */
function windowEnd() {
  const r = state.round;
  if (!r) return TIERS[0];
  if (r.done) return player.duration || TIERS[TIERS.length - 1];
  return TIERS[Math.min(r.tier, TIERS.length - 1)];
}

function renderLadder() {
  const r = state.round;
  if (!r) return;
  el.ladder.innerHTML = TIERS.map((t, i) => {
    const cls = r.done || i < r.tier ? 'rung lit' : i === r.tier ? 'rung now' : 'rung';
    return `<span class="${cls}">${t}s</span>`;
  }).join('');
  el.ladder.setAttribute(
    'aria-label',
    r.done ? 'Full preview unlocked' : `${windowEnd()} seconds of audio unlocked`
  );
}

/* ----------------------------------------------------------------- waveform */

function drawWave(pos) {
  const c = el.wave;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const end = windowEnd();
  const buckets = Math.max(24, Math.floor(w / 2));
  const peaks = player.peaks(0, end, buckets);
  if (!peaks) return;

  const css = getComputedStyle(document.documentElement);
  const base = css.getPropertyValue('--ink-3').trim();
  const hot = css.getPropertyValue('--go').trim();
  const cue = state.round?.cue || 0;

  const bw = w / buckets;
  const mid = h / 2;
  for (let i = 0; i < buckets; i++) {
    const t = ((i + 0.5) / buckets) * end;
    // The action colour marks only the audio that has actually sounded this
    // pass. Everything else stays neutral.
    ctx.fillStyle = pos !== null && t >= cue && t <= pos ? hot : base;
    const amp = Math.max(1, peaks[i] * h * 0.84);
    ctx.fillRect(i * bw, mid - amp / 2, Math.max(1, bw - 1), amp);
  }
}

function renderScope(pos = null) {
  const r = state.round;
  if (!r) return;
  const end = windowEnd();
  const scrubbable = end >= SCRUB_MIN;

  el.waveWrap.classList.toggle('is-locked', !scrubbable);
  el.waveWrap.setAttribute('aria-valuemin', '0');
  el.waveWrap.setAttribute('aria-valuemax', end.toFixed(2));
  el.waveWrap.setAttribute('aria-valuenow', (r.cue || 0).toFixed(2));
  el.waveWrap.setAttribute('aria-valuetext', `${(r.cue || 0).toFixed(2)} seconds`);
  el.waveWrap.tabIndex = scrubbable ? 0 : -1;

  el.cue.style.left = `${((r.cue || 0) / end) * 100}%`;
  el.cue.hidden = !scrubbable;

  if (pos === null) {
    el.playhead.classList.remove('on');
  } else {
    el.playhead.classList.add('on');
    el.playhead.style.left = `${Math.min(1, pos / end) * 100}%`;
  }

  el.clock.textContent = `${(pos ?? r.cue ?? 0).toFixed(2)} / ${end.toFixed(2)}`;
  el.scrubHint.textContent = scrubbable
    ? r.done
      ? 'Full preview'
      : 'Drag to scrub'
    : `Scrub unlocks at ${SCRUB_MIN}s`;

  drawWave(pos);
}

player.onProgress = (pos) => {
  if (pos === null) {
    el.playBtn.classList.remove('playing');
    renderScope(null);
    return;
  }
  el.playBtn.classList.add('playing');
  renderScope(pos);
};

function playCurrent() {
  const r = state.round;
  if (!r) return;
  if (player.isPlaying) {
    player.stop();
    return;
  }
  const end = windowEnd();
  const from = Math.min(r.cue || 0, Math.max(0, end - 0.05));
  player.play(from, end);
}

/* ---------------------------------------------------------------- scrubbing */

function cueFromClientX(clientX) {
  const rect = el.waveWrap.getBoundingClientRect();
  const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
  const end = windowEnd();
  // Leave a sliver at the far right so a scrub to the end still plays.
  return Math.min((x / rect.width) * end, Math.max(0, end - 0.05));
}

function setCue(seconds) {
  const r = state.round;
  if (!r) return;
  r.cue = Math.max(0, seconds);
  renderScope();
}

function bindScrub() {
  el.waveWrap.addEventListener('pointerdown', (e) => {
    if (!state.round || windowEnd() < SCRUB_MIN) return;
    e.preventDefault();
    try {
      el.waveWrap.setPointerCapture(e.pointerId);
    } catch {
      // Capture is an optimisation for drags that leave the element; scrubbing
      // still works without it, so a refusal must not abort the gesture.
    }
    state.scrubbing = true;
    player.stop();
    setCue(cueFromClientX(e.clientX));
  });

  el.waveWrap.addEventListener('pointermove', (e) => {
    if (state.scrubbing) setCue(cueFromClientX(e.clientX));
  });

  el.waveWrap.addEventListener('pointerup', (e) => {
    if (!state.scrubbing) return;
    state.scrubbing = false;
    try {
      el.waveWrap.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    // Dropping the cursor is the play gesture: scrub, let go, hear it.
    playCurrent();
  });

  el.waveWrap.addEventListener('pointercancel', () => (state.scrubbing = false));

  // Arrow steps are proportional to the window, so the control works the same
  // at 1s and at 30s.
  el.waveWrap.addEventListener('keydown', (e) => {
    const r = state.round;
    if (!r || windowEnd() < SCRUB_MIN) return;
    const end = windowEnd();
    const step = e.shiftKey ? end / 10 : end / 50;
    if (e.key === 'ArrowLeft') setCue(Math.max(0, r.cue - step));
    else if (e.key === 'ArrowRight') setCue(Math.min(end - 0.05, r.cue + step));
    else if (e.key === 'Home') setCue(0);
    else if (e.key === 'End') setCue(end - 0.05);
    else if (e.key === 'Enter') playCurrent();
    else return;
    e.preventDefault();
  });

  new ResizeObserver(() => renderScope()).observe(el.waveWrap);
}

/* ------------------------------------------------------------------ guesses */

function renderGuesses() {
  const r = state.round;
  el.guessList.innerHTML = '';
  for (let i = 0; i < TIERS.length; i++) {
    const g = r.guesses[i];
    const row = document.createElement('li');
    row.className =
      'guess-row' + (g ? ` ${g.kind}` : '') + (!g && i === r.tier && !r.done ? ' active' : '');
    const mark = g
      ? g.kind === 'correct'
        ? '+'
        : g.kind === 'skip'
        ? '>'
        : g.kind === 'close'
        ? '~'
        : '×'
      : '';
    const text = g
      ? g.kind === 'skip'
        ? 'Skipped'
        : g.label
      : i === r.tier && !r.done
      ? `Listening at ${TIERS[i]}s`
      : '';
    row.innerHTML =
      `<span class="idx">${String(i + 1).padStart(2, '0')}</span>` +
      `<span class="mark">${mark}</span>` +
      `<span class="text">${escapeHtml(text)}</span>` +
      `<span class="at">${TIERS[i]}s</span>`;
    row.style.setProperty('--i', String(i));
    el.guessList.append(row);
  }
  const left = TIERS.length - r.guesses.length;
  el.skipBtn.textContent =
    r.tier + 1 < TIERS.length ? `Skip +${TIERS[r.tier + 1] - TIERS[r.tier]}s` : 'Give up';
  el.remaining.textContent = r.done ? '' : `${left} left`;
}

function advance(entry) {
  const r = state.round;
  r.guesses.push(entry);
  r.tier = r.guesses.length;
  r.cue = 0; // a wider window is a new axis; start it from the top
  state.pending = null;
  el.guessInput.value = '';
  el.submitBtn.disabled = true;
  closeSuggestions();
  if (r.tier >= TIERS.length) {
    finish(false);
    return;
  }
  if (entry.kind === 'skip') sfx.skip();
  else if (entry.kind === 'close') sfx.close();
  else sfx.wrong();
  renderGuesses();
  renderLadder();
  el.guessList.children[r.tier - 1]?.classList.add('just');
  renderScope();
  player.play(0, TIERS[r.tier]);
}

/**
 * A guess is either a song or a work (the anime a theme opened, the game a
 * soundtrack cut is from). Naming the right work counts, and so does naming
 * another song from the same work — if you know it is Naruto, you know it is
 * Naruto.
 */
function submitGuess() {
  const r = state.round;
  if (!r || r.done) return;
  let pick = state.pending;
  if (!pick) {
    const typed = norm(el.guessInput.value);
    if (!typed) return;
    pick =
      state.searchPool.find((t) => t.nt === typed || norm(t.label) === typed) ||
      state.works.find((w) => w.nw === typed);
    if (!pick) {
      flash(el.guessInput);
      return;
    }
  }
  const isWork = pick.kind === 'work';
  const label = isWork ? pick.work : pick.label;
  const byWork = !!r.track.nw && pick.nw === r.track.nw;
  if ((!isWork && pick.id === r.track.id) || byWork) {
    r.guesses.push({
      kind: 'correct',
      label,
      // Remembered so the reveal can say how you got there.
      ...(byWork && (isWork || pick.id !== r.track.id) ? { via: r.track.work } : {}),
    });
    finish(true);
    return;
  }
  // Right artist, wrong song: still a miss, but a warm one. Works have no
  // artist, so a work pick is either right or plainly wrong.
  const close = !isWork && artistMatches(pick.artist, r.track.artist);
  advance({ kind: close ? 'close' : 'wrong', label });
}

function skip() {
  const r = state.round;
  if (!r || r.done) return;
  advance({ kind: 'skip' });
}

function flash(node) {
  node.classList.remove('shake');
  void node.offsetWidth;
  node.classList.add('shake');
}

/* ------------------------------------------------------------------- reveal */

function finish(won, { silent = false, playable = true } = {}) {
  const r = state.round;
  const t = r.track;
  const pack = packMeta(t.packId);
  r.done = true;
  r.won = won;
  r.cue = 0;

  player.stop();
  el.status.hidden = true;
  el.guessInput.disabled = true;
  el.playBtn.disabled = !playable;
  closeSuggestions();
  renderGuesses();
  renderLadder();
  renderScope();

  el.guessWrap.hidden = true;
  el.controls.hidden = true;
  el.reveal.hidden = false;

  // The result takes the stage: the reveal node itself moves into the modal,
  // and moves back to the page on close, so there is one copy of the truth.
  if (el.reveal.parentElement !== el.revealDlg) el.revealDlg.append(el.reveal);
  el.viewBoard.hidden = false;
  if (!el.revealDlg.open) el.revealDlg.showModal();
  if (!silent) (won ? sfx.win() : sfx.lose());

  // The answer arrives wearing its genre's colour.
  const c = pack?.color || '#f0c231';
  el.revealCard.style.setProperty('--c', c);
  el.revealCard.style.setProperty('--on-c', inkOn(c));

  const last = r.guesses[r.guesses.length - 1];
  el.revealVerdict.textContent = won
    ? `Got it at ${TIERS[r.guesses.length - 1]}s${last?.via ? ` · knew it was ${last.via}` : ''}`
    : 'Out of guesses';
  el.revealTitle.textContent = t.title;
  el.revealArtist.textContent = t.artistShort;
  // The media line is redundant when the album title already says it
  // ("Hades" · "Hades: Original Soundtrack").
  const media = t.media && !norm(t.album).includes(t.nm) ? t.media : '';
  el.revealAlbum.textContent = [media, t.album, t.year, pack?.name].filter(Boolean).join(' · ');
  el.revealArt.src = t.artwork || '';
  el.revealArt.hidden = !t.artwork;
  el.revealLink.href = t.storeUrl;

  if (!silent && state.mode === 'daily' && state.daily) {
    store.set(dailyKey(state.daily.pack.id, state.daily.date), {
      v: DAILY_EPOCH,
      id: t.id,
      guesses: r.guesses,
      tier: r.tier,
      won,
    });
  }

  el.nextBtn.hidden = state.mode === 'daily';
  el.dailyNote.hidden = state.mode !== 'daily';
  if (state.mode === 'daily') {
    const others = playablePacks().filter(
      (p) => p.id !== state.daily?.pack.id && !dailyResult(p.id, state.daily.date)
    ).length;
    el.dailyNote.textContent = others
      ? `That is today’s ${state.daily.pack.name}. ${others} more dail${others === 1 ? 'y' : 'ies'} left today, or head to Endless.`
      : 'That is the last daily for today. New songs at midnight, or head to Endless to keep going.';
  }
}

function shareText() {
  const r = state.round;
  // Green got it, yellow right artist, red wrong, black skipped, white unused.
  const SQUARE = { correct: '\u{1f7e9}', close: '\u{1f7e8}', wrong: '\u{1f7e5}', skip: '⬛' };
  const squares = TIERS.map((_, i) => SQUARE[r.guesses[i]?.kind] || '⬜').join('');
  const pack = packMeta(r.track.packId);
  const head =
    state.mode === 'daily'
      ? `Earworm ${state.daily?.date || todayKey()} · ${pack?.name || ''}`
      : `Earworm · ${pack?.name || ''} · ${difficultyMeta().name}`;
  return `${head}\n${squares}\n${r.won ? `${TIERS[r.guesses.length - 1]}s` : 'X'}`;
}

/* ------------------------------------------------------------- autocomplete */

const MAX_SUGGEST = 8;
const MAX_WORKS = 3;

function updateSuggestions() {
  const q = norm(el.guessInput.value);
  if (!q) return closeSuggestions();
  // Works first: "naruto" should offer Naruto itself before its dozen themes.
  // Prefix hits beat substring hits; within each, the work with more songs is
  // the one more people mean.
  const works = state.works
    .filter((w) => w.nw.includes(q))
    .sort((a, b) => b.nw.startsWith(q) - a.nw.startsWith(q) || b.count - a.count);
  const starts = [];
  const contains = [];
  for (const t of state.searchPool) {
    if (t.nt.startsWith(q) || t.na.startsWith(q) || t.nm.startsWith(q)) starts.push(t);
    else if (t.nt.includes(q) || t.na.includes(q) || t.nm.includes(q)) contains.push(t);
    if (starts.length >= MAX_SUGGEST) break;
  }
  state.matches = [...works.slice(0, MAX_WORKS), ...starts, ...contains].slice(0, MAX_SUGGEST);
  state.hi = state.matches.length ? 0 : -1;
  renderSuggestions();
}

function renderSuggestions() {
  if (!state.matches.length) return closeSuggestions();
  el.suggest.innerHTML = state.matches
    .map((t, i) => {
      const cls = (i === state.hi ? 'hi' : '') + (t.kind === 'work' ? ' work' : '');
      const main = t.kind === 'work' ? t.work : t.title;
      const side =
        t.kind === 'work'
          ? `${packMeta(t.packId)?.name || ''} · ${t.count} song${t.count === 1 ? '' : 's'}`
          : t.media || t.artistShort;
      return (
        `<li role="option" id="sug-${i}" aria-selected="${i === state.hi}" class="${cls.trim()}"` +
        ` data-i="${i}"><strong>${escapeHtml(main)}</strong><span>${escapeHtml(side)}</span></li>`
      );
    })
    .join('');
  el.suggest.hidden = false;
  el.guessInput.setAttribute('aria-expanded', 'true');
  el.guessInput.setAttribute('aria-activedescendant', state.hi >= 0 ? `sug-${state.hi}` : '');
}

function closeSuggestions() {
  el.suggest.hidden = true;
  el.suggest.innerHTML = '';
  el.guessInput.setAttribute('aria-expanded', 'false');
  el.guessInput.removeAttribute('aria-activedescendant');
  state.matches = [];
  state.hi = -1;
}

function choose(i) {
  const t = state.matches[i];
  if (!t) return;
  state.pending = t;
  el.guessInput.value = t.kind === 'work' ? t.work : t.label;
  closeSuggestions();
  el.submitBtn.disabled = false;
  el.guessInput.focus();
}

/* -------------------------------------------------------------------- theme */

function applyTheme(theme) {
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
  const dark =
    theme === 'dark' || (!theme && !window.matchMedia('(prefers-color-scheme: light)').matches);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0e0e10' : '#e8e8e8');
  // Canvas colours come from CSS custom properties, so it must be redrawn.
  if (state.round) renderScope();
}

let themingTimer = 0;

function toggleTheme() {
  // Paint the swap over 350ms instead of snapping. The class is removed again so
  // it never sits on top of ordinary interaction.
  if (!reduced()) {
    document.documentElement.classList.add('theming');
    clearTimeout(themingTimer);
    themingTimer = setTimeout(() => document.documentElement.classList.remove('theming'), 400);
  }
  const current =
    document.documentElement.getAttribute('data-theme') ||
    (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = current === 'dark' ? 'light' : 'dark';
  store.set('theme', next);
  applyTheme(next);
}

/* --------------------------------------------------------------------- init */

function bind() {
  Object.assign(el, {
    home: $('#home'),
    crate: $('#crate'),
    game: $('#game'),
    breadcrumb: $('#breadcrumb'),
    goHome: $('#go-home'),
    dailyList: $('#daily-list'),
    dailyDate: $('#daily-date'),
    dailyBlurb: $('#daily-blurb'),
    pickEndless: $('#pick-endless'),
    endlessCount: $('#endless-count'),
    packChips: $('#pack-chips'),
    personal: $('#personal'),
    personalPct: $('#personal-pct'),
    personalMeta: $('#personal-meta'),
    personalBlurb: $('#personal-blurb'),
    personalProgress: $('#personal-progress'),
    personalBar: $('#personal-bar'),
    spotifyConnect: $('#spotify-connect'),
    spotifyRefresh: $('#spotify-refresh'),
    spotifyRemove: $('#spotify-remove'),
    spotifyCancel: $('#spotify-cancel'),
    difficulty: $('#difficulty'),
    packSummary: $('#pack-summary'),
    startBtn: $('#start'),
    playBtn: $('#play'),
    skipBtn: $('#skip'),
    submitBtn: $('#submit'),
    nextBtn: $('#next'),
    shareBtn: $('#share'),
    guessInput: $('#guess'),
    guessWrap: $('.guess-wrap'),
    controls: $('.controls'),
    suggest: $('#suggest'),
    guessList: $('#guesses'),
    remaining: $('#remaining'),
    status: $('#status'),
    ladder: $('#ladder'),
    wave: $('#wave'),
    waveWrap: $('#wave-wrap'),
    cue: $('#cue'),
    playhead: $('#playhead'),
    clock: $('#clock'),
    scrubHint: $('#scrub-hint'),
    volume: $('#volume'),
    volumeOut: $('#volume-out'),
    reveal: $('#reveal'),
    revealDlg: $('#reveal-dialog'),
    viewBoard: $('#view-board'),
    revealCard: $('#reveal-card'),
    revealArt: $('#reveal-art'),
    revealTitle: $('#reveal-title'),
    revealArtist: $('#reveal-artist'),
    revealAlbum: $('#reveal-album'),
    revealVerdict: $('#reveal-verdict'),
    revealLink: $('#reveal-link'),
    dailyNote: $('#daily-note'),
    helpDlg: $('#help-dialog'),
  });

  el.waveWrap.setAttribute('role', 'slider');
  el.waveWrap.setAttribute('aria-label', 'Scrub position');

  el.goHome.addEventListener('click', () => {
    renderHome();
    show('home');
  });

  el.pickEndless.addEventListener('click', () => {
    renderCrate();
    renderDifficulty();
    show('crate');
  });
  el.startBtn.addEventListener('click', () => {
    player.unlock();
    startEndless();
  });
  $('#select-all').addEventListener('click', () => setAllPacks(true));
  $('#select-none').addEventListener('click', () => setAllPacks(false));

  el.playBtn.addEventListener('click', playCurrent);
  el.skipBtn.addEventListener('click', skip);
  el.submitBtn.addEventListener('click', submitGuess);
  el.nextBtn.addEventListener('click', () => startEndless());

  const setVol = (pct, persist) => {
    const v = Math.min(100, Math.max(0, pct));
    el.volume.value = String(v);
    el.volume.style.setProperty('--pct', v + '%');
    el.volumeOut.textContent = v + '%';
    player.setVolume(v / 100);
    if (persist) store.set('volume', v);
  };
  el.volume.addEventListener('input', () => setVol(Number(el.volume.value), true));
  setVol(store.get('volume', 80), false);

  el.shareBtn.addEventListener('click', async () => {
    const text = shareText();
    try {
      if (navigator.share) await navigator.share({ text });
      else await navigator.clipboard.writeText(text);
      el.shareBtn.textContent = 'Copied';
    } catch {
      el.shareBtn.textContent = 'Copy failed';
    }
    setTimeout(() => (el.shareBtn.textContent = 'Share'), 1600);
  });

  el.guessInput.addEventListener('input', () => {
    state.pending = null;
    el.submitBtn.disabled = !el.guessInput.value.trim();
    updateSuggestions();
  });

  el.guessInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!state.matches.length) return;
      e.preventDefault();
      state.hi =
        (state.hi + (e.key === 'ArrowDown' ? 1 : -1) + state.matches.length) % state.matches.length;
      renderSuggestions();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (state.matches.length && state.hi >= 0 && !state.pending) choose(state.hi);
      else submitGuess();
    } else if (e.key === 'Escape') {
      closeSuggestions();
    }
  });

  // mousedown, not click: it has to fire before the input blurs.
  el.suggest.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) {
      e.preventDefault();
      choose(Number(li.dataset.i));
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.guess-wrap')) closeSuggestions();
  });

  const openHelp = () => {
    if (!el.helpDlg.open) el.helpDlg.showModal();
  };

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // A modal owns the keyboard while it is open. Without this, Space hijacks
    // the close button and a second `?` calls showModal() on an already-open
    // dialog, which throws InvalidStateError.
    if (document.querySelector('dialog[open]')) return;
    if (e.code === 'Space' && state.screen === 'game') {
      e.preventDefault();
      playCurrent();
    } else if (e.key.toLowerCase() === 't') {
      toggleTheme();
    } else if (e.key === '?') {
      openHelp();
    }
  });

  $('#open-help').addEventListener('click', openHelp);
  $('#toggle-theme').addEventListener('click', toggleTheme);
  for (const b of document.querySelectorAll('[data-close]')) {
    b.addEventListener('click', () => b.closest('dialog')?.close());
  }

  // Clicking the scrim closes a modal. A click on the backdrop is delivered
  // to the <dialog> itself, but so is a click on its own padding, so the test
  // is geometric: outside the box, not merely "target is the dialog".
  for (const dlg of document.querySelectorAll('dialog')) {
    dlg.addEventListener('click', (e) => {
      if (!dlg.open || e.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      const inside =
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) dlg.close();
    });
  }

  el.revealDlg.addEventListener('close', () => {
    if (el.reveal.parentElement === el.revealDlg) el.game.append(el.reveal);
    el.viewBoard.hidden = true; // pointless once the board is already visible
  });

  bindPersonal();

  // Day rollover while the tab is open. See rollover().
  armMidnight();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') rollover();
  });

  bindScrub();
}

async function boot() {
  // Scripting is on, so [data-reveal] may hide its content. Without this class
  // nothing is ever hidden in the first place.
  document.documentElement.classList.add('js');
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const syncMotion = () => document.documentElement.classList.toggle('motion-reduced', mq.matches);
  syncMotion();
  mq.addEventListener('change', syncMotion);

  bind();
  applyTheme(store.get('theme', null));
  try {
    state.index = await loadIndex();
  } catch {
    el.packChips.innerHTML =
      '<p class="status">Song data missing. Run <code>node tools/build-packs.mjs</code>.</p>';
    return;
  }
  mergePersonal();
  // Drop any remembered genre the current build no longer ships. An empty
  // selection is fine: the picker just keeps Start disabled until it isn't.
  for (const id of [...state.packs]) if (!packMeta(id)) state.packs.delete(id);
  // Back from Spotify's consent screen? Finish that instead of landing home.
  if (await resumeSpotify()) return;
  renderHome();
  show('home');
}

boot();
