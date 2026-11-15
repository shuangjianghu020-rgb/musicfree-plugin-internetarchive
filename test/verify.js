// Live verification for the Internet Archive plugin.
const plugin = require("../plugin.js");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? " :: " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " :: " + detail : ""}`); }
}

async function probeBytes(url) {
  const res = await fetch(url);
  const ct = res.headers.get("content-type") || "";
  const reader = res.body.getReader();
  const { value } = await reader.read();
  try { await reader.cancel(); } catch (e) {}
  const head = value ? Buffer.from(value) : Buffer.alloc(0);
  const magic =
    head.slice(0, 3).toString() === "ID3" ||
    head.slice(0, 4).toString() === "fLaC" ||
    head.slice(0, 4).toString() === "OggS" ||
    (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
  return { status: res.status, ct, len: Number(res.headers.get("content-length") || 0), magic, url };
}

(async () => {
  console.log("[1] metadata");
  check("platform", plugin.platform === "Internet Archive", plugin.platform);

  console.log("\n[2] getTopLists");
  const tops = await plugin.getTopLists();
  check("collections", tops.length > 0 && tops[0].data.length > 0, `${tops[0].data.length} collections`);
  tops[0].data.forEach(t => console.log(`      ${t.title}`));

  console.log("\n[3] getTopListDetail - resolve items with real audio");
  const first = tops[0].data[0];
  const d = await plugin.getTopListDetail(first, 1);
  check("returns items", d.musicList.length > 0, `${d.musicList.length} playable of 20 searched`);
  const it = d.musicList[0];
  if (it) {
    check("id", !!it.id, it.id);
    check("title", !!it.title, String(it.title).slice(0, 45));
    check("artist", !!it.artist, String(it.artist).slice(0, 35));
    check("artwork", !!it.artwork, it.artwork.slice(0, 55));
    check("fileName stashed", !!it.fileName, String(it.fileName).slice(0, 40));
    check("servers stashed", Array.isArray(it.servers), `${it.servers.length} servers`);
  }

  console.log("\n[4] getMediaSource -> real audio bytes");
  let ok = 0, tried = 0;
  for (const m of d.musicList.slice(0, 6)) {
    const src = await plugin.getMediaSource(m);
    const b = await probeBytes(src.url);
    tried++;
    const good = b.status === 200 && b.magic;
    if (good) { ok++; console.log(`  PASS  ${String(m.title).slice(0,28)} :: ${b.ct} ${(b.len/1048576).toFixed(2)}MB`); }
    else { console.log(`  ..    ${m.id.slice(0,30)} -> ${b.status} ct=${b.ct} magic=${b.magic}`); }
  }
  check("majority playable", ok >= Math.ceil(tried / 2), `${ok}/${tried}`);

  console.log("\n[5] search");
  const s = await plugin.search("Beethoven", 1);
  check("returns items", s.data.length > 0, `${s.data.length} items`);
  if (s.data[0]) {
    console.log(`      first: ${String(s.data[0].title).slice(0, 50)} / ${String(s.data[0].artist).slice(0, 30)}`);
    const src = await plugin.getMediaSource(s.data[0]);
    const b = await probeBytes(src.url);
    check("search hit streams", b.status === 200 && b.magic, `${b.ct} magic=${b.magic}`);
  }
  const empty = await plugin.search("", 1);
  check("empty query returns empty", empty.data.length === 0);

  console.log("\n[6] getLyric graceful");
  check("undefined", (await plugin.getLyric()) === undefined);

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
