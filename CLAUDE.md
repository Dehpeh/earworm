# Earworm — working context

Guess a song from 0.1 seconds. Static HTML/CSS/JS, no framework, no build step,
no backend, no API keys. `README.md` covers how it works; this file covers the
things that will bite you.

**Next up: UI work.** See [UI notes](#ui-notes) at the bottom.

## Run it

```bash
node server.mjs          # http://localhost:5173
```

A server is required — ES modules don't load over `file://`. `server.mjs` is dev
only and is not part of the deploy.

## The one invariant

**The game never calls a music API at runtime.** It reads `src/resolved.json`
and nothing else. The only network request during a round is the audio file
itself, from `audio-ssl.itunes.apple.com`.

Do not reintroduce a live search call in the play path. That's what the first
version did and it broke with `403 Apple is rate-limiting song lookups`. If
you're tempted, re-read the rate-limit section below.

The single tolerated exception is `remintPreview()` in `src/app.js`: if a clip
fails to load, it re-mints that one song from its stored `trackId` via
`/lookup`, which is *not* rate-limited. Failure path only.

## Files

| File | Role |
| --- | --- |
| `index.html` | Markup + dialogs |
| `styles.css` | All styling. Dark by default, light via `prefers-color-scheme` |
| `src/catalog.js` | 24 packs of `[title, artist]` — the human-edited source |
| `src/resolved.json` | **Generated manifest. The only data the game reads.** Commit it |
| `src/itunes.js` | Search/lookup/matching. Build-time, plus the re-mint fallback |
| `src/audio.js` | Web Audio snippet player |
| `src/app.js` | Game state, UI wiring, stats, sharing |
| `tools/build-index.mjs` | Generates the manifest |

## Where the audio comes from

I checked what Songless actually serves: **Deezer**
(`cdnt-preview.dzcdn.net`), with the URL embedded in server-rendered HTML.
Clicking play fires no request. That's because Deezer preview URLs are signed
and expire — measured at **~14 minutes**. Their pattern is *static song list +
fresh URL minted server-side per request*, which needs a backend.

We use **Apple/iTunes previews** instead, because those URLs are unsigned and
long-lived, so they can be resolved once and committed. Same result, no backend.

Don't switch to Deezer without adding a server — the URLs will be dead within
the hour.

- **Spotify is not an option.** `preview_url` was removed for apps registered
  after Nov 2024; it returns `null`.
- **SoundCloud is not an option.** Public API registration has been closed for
  years.

## Rate limits — the important part

Apple's two endpoints behave completely differently. This asymmetry is the whole
architecture:

| | `/search` | `/lookup` |
| --- | --- | --- |
| Limit | ~20 calls/min per IP | none observed (25 rapid calls, all 200) |
| Over the limit | `403` for **minutes** | — |
| Batching | one query | ~200 ids per call |

So discovery spends one `/search` **per artist** (`limit=200`, matching every
catalog track by that artist from one response — 502 calls instead of 690) and
records each song's `trackId`. From then on, `--refresh` re-mints the whole
catalog via `/lookup`: **4 requests, 6 seconds, measured on all 666 songs.**

If you hammer `/search`, the IP goes into a penalty box that outlasts the
documented limit by a lot — I burned it with a 690-request burst and throughput
collapsed to ~1/min for hours. The builder handles this with escalating backoff
(60s → 15min) and saves after every hit, so `^C` costs nothing. Just be patient
and don't run other Apple requests alongside it.

## Manifest workflow

```bash
node tools/build-index.mjs             # discover whatever is missing
node tools/build-index.mjs --refresh   # re-mint preview URLs (fast, free)
node tools/build-index.mjs --targeted  # repair run: skip the artist sweep
node tools/build-index.mjs --force     # rediscover everything
node tools/build-index.mjs kpop jazz   # limit to packs
```

Re-running discovery **prunes any stored entry that no longer passes the current
matcher**, so tightening matching rules automatically re-resolves what they now
reject. Use `--targeted` for repair runs — the artist sweep has already failed
for anything still missing, so re-running it just burns throttled calls.

Current state: **666 of 690 resolve, 0 invalid.** The 24 gaps aren't on the US
store (Tatsuro Yamashita kept his catalog off streaming). Unresolved songs are
excluded automatically; packs grey out if they can't field a round.

## Matcher traps (all of these actually happened)

The store will genuinely sell you *Holocene* by the Vitamin String Quartet and
*She* by Twinkle Twinkle Little Rock Star. Every rule here exists because
something resolved wrong:

1. **Title match is a hard gate, never a score.** The artist sweep asks "every
   song by X", so without the gate a missing track silently resolves to a
   *different song by that artist*. Three Bad Bunny entries all collapsed onto
   `NUEVAYoL`.
2. **Try the credited artist first.** Loose-artist fallback only runs for packs
   marked `looseArtist: true` (`classical`, `vgm`, `screen`), where the catalog
   credits a composer and the store credits an orchestra. Without this,
   `Holocene` → Vitamin String Quartet.
3. **Every word of the shorter artist name must appear in the longer one.** A
   single shared token is not enough — Frank Ocean vs Billy Ocean sent `Nights`
   to the wrong artist.
4. **Variant tags get stripped** (`(Acoustic)`, `[Remix]`, `- 2011 Remaster`) so
   `Creep` matches Radiohead's own acoustic cut when that's the only version on
   sale. Only stripped when the bracket actually contains a variant keyword, so
   real titles survive: `Untitled (How Does It Feel)`, `Doo Wop (That Thing)`.
5. **Cover mills are filtered by name** — karaoke, tribute, lullaby, sped-up,
   8-bit, string quartet, etc. See `JUNK` in `src/itunes.js`.

After any matcher change, dry-run before spending throttled requests:

```bash
node --input-type=module -e "
import {readFileSync} from 'node:fs';
import {PACKS} from './src/catalog.js';
import {trackKey,isGoodRecord} from './src/itunes.js';
const idx=JSON.parse(readFileSync('./src/resolved.json','utf8'));
let keep=0;const drop=[];
for(const p of PACKS) for(const [title,artist] of p.tracks){
  const e={packId:p.id,title,artist,loose:!!p.looseArtist};
  const r=idx[trackKey(e)]; if(!r) continue;
  isGoodRecord(e,r,{loose:e.loose})?keep++:drop.push(title+' — '+artist+' => '+r.title+' — '+r.artist);
}
console.log('KEEP',keep,'PRUNE',drop.length); console.log(drop.join('\n'));"
```

## Audio timing

`setTimeout` on an `<audio>` element drifts 20–50ms, which at the 0.1s tier is a
50% error and makes the game feel broken. `src/audio.js` fetches the preview,
decodes it once into an `AudioBuffer`, and schedules slices with
`source.start(when, 0, duration)` — sample accurate. Verified at 0.115s
wall-clock for the 0.1s tier (the extra is scheduling offset + rAF polling; the
audio itself is exact).

Keep the ~4ms fade in / ~15ms fade out or you get a click from cutting
mid-waveform. `unlock()` must be called from a user gesture (iOS/Safari).

Previews are 30s, so 16s is the practical ceiling for the tier ladder.

## Deploy

1. `node tools/build-index.mjs` until the index is full.
2. Commit `src/resolved.json` — it *is* the game data.
3. Upload the folder. ~481KB total, nothing to build, no server.

Works on GitHub Pages, Netlify, Cloudflare Pages, S3.

## UI notes

This is the next area of work. What's there now is functional and deliberately
plain — it has not had a design pass.

**Design tokens** are CSS custom properties on `:root` in `styles.css`, with a
`prefers-color-scheme: light` block overriding them. Colors are referenced only
through tokens (`--accent`, `--ink`, `--ink-2`, `--bg`, `--bg-2`, `--bg-3`,
`--line`, `--warn`, `--bad`). Retheming should mean editing those two blocks,
not hunting hex codes. `color-mix(in srgb, var(--accent) 12%, var(--bg-2))` is
used for tinted states.

**There is no dark/light toggle** — it follows the OS only. Adding one means a
`data-theme` attribute on `:root` and a third selector block, because a media
query alone can't be overridden by a button.

Pieces worth knowing before restyling:

- **The rail** (`.rail`) is the 16s timeline. `#unlocked` is a width-animated
  fill, `#ticks` holds absolutely-positioned tier marks, `#playhead` is driven
  by `requestAnimationFrame` from `player.onProgress`. Widths are percentages of
  16s — if you change `TIERS` in `app.js`, the rail rescales itself.
- **The autocomplete** (`.suggest`) opens *upward* (`bottom: calc(100% + 6px)`)
  so it doesn't collide with the controls row. It's a custom listbox, not a
  `<datalist>`, with `aria-expanded`/`aria-selected` wired up — keep those if
  you rebuild it. Selection uses `mousedown`, not `click`, so it fires before
  the input blurs.
- **Guess rows** are pre-rendered as all 7 slots and restyled by class
  (`.active`, `.wrong`, `.skip`, `.correct`), so the list doesn't reflow as you
  play.
- **Dialogs** are native `<dialog>` + `showModal()`, styled via `::backdrop`.
- **Pack cards** get `disabled` when the manifest can't serve them; don't style
  them as merely dim, they're genuinely unclickable.
- Only one breakpoint exists (`max-width: 520px`) and mobile has had little
  attention. The pack grid is `auto-fill minmax(220px, 1fr)`.

Space bar plays the current snippet when focus isn't in a text field — keep that
guard if you add inputs.

## Verifying changes

There are no automated tests. The check that matters is driving a real round in
the browser and confirming the only host contacted is the audio CDN:

```js
const calls=[]; const of=window.fetch;
window.fetch=(...a)=>{calls.push(String(a[0]).split('/')[2]);return of(...a);};
// ...play a round...
[...new Set(calls)]   // expect only ["audio-ssl.itunes.apple.com"]
```

`localStorage` keys are all prefixed `earworm.`; `localStorage.clear()` gives a
clean slate. Daily results are keyed by date *and* pack signature, so changing
pack selection gives you a different daily puzzle.
