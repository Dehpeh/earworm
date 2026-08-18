# Earworm

A Songless/Heardle-style game: you hear **0.1 seconds** of a song and try to
name it. Every skip or wrong guess buys you a longer snippet —
`0.1s → 0.5s → 1s → 2s → 4s → 8s → 16s`. Seven tries.

The point of difference is breadth. Instead of pop/rock/hip-hop, there are
**24 genre packs** you can mix and match — city pop, amapiano, anime openings,
Bollywood, phonk, chanson, jazz standards, classical, video game scores,
tropicália, and so on.

Static HTML/CSS/JS. No framework, no build step, no API keys, no backend.

## Run it

```bash
node server.mjs
```

Then <http://localhost:5173>. A server is required — ES modules don't load over
`file://`.

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

### The manifest

`src/resolved.json` maps each catalog entry to its preview URL, artwork, album,
store link, and Apple `trackId`. **The game reads only this file.** It never
calls a search API, so it cannot be rate-limited, and it deploys to any static
host — GitHub Pages, Netlify, Cloudflare Pages, a plain S3 bucket.

Commit `src/resolved.json`. It *is* the game data.

### Building the manifest

```bash
node tools/build-index.mjs             # discover whatever is missing
node tools/build-index.mjs --refresh   # re-mint preview URLs (fast, free)
node tools/build-index.mjs --targeted  # repair run: skip the artist sweep
node tools/build-index.mjs --force     # rediscover everything
node tools/build-index.mjs kpop jazz   # limit to these packs
```

Two stages, because Apple's two endpoints behave completely differently:

- **`/search` is throttled** to roughly 20 calls/minute per IP, and answers
  `403` for *minutes* once you cross it. Discovery spends one call per **artist**
  (`limit=200`) and matches every catalog track by that artist out of the single
  response — 502 calls instead of 690. It's slow and patient, with escalating
  backoff, and it saves after every hit so `^C` costs nothing.

- **`/lookup` takes ~200 ids per call and is not throttled** (25 rapid calls,
  all `200`). Because discovery records each song's `trackId`, `--refresh`
  re-mints the entire catalog in **4 requests / 6 seconds** — measured on all
  666 songs, zero losses.

That asymmetry is the whole reason discovery only ever has to happen once.

### Matching

The store will happily sell you "Holocene" by the Vitamin String Quartet, so the
matcher is deliberately strict:

- A **title match is mandatory** — never a scoring signal. The artist sweep asks
  for "every song by X", so without a hard gate a missing track silently
  resolves to some *other* song by the same artist. Three different Bad Bunny
  entries collapsed onto `NUEVAYoL` before this existed.
- Per-track lookups **try the credited artist first**, and only fall back to a
  different performer for packs marked `looseArtist` (`classical`, `vgm`,
  `screen`), where the catalog credits a composer and the store credits an
  orchestra.
- Cover mills, karaoke, lullaby and sped-up re-uploads are filtered by name.
- Variant tags like `(Acoustic)` or `[Remix]` are stripped, so `Creep` can match
  Radiohead's own acoustic cut when that's the only version on sale — while
  every cover band stays out.
- Artist comparison requires **every** word of the shorter name to appear in the
  longer one. A single shared token isn't enough: Frank Ocean and Billy Ocean
  are not the same person, and `Nights` resolved to the wrong one until this.

Re-running discovery **prunes any stored entry that no longer passes the current
matcher**, so tightening these rules automatically re-resolves whatever they now
reject. Use `--targeted` for those repair runs — the artist sweep has already
failed for anything still missing, so re-running it just burns throttled calls.

**666 of 690 resolve.** The remaining 24 aren't on the US store at all (Tatsuro
Yamashita famously kept his catalog off streaming). Unresolved songs are simply
excluded — packs grey out if they can't field a round, and the smallest pack
still carries 22 songs.

If a preview URL ever goes stale in a deployed build, the client also
self-heals: on a load failure it re-mints that one song from its `trackId` via
`/lookup` (the unthrottled endpoint) and retries. Run `--refresh` and redeploy
to fix it permanently.

### Deploying

1. `node tools/build-index.mjs` until it reports a full index.
2. Commit `src/resolved.json`.
3. Upload the folder. There's nothing to build and nothing to run — `server.mjs`
   is for local development only.

## Why snippets are sample-accurate

An `<audio>` element plus `setTimeout` drifts 20–50ms. At the first tier that's
a 50% error, which would make the whole game feel broken. So `src/audio.js`
fetches the preview, decodes it once into an `AudioBuffer`, and schedules each
slice with `source.start(when, 0, duration)` — accurate to the sample. A ~4ms
fade in and ~15ms fade out kill the click you'd otherwise get from cutting
mid-waveform.

Previews are 30 seconds, which comfortably covers the 16-second maximum
snippet. Both the Apple preview CDN and the search API send
`Access-Control-Allow-Origin: *`, so the browser can fetch and decode directly.

## Adding songs

Everything lives in `src/catalog.js` as `[title, artist]` pairs:

```js
{
  id: 'shoegaze', name: 'Shoegaze', emoji: '🌫️',
  blurb: 'Loud, blurry, reverent',
  tracks: [
    ['Only Shallow', 'My Bloody Valentine'],
    ['Vapour Trail', 'Ride'],
  ],
}
```

Strings are sent verbatim to iTunes, so match how the track is credited on
Apple Music — punctuation and accents are normalized away before matching, but
a wrong artist won't resolve. Then run `node tools/build-index.mjs`; it prints
anything that failed, plus anything that resolved to a suspiciously different
artist, which is how you catch typos.

Aim for 20+ tracks per pack — the guess autocomplete only searches the packs
you've selected, so a thin pack is easy to brute-force. Packs with nothing in
the manifest are greyed out automatically rather than dealing an unplayable
round.

## Layout

| File | What it does |
| --- | --- |
| `index.html` | Markup and dialogs |
| `styles.css` | All styling; dark by default, light via `prefers-color-scheme` |
| `src/catalog.js` | The 24 packs |
| `src/resolved.json` | **The song manifest — generated, and the only data the game reads** |
| `src/itunes.js` | Search/lookup/matching. Build-time only, apart from the self-heal |
| `src/audio.js` | Web Audio snippet player |
| `src/app.js` | Game state, UI, stats, sharing |
| `tools/build-index.mjs` | Generates the manifest |
| `server.mjs` | Local dev static server |

## Modes and storage

**Daily** picks one song per day per pack combination, seeded from the date, so
everyone with the same packs gets the same song. Finishing it saves the result;
reopening shows what you got. **Endless** is unlimited and avoids the last 60
songs you saw.

Stats, pack selection, and the daily result live in `localStorage` under the
`earworm.` prefix. There's no backend and nothing leaves the browser.
