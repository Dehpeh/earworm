# Earworm

A Songless/Heardle-style game: you hear **0.1 seconds** of a song and try to
name it. Every skip or wrong guess buys you a longer clip:
`0.1s → 0.5s → 1s → 2s → 4s → 8s → 16s`. Seven tries.

**Seven crates — pop, rap, rock, indie, anime, K-pop and game music — at
1,500+ songs each**, three difficulties, tuned for someone born around 2004.
Anime tracks are labeled with their source, so the reveal reads "Kimetsu no
Yaiba OP1", and game tracks with their game. You can search the guess box by
show or game as well as by song or artist, and naming the show or the game
counts as getting it. A wrong song by the right artist shows yellow. You can
scrub around inside whatever you have unlocked instead of always hearing it
from the top.

Two modes that actually differ. **Daily** is one song per genre per day, the
same for everyone, one attempt each. **Endless** is yours: pull out the crates
you want, pick a difficulty, and keep going. **Your Music** adds an eighth crate
built from your Spotify top tracks and liked songs, matched to previews in the
browser — no backend, nothing leaves the page but the sign-in.

Static HTML/CSS/JS. No framework, no build step, no backend. The only key is
the public Spotify client id in `src/config.js`, and only if you want that crate.

## Run it

```bash
node server.mjs
```

Then <http://localhost:5173>. A server is required, because ES modules do not
load over `file://`.

## How the real games do it, and what this does

I checked what Songless actually serves. Its audio comes from
`cdnt-preview.dzcdn.net` — **Deezer** — and the URL is embedded directly in the
server-rendered HTML. Clicking play fires no network request at all.

The reason it's server-rendered is that Deezer preview URLs are signed and
expire in about **14 minutes**:

```
https://cdnt-preview.dzcdn.net/api/1/1/a/c/.../file.mp3
  ?hdnea=exp=1787018483~acl=...~hmac=425e6864...
```

So Songless keeps a static song list and has its Next.js server mint a fresh
signed URL on every page load. That's the whole trick: **static song list,
fresh audio URL at serve time.** It requires a backend.

Earworm gets the same result without one, because **Apple's preview URLs are
unsigned and long-lived**. So the URLs can just be resolved once, written to a
file, and committed:

| | Songless | Earworm |
| --- | --- | --- |
| Audio source | Deezer | iTunes/Apple Music previews |
| URL lifetime | ~14 min, signed | unsigned, long-lived |
| Needs a backend | yes, to re-sign | no |
| API calls per round | 0 (server did it) | 0 |

Spotify isn't an option for either: it
[removed `preview_url`](https://community.spotify.com/t5/Spotify-for-Developers/Preview-URLs-Deprecated/td-p/6791368)
for apps registered after Nov 2024. SoundCloud's API registration has been
closed for years.

## The catalog seeds on artists, not songs

The first version of this catalog was ~700 hand-written `[title, artist]` pairs,
and every one of them had to be *proven* to exist. That meant a throttled
`/search` per artist plus a matcher strict enough to stop `Holocene` resolving
to the Vitamin String Quartet cover. It still left 24 songs unresolved.

That does not scale to 3,000 songs, so the pipeline is inverted. What's
hand-written now is **artists** (`src/artists.js`, ~810 of them, each tagged
with a rough fame tier). One `/search` with `attribute=artistTerm` returns that
artist's own catalog, and tracks are harvested out of the response.

Every song is then real by construction: real title, real credit, real preview
URL. There is no matcher, nothing unresolved, and no wrong matches to hunt. It
also costs fewer requests than proving a smaller hand-written list.

```bash
node tools/build-packs.mjs             # fetch what isn't cached, then pack
node tools/build-packs.mjs pop rap     # limit to these genres
node tools/build-packs.mjs --repack    # re-derive from cache, zero network
node tools/build-packs.mjs --refresh   # re-mint preview URLs via /lookup
```

### Rate limits, and why the cache exists

Apple's two endpoints behave completely differently, and the asymmetry is the
whole architecture:

- **`/search` is throttled** to roughly 20 calls/minute per IP, and answers
  `403` for *minutes* once you cross it. The builder paces itself at 15/min,
  backs off from 60s to 15min when throttled, and writes each response as it
  arrives so `^C` costs nothing.
- **`/lookup` takes ~200 ids per call and is not throttled** (25 rapid calls,
  all `200`). So `--refresh` re-mints every preview URL in the whole catalog in
  a handful of requests.

Every raw response is written to `tools/cache/` *before* anything is derived
from it. Filter rules, per-artist caps and difficulty bands can then be retuned
with `--repack`, which touches no network at all. Only new artists cost requests.

A cold build is about 1,300 requests and roughly ninety minutes. The cache is what stops
that being an hour you pay twice. `LIMIT=4` exercises the entire pipeline for
four requests when you're changing the fetch path.

### What gets thrown away

The store sells plenty of things you should not have to guess from 0.1 seconds:

- **Live, instrumental, karaoke, interlude, skit and intro cuts** are dropped.
- **Remasters and radio edits are kept**, because for older catalogs they're
  often the only version on sale. Variant tags are then stripped so the same
  song across five releases dedups down to one.
- **Anything under 60 seconds** is a skit, not a song.
- **Cover mills** (karaoke, lullaby, string quartet, sped-up, 8-bit) are
  filtered by name.
- Results are grouped by `artistId` rather than by name, so features and
  same-name acts don't leak in. J-pop and K-pop packs skip the name check
  entirely, because the store credits in kana, kanji or hangul while the seed
  list is romanized.

### Difficulty comes from listening data

The first version of this ranked songs by a fame tier I'd assigned to each
artist. Measured, that turned out to be ~93% of the outcome on its own, which
made difficulty mean "how famous is the artist" rather than "how famous is the
song" — Turnstile's biggest song landed in hard, a soundtrack cut by a famous
artist landed in easy.

Apple's API has no popularity field. Deezer's does, and it needs no key, so
`tools/rank-songs.mjs` looks up every track's `rank` there and cuts each pack
by it: the top 15% is easy, the next 30% medium, the rest hard. Easy is meant
to be the hits nearly everyone knows, not the top third of everything, which is
why it is a thin slice. Roughly 98% of tracks match. The catalog and all the
audio still come from Apple; Deezer is consulted at build time and never
appears at runtime.

It's worth knowing the number tracks *recent* listening rather than all-time
recognition, so it skews toward current hits.

### The anime pack knows its sources

Apple's metadata has no notion of which anime a song opened. That mapping comes
from [AnimeThemes.moe](https://animethemes.moe), whose catalog is downloaded
once at build time (keyless API, cached). The anime pack keeps only tracks that
match it, and each one carries its provenance — "Kimetsu no Yaiba OP1" — which
shows on the reveal and is searchable in the guess box, because people know
openings by show, not by title.

### If a URL goes stale

Apple's preview URLs are long-lived but they do rotate. On a load failure the
client re-mints that one song from its `trackId` via `/lookup`, the unthrottled
endpoint, and retries. Run `--refresh` and redeploy to fix it permanently.

## Why snippets are sample-accurate, and how scrubbing is free

An `<audio>` element plus `setTimeout` drifts 20–50ms. At the first tier that's
a 50% error, which would make the whole game feel broken. So `src/audio.js`
fetches the preview, decodes it once into an `AudioBuffer`, and schedules each
slice with `source.start(when, offset, duration)`, accurate to the sample. A
~4ms fade in and ~15ms fade out kill the click you'd otherwise get from cutting
mid-waveform.

Having the whole clip decoded up front is also what makes scrubbing cost
nothing: any region of the buffer can be scheduled as precisely as the region
starting at zero. Nothing streams and nothing seeks. Drag across the waveform,
let go, and playback starts where you dropped it.

The waveform you're dragging on is drawn from that same decoded buffer, and it
always shows exactly the window you've unlocked, stretched to full width. A
fixed 16-second axis would render the first tier as 0.6% of the element, far too
small to put a cursor on.

Previews are 30 seconds, which comfortably covers the 16-second maximum. Both
the Apple preview CDN and the search API send `Access-Control-Allow-Origin: *`,
so the browser can fetch and decode directly.

### Clips are aligned to their first audible sample

Apple cuts previews at a fixed offset into the track rather than at a musical
boundary, so some open on silence or a fade-in — about 4% of them by more than
100ms. At the 0.1 second tier that is an unwinnable round: you spend guesses on
nothing. Every time on the player is therefore measured from where the music
actually starts, found by scanning for 100ms of sustained signal above a share of
the clip's own loudness. The first tier is always a tenth of a second of real
audio.

## Adding artists

Everything lives in `src/artists.js`:

```js
{
  id: 'rock', name: 'Rock', code: 'RCK',
  color: '#E4483F',
  blurb: 'Riffs, arenas and college radio',
  artists: [
    ['My Bloody Valentine', 3],
    ['Ride', 3],
  ],
}
```

The number is a fame tier: `1` household name, `2` well known inside the genre,
`3` deeper cut. It only has to be roughly right, since it feeds a ranking rather
than a threshold.

A new genre also needs a `color`, and that colour must clear 4.5:1 against
either `#17170e` or `#f7f7f5` — the two ink options a filled crate picks between
at runtime. There is an audit command in `CLAUDE.md`.

Optional per-genre flags: `minYear` (pop is `2000`) and `nativeScript: true`,
which turns off the artist-name gate for catalogs the store credits in kana,
kanji or hangul.

Then run `node tools/build-packs.mjs`. Cached artists are skipped, so adding ten
names costs ten requests rather than a rebuild. It prints each pack's totals and
flags any pack that came in under 500 songs.

## Layout

| File | What it does |
| --- | --- |
| `index.html` | Markup and dialogs |
| `styles.css` | All styling, both themes, all design tokens |
| `fonts/` | Self-hosted Archivo and IBM Plex Mono |
| `src/artists.js` | **The hand-edited source: 23 genres, seed artists, tiers, colours** |
| `src/packs/*.json` | **Generated, and the only song data the game reads** |
| `src/catalog.js` | Loads the pack index and pack files on demand |
| `src/itunes.js` | Normalizing, matching and `/lookup` |
| `src/audio.js` | Web Audio player: decode, slice, scrub, volume, peaks |
| `src/app.js` | Game state, UI, waveform, stats, sharing |
| `tools/build-packs.mjs` | Generates the packs |
| `server.mjs` | Local dev static server |

Pack files are fetched on demand, so picking one pack downloads one pack rather
than the whole catalog.

## The crate

The interface is a record crate: genres are tabbed folders you flip through and
pull out, each with its own colour, saturated when selected and drained when
not. It owes the folder-stack idea to [Mosby's Files](https://www.mosbyfiles.com/).

Colour is the primary signal rather than decoration, which is why every crate
colour has to clear 4.5:1 against one of the two ink options, and why the text
colour on a filled crate is computed at runtime rather than set by hand. During
a round the crate colours are deliberately absent — tinting the game screen with
the pack's hue would leak which crate the song came from. The colour arrives on
the reveal, where the answer appears as its own crate's folder.

## Modes, keys and storage

**Daily** is one song per genre per day, drawn from the easy and medium bands.
You get one attempt per genre; reopening a played tile shows what you got. Each
genre walks a fixed shuffle of its pack one entry per day, so a song does not
come round again until the whole pack has. Everything rolls over at local
midnight, even in a tab left open. **Endless** reads your crate selection and
difficulty, avoids the last 200 songs you saw, and never ends.

`Space` plays the current clip. `T` toggles the theme and `?` opens help. On the
waveform, arrow keys nudge the cue and `Enter` plays. The wordmark takes you home
from anywhere.

Dark is the default because the game is usually played in headphones; the theme
follows your OS until you press `T`, which overrides it.

Crate selection, difficulty, volume, theme and the daily results live in
`localStorage` under the `earworm.` prefix. There is no stats screen. There's no backend and nothing
leaves the browser.
