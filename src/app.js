import { PACKS, PACK_BY_ID, ALL_TRACKS } from './catalog.js';
import { norm, trackKey, lookupIds, toRecord } from './itunes.js';
import { SnippetPlayer } from './audio.js';

/** How much of the intro you get to hear at each stage. */
const TIERS = [0.1, 0.5, 1, 2, 4, 8, 16];
const MAX_T = TIERS[TIERS.length - 1];
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

/**
 * The song manifest: src/resolved.json, built once by tools/build-index.mjs and
 * committed. This is the only source of song metadata at runtime — the game
 * never calls a music API, so it can't be rate-limited and works on any static
 * host. Songless does the same thing with a server minting Deezer URLs per
 * request; Apple's preview URLs are unsigned and stable, so a plain static file
 * is enough here.
 */
const manifest = new Map();

async function loadManifest() {
  const res = await fetch('./src/resolved.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  for (const [k, v] of Object.entries(await res.json())) {
    if (v?.previewUrl) manifest.set(k, v);
  }
}

/** Catalog entries that actually have a playable preview in the manifest. */
function playable(tracks) {
  return tracks.filter((t) => manifest.has(trackKey(t)));
}

/**
 * Self-heal a stale preview URL.
 *
 * Apple's preview URLs are unsigned and long-lived, but they do rotate
 * eventually — the failure mode Songless dodges by minting a fresh Deezer URL
 * server-side on every request. We can't do that from a static host, so
 * instead: when a clip fails to load, re-mint it from the stored trackId via
 * /lookup. That endpoint takes batched ids and is not rate-limited (unlike
 * /search), so this costs one cheap call and only ever runs on failure.
 */
async function remintPreview(track) {
  const key = trackKey(track);
  const known = manifest.get(key);
  if (!known?.trackId) return null;
  try {
    const [fresh] = await lookupIds([known.trackId]);
    if (!fresh?.previewUrl) return null;
    const rec = toRecord(fresh);
    manifest.set(key, rec);
    return rec;
  } catch {
    return null;
  }
}

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

/* -------------------------------------------------------------------- state */

const player = new SnippetPlayer();

const state = {
  mode: store.get('mode', 'daily'),
  // Deliberately not the pop/rock/hip-hop trio — breadth is the whole point.
  packs: new Set(store.get('packs', ['pop', 'rock', 'hiphop', 'kpop', 'edm', 'vgm', 'latin'])),
  pool: [],
  round: null,
  pending: null, // the autocomplete row the player has selected
  hi: -1, // highlighted autocomplete index
  matches: [],
};

const $ = (sel) => document.querySelector(sel);
const el = {};

/* --------------------------------------------------------------- pack picker */

function renderPacks() {
  el.packGrid.innerHTML = '';
  for (const p of PACKS) {
    // Count what's actually in the manifest, so a partly-built index never
    // offers a pack that can't produce a song.
    const n = playable(ALL_TRACKS.filter((t) => t.packId === p.id)).length;
    if (!n) state.packs.delete(p.id);
    const on = state.packs.has(p.id);
    const b = document.createElement('button');
    b.className = 'pack' + (on ? ' on' : '');
    b.type = 'button';
    b.disabled = n === 0;
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = `
      <span class="pack-emoji">${p.emoji}</span>
      <span class="pack-body">
        <span class="pack-name">${p.name}</span>
        <span class="pack-blurb">${p.blurb}</span>
      </span>
      <span class="pack-count">${n || '—'}</span>`;
    b.addEventListener('click', () => {
      if (state.packs.has(p.id)) state.packs.delete(p.id);
      else state.packs.add(p.id);
      if (state.packs.size === 0) state.packs.add(p.id); // never empty
      store.set('packs', [...state.packs]);
      renderPacks();
    });
    el.packGrid.append(b);
  }
  const n = poolForPacks().length;
  el.packSummary.textContent = `${state.packs.size} pack${
    state.packs.size === 1 ? '' : 's'
  } · ${n} songs`;
  el.startBtn.disabled = n === 0;
}

/* --------------------------------------------------------------- round setup */

function poolForPacks() {
  return playable(ALL_TRACKS.filter((t) => state.packs.has(t.packId)));
}

function packSignature() {
  return [...state.packs].sort().join(',');
}

/** Order the pool so we can walk it if the first pick has no preview. */
function candidateOrder(pool) {
  if (state.mode === 'daily') {
    const rand = mulberry32(hash32(todayKey() + '|' + packSignature()));
    const start = Math.floor(rand() * pool.length);
    // Deterministic: today's song first, then a fixed fallback walk.
    return Array.from({ length: pool.length }, (_, i) => pool[(start + i * 7 + i) % pool.length]);
  }
  const recent = new Set(store.get('recent', []));
  const fresh = pool.filter((t) => !recent.has(t.id));
  const bag = (fresh.length >= 5 ? fresh : pool).slice();
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

async function newRound() {
  player.stop();
  state.pool = poolForPacks();
  state.pending = null;
  el.game.hidden = false;
  el.setup.hidden = true;
  el.reveal.hidden = true;
  el.guessInput.value = '';
  el.guessInput.disabled = true;
  el.status.textContent = 'Finding a song…';
  el.status.hidden = false;
  el.playBtn.disabled = true;
  el.skipBtn.disabled = true;
  el.submitBtn.disabled = true;

  // Daily: if today's puzzle is already finished, jump straight to the result.
  if (state.mode === 'daily') {
    const saved = store.get('daily.' + todayKey() + '.' + packSignature(), null);
    if (saved) {
      state.round = { ...saved, restored: true };
      renderGuesses();
      const ok = await attachAudio(saved.track);
      finish(saved.won, { silent: true, resolvedOverride: ok });
      return;
    }
  }

  const order = candidateOrder(state.pool);
  for (let i = 0; i < Math.min(order.length, 8); i++) {
    const track = order[i];
    // Straight out of the manifest — no network call, so nothing to throttle.
    const resolved = manifest.get(trackKey(track));
    if (!resolved) continue;

    state.round = {
      track,
      resolved,
      tier: 0,
      guesses: [],
      done: false,
      won: false,
      packSig: packSignature(),
    };
    try {
      await player.load(resolved.previewUrl);
    } catch {
      // Stale URL? Re-mint once from the trackId before giving up on this song.
      const fresh = await remintPreview(track);
      if (!fresh) continue;
      state.round.resolved = fresh;
      try {
        await player.load(fresh.previewUrl);
      } catch {
        continue;
      }
    }
    if (state.mode === 'endless') {
      const recent = store.get('recent', []);
      recent.push(track.id);
      store.set('recent', recent.slice(-60));
    }
    el.status.hidden = true;
    el.guessInput.disabled = false;
    el.playBtn.disabled = false;
    el.skipBtn.disabled = false;
    renderGuesses();
    renderTimeline();
    el.guessInput.focus();
    return;
  }

  el.status.textContent =
    'Could not load a preview — check your connection, or pick different packs.';
}

/** Reload the audio for a restored daily round so the reveal can play it. */
async function attachAudio(track) {
  try {
    const resolved = manifest.get(trackKey(track));
    if (!resolved) return null;
    state.round.resolved = resolved;
    await player.load(resolved.previewUrl);
    return resolved;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- timeline */

function renderTimeline() {
  const r = state.round;
  if (!r) return;
  const unlocked = TIERS[Math.min(r.tier, TIERS.length - 1)];
  el.unlocked.style.width = `${(unlocked / MAX_T) * 100}%`;
  el.ticks.innerHTML = TIERS.map(
    (t) =>
      `<span class="tick${t <= unlocked ? ' lit' : ''}" style="left:${(t / MAX_T) * 100}%"></span>`
  ).join('');
  el.snippetLabel.textContent = r.done ? 'Full preview' : `${unlocked}s`;
}

player.onProgress = (elapsed) => {
  if (elapsed === null) {
    el.playhead.style.opacity = '0';
    el.playBtn.classList.remove('playing');
    return;
  }
  el.playhead.style.opacity = '1';
  el.playhead.style.left = `${Math.min(1, elapsed / MAX_T) * 100}%`;
  el.playBtn.classList.add('playing');
};

function playCurrent() {
  const r = state.round;
  if (!r) return;
  if (player.isPlaying) {
    player.stop();
    return;
  }
  player.play(r.done ? player.duration : TIERS[Math.min(r.tier, TIERS.length - 1)]);
}

/* ------------------------------------------------------------------- guesses */

function renderGuesses() {
  const r = state.round;
  el.guessList.innerHTML = '';
  for (let i = 0; i < TIERS.length; i++) {
    const g = r.guesses[i];
    const row = document.createElement('li');
    row.className = 'guess-row' + (g ? ` ${g.kind}` : '') + (!g && i === r.tier && !r.done ? ' active' : '');
    const mark = g ? (g.kind === 'correct' ? '✓' : g.kind === 'skip' ? '›' : '✕') : '';
    const text = g
      ? g.kind === 'skip'
        ? 'Skipped'
        : g.label
      : i === r.tier && !r.done
      ? `Listening to ${TIERS[i]}s`
      : '';
    row.innerHTML = `<span class="mark">${mark}</span><span class="text">${escapeHtml(
      text
    )}</span><span class="at">${TIERS[i]}s</span>`;
    el.guessList.append(row);
  }
  const left = TIERS.length - r.guesses.length;
  el.skipBtn.textContent = r.tier + 1 < TIERS.length ? `Skip (+${TIERS[r.tier + 1] - TIERS[r.tier]}s)` : 'Give up';
  el.remaining.textContent = r.done ? '' : `${left} guess${left === 1 ? '' : 'es'} left`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function advance(entry) {
  const r = state.round;
  r.guesses.push(entry);
  r.tier = r.guesses.length;
  state.pending = null;
  el.guessInput.value = '';
  el.submitBtn.disabled = true;
  closeSuggestions();
  if (r.tier >= TIERS.length) {
    finish(false);
    return;
  }
  renderGuesses();
  renderTimeline();
  player.play(TIERS[r.tier]);
}

function submitGuess() {
  const r = state.round;
  if (!r || r.done) return;
  let pick = state.pending;
  if (!pick) {
    // Allow a typed exact title match without touching the dropdown.
    const typed = norm(el.guessInput.value);
    if (!typed) return;
    pick = state.pool.find((t) => norm(t.title) === typed || norm(t.label) === typed);
    if (!pick) {
      flash(el.guessInput);
      return;
    }
  }
  if (pick.id === r.track.id) {
    r.guesses.push({ kind: 'correct', label: pick.label });
    finish(true);
    return;
  }
  advance({ kind: 'wrong', label: pick.label });
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

function finish(won, { silent = false, resolvedOverride } = {}) {
  const r = state.round;
  r.done = true;
  r.won = won;
  const meta = resolvedOverride || r.resolved;

  player.stop();
  el.status.hidden = true;
  el.guessInput.disabled = true;
  el.submitBtn.disabled = true;
  el.skipBtn.disabled = true;
  el.playBtn.disabled = !meta;
  closeSuggestions();
  renderGuesses();
  renderTimeline();

  el.reveal.hidden = false;
  el.revealTitle.textContent = r.track.title;
  el.revealArtist.textContent = r.track.artist;
  el.revealPack.textContent = PACK_BY_ID[r.track.packId].name;
  el.revealVerdict.textContent = won
    ? `Got it in ${r.guesses.length} — ${TIERS[r.guesses.length - 1]}s`
    : 'Out of guesses';
  el.revealVerdict.className = 'verdict ' + (won ? 'win' : 'loss');
  if (meta) {
    el.revealArt.src = meta.artwork || '';
    el.revealArt.hidden = !meta.artwork;
    el.revealAlbum.textContent = [meta.album, meta.year].filter(Boolean).join(' · ');
    el.revealLink.href = meta.storeUrl || '#';
    el.revealLink.hidden = !meta.storeUrl;
  }

  if (!silent) {
    recordStats(won, r.guesses.length);
    if (state.mode === 'daily') {
      store.set('daily.' + todayKey() + '.' + packSignature(), {
        track: r.track,
        guesses: r.guesses,
        tier: r.tier,
        won,
      });
    }
  }
  el.nextBtn.hidden = state.mode === 'daily';
  el.dailyNote.hidden = state.mode !== 'daily';
}

function shareText() {
  const r = state.round;
  const squares = TIERS.map((_, i) => {
    const g = r.guesses[i];
    if (!g) return '⬜';
    return g.kind === 'correct' ? '🟩' : g.kind === 'skip' ? '🟨' : '🟥';
  }).join('');
  const packNames = [...state.packs].map((id) => PACK_BY_ID[id].emoji).join('');
  const head =
    state.mode === 'daily' ? `Earworm ${todayKey()}` : 'Earworm (endless)';
  return `${head} ${packNames}\n${squares}\n${
    r.won ? `${TIERS[r.guesses.length - 1]}s` : 'X'
  }/${MAX_T}s`;
}

/* -------------------------------------------------------------------- stats */

function recordStats(won, guessCount) {
  const s = store.get('stats', { played: 0, wins: 0, streak: 0, best: 0, dist: [0, 0, 0, 0, 0, 0, 0] });
  s.played++;
  if (won) {
    s.wins++;
    s.streak++;
    s.best = Math.max(s.best, s.streak);
    s.dist[guessCount - 1]++;
  } else {
    s.streak = 0;
  }
  store.set('stats', s);
}

function renderStats() {
  const s = store.get('stats', { played: 0, wins: 0, streak: 0, best: 0, dist: [0, 0, 0, 0, 0, 0, 0] });
  el.statPlayed.textContent = s.played;
  el.statWin.textContent = s.played ? Math.round((s.wins / s.played) * 100) + '%' : '—';
  el.statStreak.textContent = s.streak;
  el.statBest.textContent = s.best;
  const max = Math.max(1, ...s.dist);
  el.statDist.innerHTML = s.dist
    .map(
      (n, i) =>
        `<div class="bar-row"><span>${TIERS[i]}s</span><div class="bar" style="width:${
          (n / max) * 100
        }%">${n || ''}</div></div>`
    )
    .join('');
}

/* ------------------------------------------------------------ autocomplete */

function updateSuggestions() {
  const q = norm(el.guessInput.value);
  if (!q) return closeSuggestions();
  const starts = [];
  const contains = [];
  for (const t of state.pool) {
    const nt = norm(t.title);
    const na = norm(t.artist);
    if (nt.startsWith(q) || na.startsWith(q)) starts.push(t);
    else if (nt.includes(q) || na.includes(q)) contains.push(t);
    if (starts.length >= 8) break;
  }
  state.matches = [...starts, ...contains].slice(0, 8);
  state.hi = state.matches.length ? 0 : -1;
  renderSuggestions();
}

function renderSuggestions() {
  if (!state.matches.length) return closeSuggestions();
  el.suggest.innerHTML = state.matches
    .map(
      (t, i) =>
        `<li role="option" aria-selected="${i === state.hi}" class="${
          i === state.hi ? 'hi' : ''
        }" data-i="${i}"><strong>${escapeHtml(t.title)}</strong><span>${escapeHtml(
          t.artist
        )}</span></li>`
    )
    .join('');
  el.suggest.hidden = false;
  el.guessInput.setAttribute('aria-expanded', 'true');
}

function closeSuggestions() {
  el.suggest.hidden = true;
  el.suggest.innerHTML = '';
  el.guessInput.setAttribute('aria-expanded', 'false');
  state.matches = [];
  state.hi = -1;
}

function choose(i) {
  const t = state.matches[i];
  if (!t) return;
  state.pending = t;
  el.guessInput.value = t.label;
  closeSuggestions();
  el.submitBtn.disabled = false;
  el.guessInput.focus();
}

/* --------------------------------------------------------------------- init */

function bind() {
  Object.assign(el, {
    setup: $('#setup'),
    game: $('#game'),
    packGrid: $('#pack-grid'),
    packSummary: $('#pack-summary'),
    startBtn: $('#start'),
    changeBtn: $('#change-packs'),
    modeDaily: $('#mode-daily'),
    modeEndless: $('#mode-endless'),
    playBtn: $('#play'),
    skipBtn: $('#skip'),
    submitBtn: $('#submit'),
    nextBtn: $('#next'),
    shareBtn: $('#share'),
    guessInput: $('#guess'),
    suggest: $('#suggest'),
    guessList: $('#guesses'),
    remaining: $('#remaining'),
    status: $('#status'),
    unlocked: $('#unlocked'),
    playhead: $('#playhead'),
    ticks: $('#ticks'),
    snippetLabel: $('#snippet-label'),
    reveal: $('#reveal'),
    revealArt: $('#reveal-art'),
    revealTitle: $('#reveal-title'),
    revealArtist: $('#reveal-artist'),
    revealAlbum: $('#reveal-album'),
    revealPack: $('#reveal-pack'),
    revealVerdict: $('#reveal-verdict'),
    revealLink: $('#reveal-link'),
    dailyNote: $('#daily-note'),
    statsDlg: $('#stats-dialog'),
    helpDlg: $('#help-dialog'),
    statPlayed: $('#stat-played'),
    statWin: $('#stat-win'),
    statStreak: $('#stat-streak'),
    statBest: $('#stat-best'),
    statDist: $('#stat-dist'),
  });

  el.startBtn.addEventListener('click', () => {
    player.unlock();
    newRound();
  });
  el.changeBtn.addEventListener('click', () => {
    player.stop();
    el.game.hidden = true;
    el.setup.hidden = false;
  });

  const setMode = (m) => {
    state.mode = m;
    store.set('mode', m);
    el.modeDaily.classList.toggle('on', m === 'daily');
    el.modeEndless.classList.toggle('on', m === 'endless');
    el.modeDaily.setAttribute('aria-pressed', String(m === 'daily'));
    el.modeEndless.setAttribute('aria-pressed', String(m === 'endless'));
  };
  el.modeDaily.addEventListener('click', () => setMode('daily'));
  el.modeEndless.addEventListener('click', () => setMode('endless'));
  setMode(state.mode);

  el.playBtn.addEventListener('click', playCurrent);
  el.skipBtn.addEventListener('click', skip);
  el.submitBtn.addEventListener('click', submitGuess);
  el.nextBtn.addEventListener('click', newRound);

  el.shareBtn.addEventListener('click', async () => {
    const text = shareText();
    try {
      if (navigator.share) await navigator.share({ text });
      else await navigator.clipboard.writeText(text);
      el.shareBtn.textContent = 'Copied!';
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

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      playCurrent();
    }
  });

  $('#open-stats').addEventListener('click', () => {
    renderStats();
    el.statsDlg.showModal();
  });
  $('#open-help').addEventListener('click', () => el.helpDlg.showModal());
  for (const b of document.querySelectorAll('[data-close]')) {
    b.addEventListener('click', () => b.closest('dialog').close());
  }

  $('#tier-legend').textContent = TIERS.map((t) => `${t}s`).join(' → ');
}

const packPlayable = (id) => playable(ALL_TRACKS.filter((t) => t.packId === id)).length;

async function boot() {
  bind();
  try {
    await loadManifest();
  } catch {
    el.packGrid.innerHTML =
      '<p class="status">Song manifest missing. Run <code>node tools/build-index.mjs</code>.</p>';
    el.startBtn.disabled = true;
    return;
  }
  // If none of the remembered packs can be served yet (partial index), fall
  // back to whatever the manifest does cover.
  if (![...state.packs].some(packPlayable)) {
    state.packs = new Set(PACKS.map((p) => p.id).filter(packPlayable).slice(0, 7));
  }
  renderPacks();
}

boot();
