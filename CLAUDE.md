# Earworm — working context

Name a song from 0.1 seconds. Static HTML/CSS/JS, no framework, no build step,
no backend, no API keys. `README.md` covers how it works; this file covers the
things that will bite you.

## Run it

```bash
node server.mjs          # http://localhost:5173
```

A server is required. ES modules do not load over `file://`. `server.mjs` is dev
only and is not part of the deploy.

## The one invariant

**The game never calls a music API at runtime.** It reads `src/packs/*.json` and
nothing else. The only network request during a round is the audio file itself,
from `audio-ssl.itunes.apple.com`.

Do not reintroduce a live search call in the play path. That is what the first
version did and it broke with `403 Apple is rate-limiting song lookups`. If you
are tempted, read the rate-limit section below.

Two tolerated exceptions, neither in a round:

- `remintPreview()` in `src/app.js`: if a clip fails to load, it re-mints that
  one song from its stored `trackId` via `/lookup`, which is not rate-limited.
  Failure path only.
- The **"Your Music" import** in `src/spotify.js`: a one-off, user-initiated
  build of a personal pack that matches Spotify tracks to Apple previews. It
  tries the built packs first (no network), then calls throttled `/search`
  once *per artist* at `GAP_MS` with a 60s back-off on 403, capped at 60
  artists. It has a progress bar and a Stop button, and it never runs while a
  round is being played. See "Your Music" below.

**Deezer is a build-time dependency only.** `tools/rank-songs.mjs` calls it for
popularity data and nothing else. No Deezer URL is ever stored or played —
theirs are signed and expire in about 14 minutes, which is the whole reason this
game uses Apple audio and has no backend.

## Files

| File | Role |
| --- | --- |
| `index.html` | Markup + dialogs |
| `styles.css` | All styling, both themes, all tokens |
| `fonts/` | Self-hosted Archivo + IBM Plex Mono, latin and latin-ext |
| `src/artists.js` | **The human-edited source.** 7 genres, ~900 seed artists, colours, caps |
| `src/packs/*.json` | **Generated. The only song data the game reads.** Commit it |
| `src/catalog.js` | Loads the pack index and pack files, expands the stored shape; the personal pack |
| `src/spotify.js` | "Your Music": PKCE auth, library fetch, match to Apple. Import time only |
| `src/config.js` | Per-deployment public values: the Spotify client id |
| `src/itunes.js` | Normalizing, matching, and `/lookup`. Build time, plus the re-mint |
| `src/audio.js` | Web Audio player: decode, slice, scrub, volume, peaks, onset |
| `src/sfx.js` | Synthesized sound cues. No audio assets |
| `src/app.js` | Screens, game state, waveform, crate colour, sharing |
| `tools/build-packs.mjs` | Generates the packs |
| `tools/fetch-animethemes.mjs` | Downloads the AnimeThemes.moe catalog for anime provenance |
| `tools/rank-songs.mjs` | Sets difficulty from Deezer popularity. Build time only |
| `tools/cache/` | Raw API responses, gitignored. See below, it matters |

## The catalog seeds on artists, not songs

The original pipeline started from hand-written `[title, artist]` pairs and had
to *prove* each one existed. That needed a throttled `/search` per artist plus a
matcher strict enough to stop `Holocene` resolving to the Vitamin String
Quartet, and it still left 24 songs unresolved out of 690.

Seeding on artists deletes the problem. One `/search` with `attribute=artistTerm`
returns that artist's own catalog, so every track harvested from it is real by
construction: real title, real credit, real preview URL. There is no matcher, no
unresolved rows, and no wrong matches to hunt.

What you edit is `src/artists.js`. What the game reads is `src/packs/*.json`.

```bash
node tools/build-packs.mjs             # fetch what isn't cached, then pack
node tools/build-packs.mjs pop rap     # limit to these genres
node tools/build-packs.mjs --repack    # re-derive from cache, zero network
node tools/build-packs.mjs --refresh   # re-mint preview URLs via /lookup
```

### tools/cache/ is the point

Every raw API response is written to `tools/cache/<genre>/<artist>.json` *before*
anything is derived from it. Filtering rules, the per-artist cap and the
difficulty bands can then be retuned as often as you like with `--repack`, which
touches no network at all. Only adding new artists costs requests.

A full cold build is ~750 requests and takes about an hour, plus ~200 keyless requests to AnimeThemes.moe. Never throw the
cache away to "start clean" — that is two hours you do not get back.

### A long build holds its config from process start

`artists.js` and the filter rules are read into memory when the process
launches, and the pack files are only written at the very end. So editing a
colour, a `minYear`, or a filter *while a build is running* does nothing to that
run, and an hour later the run writes over your edit with the old rules. This
already happened once: a build stamped out the crate colours and reverted pop to
1970 long after both had been changed.

The recovery is free — `--repack` re-derives everything from cache in seconds —
but you have to notice. After any long build finishes, check that the output
still reflects the current rules before assuming it is good.

### Rate limits

| | `/search` | `/lookup` |
| --- | --- | --- |
| Limit | ~20 calls/min per IP | none observed |
| Over the limit | `403` for **minutes** | — |
| Batching | one query | ~200 ids per call |

`GAP_MS` defaults to 4000, which is 15 requests/min and stays under the ceiling.
If you hammer `/search` the IP goes into a penalty box that outlasts the
documented limit by a lot. The builder handles this with escalating backoff
(60s → 15min) and writes each response as it arrives, so `^C` costs nothing.

Use `LIMIT=4` to smoke-test the whole pipeline for four requests instead of 800.
Do that before any change to the fetch path.

### Harvest rules

All of these exist because the store returned something the game should not ask
you to guess:

1. **Group by `artistId`, and pick the *best*-matching group, not the biggest.**
   An artistTerm search leaks features and same-name acts. Ranking candidates by
   size was a real bug: searching the UK rapper "Dave" also matches "Dave
   Matthews Band", whose catalog is far larger, so the band won; likewise the
   Korean artist "DEAN" lost to "Olivia Dean". Exact credit beats a leading-token
   match beats bare containment, and size only breaks ties.
2. **The anime genre fetches by resolved artistId, not by name search**
   (`lookupArtist: true` → `searchArtistById`). A plain artistTerm search for a
   one-word act is garbage in: "LiSA" returned 200 tracks of Lisa Loeb, TLC and
   BLACKPINK's LISA, and the actual anisong LiSA barely appeared in her own
   results. The id path exact-matches the *artist* entity, disambiguates
   same-name artists on Apple's own genre field (LiSA is Anime/J-Pop, LISA is
   K-Pop), then pulls that artist's songs through the unthrottled /lookup.
   Costs the same one throttled call per artist.
3. **A one-word seed with no exactly-credited group is dropped, not guessed.**
   The US store returns no solo "Dave" at all, so the best remaining candidate
   was six Dave Matthews Band songs in a rap pack. Losing an artist beats
   importing someone else. Does not apply to `nativeScript` genres, where script
   differences make exact matching impossible.
4. **K-pop and anime need `nativeScript: true`.** The store credits in kana,
   kanji or hangul while the seed is romanized, so no group matches by name and
   the largest group is the right answer instead.
5. **Live, instrumental, karaoke, interlude, skit and intro cuts are dropped.**
   Guessing a song from 0.1s of a live recording is a different, worse game.
6. **Remasters and radio edits are kept.** They are frequently the only version
   an old catalog sells. `coreTitle()` then dedups them onto one song.
7. **Under 60 seconds is a skit, not a song.**
8. **Compilations, samplers and "X presents" albums are dropped.** They put an
   artist's name on tracks that are not theirs to be known for, and they rank
   high in an artistTerm search because the credit matches. A Wu-Tang family
   album cut is a real Raekwon song and a terrible thing to guess from 0.1s.
9. **`anyArtist: true` and `maxTitle` exist but no genre currently uses them.**
   They were added for the classical pack, since a work is credited to whichever
   orchestra recorded it and movement titles blow past the 60-character cap.
   That genre has since been removed; the flags are kept because any
   composer-credited genre would need them again.
10. **The anime pack is theme-matched, not just artist-seeded.** `themeMatch:
   true` keeps only tracks found in the AnimeThemes.moe catalog
   (`tools/fetch-animethemes.mjs`, cached like everything else), and each
   surviving track carries its source as `m`: "Kimetsu no Yaiba OP1". Apple's
   metadata has no notion of which anime a song opened, so provenance has to
   come from a database whose whole purpose is that mapping. When one song
   served several shows, the earliest anime wins. Store titles carry suffixes
   the theme database does not, so matching tries several candidate title keys
   and both the seed name and the store credit.
11. **`mediaFromAlbum: true` stamps each track with its game.** Game music has
   no theme database; the game's name is in the album title behind a soundtrack
   tag, and `workFromAlbum()` peels it out into `m`. See "Guessing the work".
12. **Per-genre `perArtist` caps size the packs.** The 1500+ targets are met
   with 16 for pop/rap/rock/kpop, 40 for game music (composer catalogs run
   deep) and 30 for anime (the theme match is the real filter there). Measured
   from cache with `--repack` before committing — never guess a cap when a
   zero-network experiment answers it.
13. **A genre can set `minYear`.** Pop is 1997+. Filtering on release year rather
   than on the seed list means an artist who spans the boundary contributes only
   the side of it the pack wants, instead of being dropped whole.
14. **The catalog is tuned for someone born around 2004.** That is the player,
   and the first version was not: pop was 40% 80s/90s legacy acts whose
   *post-2000* filler was all the year floor let through (Michael Jackson's
   "Chicago (2014)" sat in easy), rap's tier 3 was underground boom-bap, and
   rock's tail was shoegaze obscurities. The retune dropped those, added the
   SoundCloud/trap/rage generation to rap, modern rock to rock, and created the
   **Indie** crate (keshi, Laufey, grentperez, Joji, beabadoobee, Clairo…),
   which also took the indie-leaning acts out of Rock — one song belongs to one
   pack, and the builder's `claimed` set enforces it in artists.js order. If a
   crate feels out of touch again, the fix is the seed list, not the bands.

### Difficulty comes from Deezer, not from me

```bash
node tools/rank-songs.mjs            # rank every pack
node tools/rank-songs.mjs pop rap    # limit to these
node tools/rank-songs.mjs --reband   # re-cut bands from cache, no network
```

Difficulty used to be an artist fame tier I assigned by hand, combined with each
track's position in an iTunes artist search. **Measured, that came out ~93%
determined by the tier alone** — each artist contributes exactly `PER_ARTIST`
tracks, so the equal-thirds cut landed almost exactly on the tier population
boundary and the rank signal was nearly inert. Difficulty meant "how famous is
the artist", not "how famous is the song": Turnstile's biggest song was hard and
a soundtrack cut by a famous artist was easy.

Apple's API has no popularity field of any kind. Deezer's does — every track
carries a `rank`, and the endpoint needs no key, no OAuth and no account. So the
catalog still comes from Apple and only the difficulty signal comes from Deezer.
Match rate is around 98%; unmatched tracks keep a null rank and sort to the hard
end rather than being dropped, because an unmatched track is usually genuinely
obscure.

The fame tiers in `artists.js` still exist and still drive *harvest order*
(which tracks get picked per artist). They no longer drive difficulty.

**The bands are not thirds.** `BANDS` in `rank-songs.mjs` cuts easy at the top
15% of a pack, medium at the next 30%, hard is the rest. Equal thirds was the
first cut and it made "easy" 700 songs deep in pop, with Kim Petras album tracks
and Cocteau Twins B-sides at the tail — nobody gets 80% of those. Easy is meant
to be each artist's actual hits; the target is roughly 80-90% / 50% / 20%
success for someone who knows the genre. `--reband` re-cuts from cache in
seconds and also refreshes the per-band counts in `index.json`, which is where
the picker reads them from.

The Deezer cache lives in `tools/cache/deezer/`, gitignored like the rest. A
cold re-rank is ~12k lookups; Deezer allows ~10/s, so run the packs as parallel
processes with `GAP_MS=400` (about 45 minutes) rather than one process at the
default gap. The script retries on Deezer's quota error instead of caching a
null, so a throttle cannot poison the ranks.

**Query with the fielded syntax, not free text.** `q=Someone Like You Adele`
returns nothing but covers; `q=artist:"Adele" track:"Someone Like You"` finds
the record. Free text alone left ~10% unmatched and the misses included "Take
On Me", "Nothing Else Matters" and "Bye Bye Bye" — which then sank to *hard*,
the exact opposite of the truth. The lookup now tries fielded first with the
lead artist and the title stripped of bracketed tags (verbatim "21 Questions
(feat. Nate Dogg)" returns zero hits), falls back to free text, and takes the
highest rank among the hits that are this song rather than the first hit, which
is often a live cut. Match rate is 94-100% per pack (vgm 89%). `--retry-nulls`
re-looks-up cached misses only, which is how the query upgrade was applied
without another 45-minute cold run.

**What the number is not.** Deezer's rank tracks recent listening, not all-time
recognition — "The Fate of Ophelia" outranks "Bohemian Rhapsody" on it. It is a
far better signal than what it replaced, but it skews current, and it is
Deezer's audience rather than everyone's.

## Audio

`setTimeout` on an `<audio>` element drifts 20-50ms, which at the 0.1s tier is a
50% error and makes the game feel broken. `src/audio.js` fetches the preview,
decodes it once into an `AudioBuffer`, and schedules slices with
`source.start(when, offset, duration)`, which is sample accurate.

Decoding the whole clip up front is also what makes **scrubbing** free: any
region can be scheduled as precisely as the region starting at zero. Nothing
streams and nothing seeks. `play(from, to)` is the whole API.

### Every time on the player is measured from the first audible sample

Apple cuts its previews at a fixed offset into the track, not at a musical
boundary, so a share of them open on silence, room tone or a fade-in. Measured
across a 48-clip sample, about **4% start with over 100ms of dead air**, worst
case j-hope's "Daydream" at 0.74s — which silently voided the first *four*
tiers, because 0.1s and 0.5s both landed before the music began. That is not a
difficulty curve, it is an unwinnable round.

`_findOnset()` finds where the music actually starts and every public time on
`SnippetPlayer` is relative to it: `play()`, `peaks()` and `duration` all add the
onset on the way to the buffer, so `app.js` never sees it and the tier ladder is
always 0.1s of *real audio*. On "Daydream" the energy in the first 100ms goes
from 0.00016 to 0.186.

The threshold is a share of the clip's own 90th-percentile loudness, not an
absolute one, so it behaves the same on a quiet ballad and a loud mix. It
requires 100ms of *sustained* signal so a click or a vinyl pop does not read as
the song starting, and it never trims so far that the 16s ladder stops fitting.
A clip with no loud part at all returns 0 rather than inventing an offset.

Keep the ~4ms fade in / ~15ms fade out or you get a click from cutting
mid-waveform. `unlock()` must be called from a user gesture (iOS/Safari).

Volume is a master `GainNode` on a squared curve, because a linear slider spends
its top half doing nothing audible. It ramps with `setTargetAtTime` rather than
jumping, or dragging the slider crackles.

Previews are 30s, so 16s is the practical ceiling for the tier ladder.

## Modes

The two modes are genuinely different, not two shuffles of the same thing:

- **Daily** is one song *per genre* per day, one attempt each, drawn from the
  easy and medium bands (one shot at a hard-band B-side is not a puzzle, it is
  a coin you cannot win), saved under `earworm.daily.<date>.<packId>`. The home
  screen is a tile per crate; opening a played tile replays its reveal.
- **Endless** is the one that reads your crate selection and difficulty, avoids
  the last 200 songs you saw, and never ends.

**The daily song is not a hash of the date.** `dailyOrder()` gives each pack one
fixed shuffle (seeded on the pack id, over tracks sorted by id so file order is
irrelevant) and day N plays entry N. A per-day hash repeats by chance inside a
couple of months at these pack sizes; the walk cannot repeat until the pack is
exhausted. A rebuild that adds songs reshuffles, which is accepted.

**Midnight is handled, twice.** `state.daily.date` is pinned when the round is
dealt so a game that crosses midnight saves under the day it was dealt for, and
`rollover()` (a timer for the next local midnight plus `visibilitychange`, since
laptops sleep through timers) redraws a visible home screen for the new day.

There is no stats screen. It was removed deliberately.

**A guess by the right artist is "close"**, kind `close`, yellow-tinted row,
mark `~`, its own cue, 🟨 in the share grid (correct moved to 🟩). It is still
a miss — the tier advances — it just tells you you are warm. Detected with
`artistMatches()` on the pick's credit against the answer's, so a feature
credit ("Lil Baby & Drake") counts for either name. Work picks are never close;
a work has no artist.

## Your Music (Spotify)

A personal crate built in the browser from a Spotify account. `src/spotify.js`
owns it; `src/config.js` holds the public `SPOTIFY_CLIENT_ID` (per deployment,
not a secret — PKCE has none). The pack is saved to `localStorage` under
`earworm.spotify.pack` **in the same stored shape as the built packs**, so
`catalog.js` expands it with the same `expand()`, `personalPackMeta()` gives it
an index entry (`personal: true`, Spotify green, id `spotify`), and
`mergePersonal()` in `app.js` pushes it into `state.index` — after which the
picker chips, the daily tiles, counts, reveal colour and share text all pick it
up with no special casing.

What Spotify is *for*: top tracks (three windows) and liked songs (newest 200),
deduped, top tracks first. What it is not for: audio — preview URLs are gone
from the Web API for new apps, so every track is matched to Apple like
everything else. Apple has no ISRC lookup (measured), so matching is the built
packs first, then throttled `/search` once per artist, at `GAP_MS`, capped at
`MAX_ARTIST_SEARCHES` (60), with a 60s back-off on 403. Cancelling keeps what
was found. Difficulty inside the crate is Spotify `popularity`, cut 15/30/rest —
and while Your Music is selected the picker offers a fourth band, **All**
(`ALL`, id 0, key `total`), which is every song of every selected crate with no
band filter. It disappears, and the choice falls back to Medium, the moment
Your Music leaves the selection.

Auth is Authorization Code + PKCE, no backend: verifier and state in
`sessionStorage` for the redirect, tokens in `localStorage`. **Spotify refuses
`http://localhost` as a redirect URI** — only https, or the loopback
`http://127.0.0.1:5173/`. `redirectUnsupported()` detects the wrong host and
says so instead of sending you to a dead end. While the Spotify app is in
Development Mode, each connecting account must be listed under User Management
(cap 25) or the API answers 403; that error is surfaced verbatim.

Test the matcher without an account: `import('/src/spotify.js')` in the console
and call `matchToApple(fakeTracks, await loadTracks(index))` — one Apple call
per unknown artist. `savePersonalPack(rows)` then `location.reload()` shows the
crate everywhere; Remove on the picker clears it and the tokens.

## Guessing the work, not the song

For anime and game music, naming what the song is *from* counts. Each track
carries `media` (the builder's `m`: "Naruto: Shippuuden OP3", or the game name
peeled out of the album title by `workFromAlbum()` for genres flagged
`mediaFromAlbum`) and `catalog.js` derives `work` from it by dropping the OP/ED
slot. `setSearchPool()` collects the distinct works; they appear in the
autocomplete as their own rows (marked `.work`, ranked prefix-first then by song
count) and `submitGuess()` treats a pick as correct when its `nw` equals the
answer's — whether the pick is the work itself or *another song from the same
work*. If you know it is Naruto, you know it is Naruto.

`workFromAlbum()` is a heuristic over Apple's soundtrack-title house styles. It
was dry-run over every vgm album before shipping; artist albums with no game
("Endless Fantasy", "Level 2") pass through unchanged, which just makes the album
an alias for its own songs. `src/packs/vgm.json` was stamped with `m` directly
because the build cache is not on every machine; a future `--repack` produces
the same values from `record()`.

## UI

The interface is a **record crate**. Genres are tabbed folders you flip through
and pull out. Debt to Mosby's Files (mosbyfiles.com) for the folder-stack idea.

The version before this one was designed in the product register: restrained,
one muted accent, an instrument that gets out of your way. That was the wrong
call for a game, and it produced a real usability failure — nothing announced
itself, so you could not tell at a glance what was selected. **Colour is now the
primary signal.** Every crate owns a hue.

**Colour rules, all of which have teeth:**

- Each genre's colour lives in `src/artists.js` and is carried into
  `packs/index.json` by the builder. Adding a genre means adding a colour.
- Text on a filled crate is picked at runtime by `inkOn()` in `app.js`, which
  compares both candidates and takes whichever actually contrasts better. Do not
  replace it with a lightness threshold: 23 hand-picked hues span too wide a
  range, and dark ink is right on the yellows and wrong on the blues.
- **Every crate colour must clear 4.5:1 against one of the two ink options.**
  Two of the original 23 did not and had to be lifted. There is an audit in
  "Verifying changes" below; run it after touching any colour.
- An unselected crate recedes *towards the ground*, so `--drain` flips direction
  per theme: darker on the dark ground, lighter on paper. A single filter value
  makes unselected crates louder in one of the two themes.

**The game screen deliberately does not use crate colour.** During play the only
saturated colour is `--go`, because tinting the round with the pack's hue would
leak which crate the song came from. The colour arrives on the reveal, where the
answer appears as its own crate's folder.

**Two displays, deliberately separate:**

- **The ladder** is game state: seven equal cells, one per tier. Equal because
  the tiers are a ladder of steps, not a timeline.
- **The waveform** is audio: it shows exactly the unlocked window, always at full
  width, redrawn from the decoded buffer at each tier.

A single linear 16s axis was the obvious first move and it is wrong. 0.1s is
0.6% of 16s, so the first four tiers render as an invisible sliver you cannot put
a cursor on. Rescaling the canvas to the unlocked window keeps the scrub target
full-size at every tier. Scrubbing is disabled below `SCRUB_MIN` (1s).

**`[hidden]` needs `!important`.** Several panels are `display: grid` from a
class and toggled with the attribute, and an author-origin `display` beats the UA
sheet's `[hidden]` rule. Without it, `#game` renders underneath `#home`.

**Reduced motion is not cosmetic here.** The pull-out slide is suppressed under
`prefers-reduced-motion`, so selection has to remain legible from the
drained/saturated contrast alone. It does. Keep it that way.

Other things worth knowing before restyling:

- **One variable font file** carries both axes (weight 100-900, width 62-125%).
  That is what lets the display type be heavy and condensed while UI text stays
  normal width, with no second family.
- **The autocomplete** opens *upward* so it does not collide with the controls
  row. Custom listbox, not a `<datalist>`. Selection uses `mousedown`, not
  `click`, so it fires before the input blurs.
- **`.help-list li` is normal flow, not grid.** Those items mix text nodes and
  inline `<strong>`; as grid children each becomes its own row and the copy
  shatters into one word per line.
- **Clicking the scrim closes any dialog.** The test is geometric (click point
  outside `getBoundingClientRect()`), not `e.target === dialog`, because a
  click on the dialog's own padding also targets the dialog and must not close
  it.
- **The reveal is a modal, and the `#reveal` node *moves*.** On round end it is
  appended into `#reveal-dialog` and popped centre-screen; on close it is
  appended back into `#game`, so the board keeps an inline record. One node, one
  source of truth, no duplicated ids. Chrome fires the dialog `close` event on a
  queued task rather than synchronously, which is why `resetGameChrome()`
  force-reclaims the node itself instead of trusting the listener to have run.
- **Sound cues are synthesized in `src/sfx.js`**, not shipped as files. They
  route through the player's master gain, so the volume slider governs them, and
  they fire only from user-gesture paths, so autoplay policy never blocks them.
  `advance()` owns the wrong/skip cues so the final miss plays only the lose
  sound, not a buzz underneath it.
- Space plays the current clip when focus is not in a text field. T toggles
  theme, ? opens help. The global handler bails while a dialog is open, or Space
  hijacks the close button and a second `?` throws `InvalidStateError`.

## Verifying changes

There are no automated tests. The checks that matter:

```js
// 1. The play path contacts exactly one host.
const calls=[]; const of=window.fetch;
window.fetch=(...a)=>{calls.push(String(a[0]).split('/')[2]);return of(...a);};
// ...play a round...
[...new Set(calls)]   // expect ["localhost:5173", "audio-ssl.itunes.apple.com"]
```

2. Drive a real round in the browser. Scrub at 4s and confirm playback starts
   where you dropped the cursor.
3. Check both themes. The header toggle, not just the OS setting, and check
   that unselected crates recede in *both*.
4. After touching any crate colour, run the contrast audit:

```bash
node --input-type=module -e "
const {GENRES}=await import('./src/artists.js');
const lum=h=>{const c=[1,3,5].map(i=>{const v=parseInt(h.slice(i,i+2),16)/255;
  return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});
  return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];};
const R=(a,b)=>{const l1=lum(a),l2=lum(b);const[h,l]=l1>l2?[l1,l2]:[l2,l1];
  return (h+0.05)/(l+0.05);};
const bad=GENRES.filter(g=>Math.max(R(g.color,'#17170e'),R(g.color,'#f7f7f5'))<4.5);
console.log(bad.length?'FAIL '+bad.map(g=>g.code):'all crates clear 4.5:1');"
```

`localStorage` keys are all prefixed `earworm.`; `localStorage.clear()` gives a
clean slate. Daily results are keyed `earworm.daily.<date>.<packId>`; delete one
and the same song is dealt again, since the pick is deterministic. To preview
tomorrow without waiting, shadow `Date` in the console before clicking home:
`const R=Date; Date=class extends R{constructor(...a){a.length?super(...a):super(R.now()+864e5)}}`.

## Deploy

1. `node tools/build-packs.mjs` until every pack is full.
2. Commit `src/packs/`. It is the game data.
3. Upload the folder. No build, no server.

Works on GitHub Pages, Netlify, Cloudflare Pages, S3. Pack files are fetched on
demand, so a player who picks one pack downloads one pack.
