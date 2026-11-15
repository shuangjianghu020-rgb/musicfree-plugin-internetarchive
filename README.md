# Internet Archive — MusicFree plugin

Adds the [Internet Archive](https://archive.org) audio collection as a MusicFree
source: public-domain recordings, live concert archives, netlabels, 78rpm
records, radio programmes (~3.6M items).

## Install

Copy `plugin.js` into the MusicFree plugin folder as `internet-archive.js`:

```
Windows : %APPDATA%\MusicFree\musicfree-plugins\internet-archive.js
Android : Android/data/fun.upup.musicfree/files/plugins/internet-archive.js
```

## Why the URL handling looks unusual

The obvious download URL —

```
https://archive.org/download/<item>/<file>
```

— answers **302 → 401/403** from this network. The redirect lands on an
`ia*.us.archive.org` storage node that may be unreachable or refuse the request;
several nodes return nothing at all.

The working path reads `/metadata/<id>` and builds the URL from the item's own
`workable_servers` list plus its `dir`:

```
https://<server><dir>/<file>
```

which returns `200 audio/mpeg` (or `audio/flac`) with a valid magic header. This
is what `getMediaSource` does.

## Other verified API facts

- **Flags are the STRING `"true"`, not booleans.** `access-restricted-item` and
  per-file `private` both arrive as `"true"`. Comparing with `=== true` silently
  matches nothing and lets gated items through — the first version of this
  plugin did exactly that and served 403s. `isFlagSet()` handles both shapes.
- **`private: "true"` marks gated media.** Items carrying it answer 403/401 on
  download. Freely downloadable items have no `private` key at all. Verified by
  diffing a restricted item against a working one.
- **`/metadata/<id>` may omit `files` entirely** for restricted items.
- **`format` is the reliable media type** — `"VBR MP3"`, `"64Kbps MP3"`,
  `"Ogg Vorbis"`, `"Flac"`. Filtering on the filename extension alone misses
  items; filtering on `format` alone includes derivatives.
- **Search quality is poor without field scoping.** A bare `Beethoven` query
  returns podcasts and unrelated talks, so the plugin searches
  `title:(…) OR creator:(…)`.

## Features

| Method | Behaviour |
|---|---|
| `search` | Field-scoped search (`title` / `creator`) within audio items |
| `getMediaSource` | Storage-node URL built from the item's own metadata |
| `getTopLists` | 6 collections (Music, Live/etree, Netlabels, Books, Radio, 78rpm) |
| `getTopListDetail` | Resolves each hit into a playable item |
| `getLyric` | `undefined` — no lyrics field |

Search results are resolved in parallel — each hit needs one metadata round-trip
to find a real audio file, and roughly 4 in 20 hits have no usable audio and are
dropped.

## Verified

`node test/verify.js` — **14 checks, all passing**:

```
===== 14 passed, 0 failed =====
```

- 16 of 20 searched items resolved to playable files
- 6/6 sampled streams returned real audio: `audio/flac` and `audio/mpeg`
  (1.4 MB – 50 MB)
- A search hit for "Beethoven" streamed `audio/mpeg`
- Inside MusicFree the app's `<audio>` element reached `readyState: 4`

## Layout

```
plugin.js        the plugin (single CommonJS file, no build step)
test/verify.js   live checks, run with `node test/verify.js`
```
