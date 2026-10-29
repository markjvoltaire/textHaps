// Run: npx tsx test/placeLink.test.mts. Pure function, no network.
import assert from "node:assert/strict";
import { placeLinkFor } from "../src/agent/placeLink.ts";

const r = (url: string, title: string) => ({ url, title, published: null, highlights: [] });

// The real find_places results for "sable wynwood" (the exa.ai page is blanked by find_places).
const SABLE = [
  r("https://www.sablemiami.com/", "Sable"),
  r("https://www.sablemiami.com/visit", "Visit — Sable"),
  r("https://www.sablemiami.com/vinyllounge", "VINYL LOUNGE — Sable"),
  r("https://www.timeout.com/miami/nightlife/sable", "Sable | Nightlife in Wynwood, Miami"),
];
const BARCELONA = [
  r("https://www.yelp.com/biz/barcelona-wynwood-miami", "Barcelona Wynwood - Miami - Yelp"),
  r("https://barcelonawynwood.com/menu", "Menu | Barcelona Wynwood"),
  r("https://barcelonawynwood.com/", "Barcelona Wynwood | Spanish Tapas & Wine Bar"),
  r("https://www.instagram.com/barcelonawynwood/", "Barcelona Wynwood (@barcelonawynwood)"),
];

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n  ${err instanceof Error ? err.message : String(err)}`);
  }
}

test("one place: picks its own homepage, not Time Out", () => {
  const reply = "sable is a cafe by day and a vinyl lounge at night, lowkey a good fit for calm\ndaytime is the move";
  assert.equal(placeLinkFor(reply, SABLE), "https://www.sablemiami.com/");
});

test("steering away from a place still gets its card", () => {
  const reply = "barcelona in wynwood is a wine bar tho, and you said no wine lol\nit's a spanish tapas spot with a pretty courtyard";
  assert.equal(placeLinkFor(reply, BARCELONA), "https://barcelonawynwood.com/");
});

test("a second place with no site in the results doesn't block the card", () => {
  const reply = "barcelona gets loud at happy hour\nnovela cafe social is the better fit for calm";
  assert.equal(placeLinkFor(reply, BARCELONA), "https://barcelonawynwood.com/");
});

test("domain alone names the place (title is generic)", () => {
  const reply = "barcelona gets loud at happy hour";
  assert.equal(placeLinkFor(reply, [r("https://barcelonawynwood.com/", "Home")]), "https://barcelonawynwood.com/");
});

test("two places with their own sites: no card", () => {
  const reply = "sable is calm in the day\nbarcelona is livelier at night";
  assert.equal(placeLinkFor(reply, [...SABLE, ...BARCELONA]), null);
});

test("reply that names no result: no card", () => {
  assert.equal(placeLinkFor("try a rooftop in brickell tonight", SABLE), null);
});

test("only review and social sites: no card", () => {
  const reply = "barcelona wynwood is a tapas spot";
  assert.equal(placeLinkFor(reply, [BARCELONA[0]!, BARCELONA[3]!]), null);
});

test("name inside another word doesn't count (\"is able\" isn't sable)", () => {
  assert.equal(placeLinkFor("this spot is able to fit a big group", SABLE), null);
});

test("short generic title pieces don't match", () => {
  assert.equal(placeLinkFor("check the menu and visit soon", [r("https://somewhere.com/menu", "Menu | Visit")]), null);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
