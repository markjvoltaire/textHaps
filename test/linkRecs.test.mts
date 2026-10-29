// Run: npx tsx test/linkRecs.test.mts. Pure parsing only; nothing leaves the machine.
import assert from "node:assert/strict";

globalThis.fetch = (async (input: any) => {
  throw new Error(`unexpected network call to ${typeof input === "string" ? input : input.url}`);
}) as typeof fetch;

const { bareName, cdnUrl, cleanLinkRead, isPostLink, isThin, streetOf } = await import("../src/recs/postRecs.ts");

let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n  ${err instanceof Error ? err.message : String(err)}`);
  }
}

const place = (fields: Record<string, unknown> = {}) => ({
  name: "Felix Trattoria",
  kind: "place",
  category: "Italian Restaurant",
  neighborhood: "Venice",
  why: "A warm, dimly lit trattoria with handmade pasta.",
  best_for: ["date night"],
  ...fields,
});

await test("keeps every field, lowercases the category", () => {
  const read = cleanLinkRead({ kind: "list", summary: "Her date night list.", recs: [place({ vibe: "cozy", price: "$$$", city: "Los Angeles" })] });
  assert.equal(read.kind, "list");
  assert.equal(read.recs.length, 1);
  const [rec] = read.recs;
  assert.equal(rec!.category, "italian restaurant");
  assert.equal(rec!.vibe, "cozy");
  assert.equal(rec!.city, "Los Angeles");
  assert.equal(rec!.music, null);
  assert.deepEqual(rec!.best_for, ["date night"]);
});

await test("strips links and caps lengths, since it's read off a stranger's post", () => {
  const read = cleanLinkRead({
    kind: "list",
    recs: [place({ name: "Felix https://evil.example/x", why: `Great pasta, visit evil.com/win. ${"x".repeat(900)}`, best_for: ["dancing", "go to https://evil.example", 3, "a", "b", "c", "d"] })],
  });
  const text = JSON.stringify(read);
  assert.doesNotMatch(text, /evil/);
  assert.ok(read.recs[0]!.why.length <= 600);
  assert.equal(read.recs[0]!.best_for.length, 5);
});

await test("drops vague or empty ones and repeats of the same spot", () => {
  const read = cleanLinkRead({
    kind: "list",
    recs: [place(), place({ name: "felix trattoria!" }), place({ name: "ab" }), place({ why: "" }), { name: "Gjelina" }, "junk", null],
  });
  assert.deepEqual(read.recs.map((rec) => rec.name), ["Felix Trattoria"]);
});

await test("an event keeps a clean start; a bad date is dropped", () => {
  const read = cleanLinkRead({
    kind: "list",
    recs: [place({ name: "Sunset Rave", kind: "event", starts_at: "2026-11-07T22:00:00-08:00" }), place({ name: "Other Party", kind: "event", starts_at: "next friday" })],
  });
  assert.equal(read.recs[0]!.kind, "event");
  assert.equal(read.recs[0]!.starts_at, "2026-11-07T22:00:00-08:00");
  assert.equal(read.recs[1]!.starts_at, null);
});

await test("garbage in is an empty read, not a crash", () => {
  assert.deepEqual(cleanLinkRead(null), { kind: "other", summary: null, recs: [] });
  assert.deepEqual(cleanLinkRead({ recs: "nope" }).recs, []);
});

await test("thin means a short why or a missing neighborhood, vibe, or address", () => {
  const [full] = cleanLinkRead({ recs: [place({ why: "x".repeat(150), vibe: "cozy", address: "1 Main St" })] }).recs;
  assert.equal(isThin(full!), false);
  assert.equal(isThin({ ...full!, why: "A Westside staple." }), true);
  assert.equal(isThin({ ...full!, address: null }), true);
  assert.equal(isThin({ ...full!, vibe: null }), true);
});

await test("post links: Instagram posts and reels, TikTok videos, slideshows, and share links", () => {
  for (const url of [
    "https://www.instagram.com/reels/De9ys9VyzDE/",
    "https://www.instagram.com/p/DfDno5jDweE/?img_index=4",
    "https://www.tiktok.com/@mrbeast/video/7654638524729216287",
    "https://www.tiktok.com/@foodbyfranchi/photo/7479916555602513174?lang=en",
    "https://vm.tiktok.com/ZMabc123/",
    "https://www.tiktok.com/t/ZTabc123/",
  ]) {
    assert.ok(isPostLink(url), url);
  }
  for (const url of ["https://www.tiktok.com/@mrbeast", "https://www.instagram.com/someone/", "https://tiktok.com.evil.example/@a/video/1", "https://partiful.com/e/abc"]) {
    assert.ok(!isPostLink(url), url);
  }
});

await test("media only downloads from Instagram's and TikTok's CDNs over https", () => {
  assert.ok(cdnUrl("https://v16.tokcdn.com/abc/7654638524729216287_original.mp4"));
  assert.ok(cdnUrl("https://p16-common-sign.tiktokcdn-us.com/x.webp"));
  assert.ok(cdnUrl("https://scontent-lax7-1.cdninstagram.com/v.mp4"));
  for (const url of ["http://v16.tokcdn.com/a.mp4", "https://tokcdn.com.evil.example/a.mp4", "https://evil.example/v.mp4", "file:///etc/passwd"]) {
    assert.ok(!cdnUrl(url), url);
  }
});

await test("a name with its area tacked on is the bare name, but a name that is the area stays", () => {
  assert.equal(bareName("Baadmaash Venice", ["Venice", "Los Angeles"]), "Baadmaash");
  assert.equal(bareName("Baadmaash (Venice)", ["Venice"]), "Baadmaash");
  assert.equal(bareName("Felix - Venice", ["Venice"]), "Felix");
  assert.equal(bareName("Komodo Miami", [null, "Miami"]), "Komodo");
  assert.equal(bareName("Venice Beach Bar", ["Venice"]), "Venice Beach Bar");
  assert.equal(bareName("Venice", ["Venice"]), "Venice");
  assert.equal(bareName("Gjelina", ["Venice"]), "Gjelina");
  assert.equal(bareName("The Room (L.A.)", ["L.A."]), "The Room");
  // Gemini's answer is cleaned the same way.
  const read = cleanLinkRead({ recs: [{ name: "Baadmaash Venice", kind: "place", category: "restaurant", neighborhood: "Venice", city: "Los Angeles", why: "Indian small plates." }] });
  assert.equal(read.recs[0]!.name, "Baadmaash");
});

await test("one street address however it's written", () => {
  assert.equal(streetOf("1616 Abbot Kinney Blvd., Venice, CA 90291"), streetOf("1616 abbot kinney boulevard"));
  assert.equal(streetOf("945 N. Fairfax Ave, West Hollywood"), streetOf("945 N Fairfax Avenue"));
  assert.notEqual(streetOf("1616 Abbot Kinney Blvd"), streetOf("1305 Abbot Kinney Blvd"));
});

console.log(`${10 - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
