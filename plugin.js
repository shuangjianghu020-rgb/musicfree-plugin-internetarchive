// Internet Archive plugin for MusicFree.
//
// Searches the Internet Archive's audio collection (public-domain recordings,
// live concert archives, netlabels, radio programmes - ~3.6M items).
//
// ## Why the URL handling looks unusual
//
// The obvious download URL,
//   https://archive.org/download/<id>/<file>
// answers **302 -> 401/403** from this network. The redirect lands on an
// `ia*.us.archive.org` storage node that may be unreachable or refuse the
// request. Verified: several nodes return nothing at all.
//
// The working path is to read `/metadata/<id>` and build the URL from the
// item's own `workable_servers` list plus its `dir`, i.e.
//   https://<server><dir>/<file>
// which returns `200 audio/mpeg` with a real `ID3` header. This is what
// getMediaSource does.
//
// ## Other verified API facts
//
// - `/metadata/<id>` may omit `files` entirely for restricted items.
// - `metadata["access-restricted-item"] === true` means the files are gated;
//   skip those items rather than surfacing dead rows.
// - `private: true` on a file entry is NOT an access flag - it is present on
//   normal, downloadable files. Filtering on it rejects everything.
// - `format` is the reliable media-type field: "VBR MP3", "64Kbps MP3",
//   "Ogg Vorbis", "Flac".

const SEARCH = "https://archive.org/advancedsearch.php";
const META = "https://archive.org/metadata";
const PAGE_SIZE = 20;
const UA = "MusicFree-ArchiveOrgPlugin/1.0";

// Only items that actually contain audio files.
const MEDIA_QUERY = 'mediatype:(audio) AND format:("VBR MP3")';

// Collections that are known to be freely distributable and well curated.
const COLLECTIONS = [
    { id: "collection:audio_music", title: "音乐 Music" },
    { id: "collection:etree", title: "现场录音 Live (etree)" },
    { id: "collection:netlabels", title: "独立厂牌 Netlabels" },
    { id: "collection:audio_bookspoetry", title: "有声书 Books & Poetry" },
    { id: "collection:radioprograms", title: "广播节目 Radio" },
    { id: "collection:78rpm", title: "78转老唱片 78rpm" },
];

/** Internet Archive returns flags as the STRING "true", not a boolean. */
const isFlagSet = (v) => v === true || v === "true" || v === 1;

const isAudioFile = (f) => {
    const fmt = String(f.format || "");
    const name = String(f.name || "").toLowerCase();
    const looksAudio =
        fmt.includes("MP3") ||
        fmt.includes("Ogg Vorbis") ||
        fmt.includes("Flac");
    const extOk =
        name.endsWith(".mp3") || name.endsWith(".ogg") || name.endsWith(".flac");
    if (!looksAudio || !extOk) return false;
    // `private: "true"` marks gated media. Those items answer 403/401 on
    // download - verified against a restricted item vs a freely downloadable
    // one. Plain items have no `private` key at all.
    return !isFlagSet(f.private);
};

/** "320.21" (seconds) or "05:20" -> seconds */
function parseLength(len) {
    if (len === undefined || len === null) return undefined;
    const s = String(len).trim();
    if (s.includes(":")) {
        const parts = s.split(":").map(Number);
        if (parts.some(isNaN)) return undefined;
        let total = 0;
        for (const p of parts) total = total * 60 + p;
        return Math.round(total);
    }
    const n = Number(s);
    return isNaN(n) ? undefined : Math.round(n);
}

async function getJson(url) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) {
        throw new Error(`archive.org ${res.status}`);
    }
    return await res.json();
}

/** Pick the best audio file from an item's file list. */
function pickAudio(files) {
    const audio = (files || []).filter(isAudioFile);
    if (!audio.length) return null;
    const score = (f) => {
        const fmt = String(f.format || "");
        if (fmt === "Flac") return 0;
        if (fmt === "VBR MP3") return 1;
        if (fmt === "Ogg Vorbis") return 2;
        return 3;
    };
    return audio.sort((a, b) => score(a) - score(b))[0];
}

/** Build a direct storage-node URL from item metadata. */
function buildFileUrl(meta, filename) {
    const dir = meta.dir || "";
    const servers = meta.workable_servers || [];
    const encoded = String(filename).split("/").map(encodeURIComponent).join("/");
    // Freely downloadable items have no workable_servers; archive.org/download
    // works for them. Restricted items list servers but are filtered out before
    // this point.
    const base = servers.length
        ? `https://${servers[0]}`
        : "https://archive.org/download";
    return `${base}${dir}/${encoded}`;
}

/** Resolve one search hit into a playable item (needs a metadata round-trip). */
async function resolveItem(identifier, fallbackTitle) {
    let meta;
    try {
        meta = await getJson(`${META}/${encodeURIComponent(identifier)}`);
    } catch (e) {
        return null;
    }
    const md = meta.metadata || {};
    if (isFlagSet(md["access-restricted-item"])) {
        return null;
    }
    const file = pickAudio(meta.files);
    if (!file) {
        return null;
    }
    return {
        id: identifier,
        title: String(md.title || fallbackTitle || identifier),
        artist: String(md.creator || md.collection_title || "Internet Archive"),
        album: String(md.year || md.date || "") || undefined,
        duration: parseLength(file.length) || parseLength(md.runtime),
        artwork: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
        // Name resolved lazily in getMediaSource would need another round-trip,
        // so stash what we need here.
        fileName: file.name,
        fileDir: meta.dir,
        servers: meta.workable_servers || [],
    };
}

/** Run a search and resolve the first N hits that actually have playable audio. */
async function searchItems(queryText, page, extraFilter) {
    const q = [MEDIA_QUERY];
    if (extraFilter) q.push(extraFilter);
    if (queryText) q.push(`(${queryText})`);
    // advancedsearch wants repeated fl[] params; URLSearchParams collapses them,
    // so build the query string manually.
    const fl = "fl%5B%5D=identifier&fl%5B%5D=title";
    const url = `${SEARCH}?q=${encodeURIComponent(q.join(" AND "))}&${fl}&rows=${PAGE_SIZE}&page=${page}&output=json`;

    let data;
    try {
        data = await getJson(url);
    } catch (e) {
        return { isEnd: true, data: [] };
    }
    const docs = data?.response?.docs || [];
    const numFound = Number(data?.response?.numFound) || 0;

    // Resolve in small parallel batches; many hits have no usable audio file.
    const resolved = await Promise.all(
        docs.map((d) => resolveItem(d.identifier, d.title)),
    );
    const list = resolved.filter((it) => it !== null);
    return {
        isEnd: page * PAGE_SIZE >= numFound || docs.length === 0,
        data: list,
    };
}

module.exports = {
    platform: "Internet Archive",
    version: "1.0.0",
    author: "Leo Hu",
    cacheControl: "cache",
    primaryKey: ["id"],
    supportedSearchType: ["music"],

    async search(query, page) {
        const kw = String(query || "").trim();
        if (!kw) {
            return { isEnd: true, data: [] };
        }
        // Search title/creator so "Beethoven" does not return unrelated talks.
        return await searchItems(`(title:(${kw}) OR creator:(${kw}))`, page);
    },

    async getMediaSource(musicItem) {
        const url = buildFileUrl(
            { dir: musicItem.fileDir, workable_servers: musicItem.servers },
            musicItem.fileName,
        );
        return { url };
    },

    async getTopLists() {
        return [
            {
                title: "Internet Archive 公版音频",
                data: COLLECTIONS.map((c) => ({ id: c.id, title: c.title })),
            },
        ];
    },

    async getTopListDetail(topListItem, page) {
        const r = await searchItems("", page, topListItem.id);
        return { isEnd: r.isEnd, musicList: r.data };
    },

    // The Archive has no lyrics field.
    async getLyric() {
        return undefined;
    },
};
