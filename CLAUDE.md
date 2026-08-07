# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Blackstart — Home Outage Guide.** A reference for bringing a house up on backup
power during an outage: which breaker controls what, what to shed, and the exact
step order for a manual transfer.

"Blackstart" is the grid-operations term for restarting a power system with no
external electricity. That is literally the job.

**Who it is for.** The primary reader is a non-technical household member,
standing at a breaker panel, in the dark, under stress, possibly without the
person who built this. Every design decision follows from that:

- **Offline-first is the whole point.** An outage usually takes the router with
  it and congests the cell network. A reference you have to download during the
  emergency is not a reference.
- **Say what is unknown.** This data was reconstructed from photos and memory of
  a 1974 house. Guesses are labelled as guesses (`confidence`, `photoVerified`,
  `openQuestions`) and the UI badges them. Silently presenting an unverified
  breaker as fact is the worst thing this app could do.
- **Plain language over precision.** `label` is what the reader sees. It should
  read like a person wrote it, not like a panel schedule.

Deployed at **https://blackstart.ericpullen.com** via GitHub Pages.

## Commands

```bash
npm install        # once — installs the single dev dependency (jsdom)
npm run validate   # node scripts/validate.js — data + offline asset list (CI runs this)
npm test           # validate + test/e2e.js (jsdom smoke test of the real app)
npm run insert     # node scripts/make-insert.js — printable panel door cards -> dist/
npm run icons      # regenerate PNG icons from assets/icon.svg (needs rsvg-convert)
npm start          # python3 -m http.server 8000 → http://localhost:8000
```

- **Always serve over HTTP.** Opening `index.html` from `file://` fails — the app
  loads its data with `fetch()`, which `file://` blocks. The app shows an explicit
  error saying so rather than rendering blank.
- There is no linter, formatter, bundler or compile step, and there should not be.
- No single-test runner. `validate.js` checks all data; `test/e2e.js` is one script.

## Deployment

GitHub Pages serves `main` directly. Two files make that work:

- **`CNAME`** — `blackstart.ericpullen.com`. Do not delete it; Pages resets the
  custom domain if it disappears.
- **`.nojekyll`** — stops Jekyll from processing the site.

**HTTPS is not optional.** Service workers require a secure context, so without
HTTPS there is no offline support at all. Pages provisions a Let's Encrypt cert
automatically; "Enforce HTTPS" must stay on in repo settings. (The predecessor to
this app was on an S3 website endpoint, which is HTTP-only, so its service worker
had never once registered.)

Generated PNGs in `assets/` **must be committed**. Pages serves the repo
contents, so a gitignored file is a 404.

## Architecture

Plain static site. Vanilla JS, no framework, no modules, no bundler. Two scripts
load in order from `index.html` and attach one global each.

```
index.html    shell + all CSS (inline) + the four views' markup
src/model.js  → window.Model — the data layer. NO DOM ACCESS.
src/app.js    → IIFE, owns all rendering and events
data/*.json   one file per house
```

### Why `model.js` has no DOM access

`scripts/validate.js` does `require('../src/model.js')` and runs the same
functions the browser runs. So the validator checks real behaviour — its load
math, shed lists and slot indexing are the app's, not a reimplementation. Keep
every electrical calculation in `model.js` and keep it DOM-free, or that breaks.

### Views

Four `.view` divs toggled by an `active` class (`showView`). No router.
`home-view`, `search-view`, `panels-view`, `walkthrough-view`.

### Rendering rules — both of these are load-bearing

1. **Never interpolate data into an inline event handler attribute.** The
   predecessor serialized a circuit object into `onclick='...'`; a room alias
   containing an apostrophe ("Jordan's Room") terminated the attribute and broke
   the handler silently. All events are delegated through one listener in
   `wire()` and elements are addressed with `data-device` / `data-circuit`.
   `test/e2e.js` asserts no `onclick=` appears in rendered output.
2. **Everything user-visible goes through `esc()`** on the way into `innerHTML`.

## The data model (this is the important part)

**One entry in `devices` per PHYSICAL BREAKER**, not per circuit and not per slot.
A 2-pole breaker is *one* device with two `slots`, because it has one handle and
trips as a unit. Circuits nest underneath.

```json
{
  "id": "A-13-15", "panel": "A", "slots": [13, 15], "poles": 2, "amps": 15,
  "role": "branch", "label": "Bedrooms + office (internet) + full bath",
  "shedIn": [], "estimatedWattsTotal": 700,
  "circuits": [ { "room": "Master Bedroom", "endpoint": "Light",
                  "estimatedWatts": 60, "fedFromSlot": 13 } ]
}
```

This shape exists because the previous schema split `breakers` (120V) and
`doubleBreakers` (240V) and **double-counted shared slots**. Slots 5/7, 10/12 and
13/15 are multi-wire branch circuits — two 120V legs under one common-trip 2-pole
handle — so they appeared in both arrays. The panel renderer suppressed the 120V
entries, which meant the basement refrigerator, the ejector pump, the dishwasher
and the office/internet circuit were **invisible in the panel grid** while still
showing up in search. The two views disagreed about what the panel contained.

**Anything that reasons about "what happens when I flip this" must reason in
devices, never in slots.**

### Fields with non-obvious rules

| Field | Rule |
|---|---|
| `poles` | Must equal `slots.length`. Validated. |
| `slots` (2-pole) | Two same-parity slots two apart — odd = left column, even = right. `[1,2]` is physically impossible and is a validation error. |
| `role` | Only `branch` is a load. `generatorInlet` is the backup feed: excluded from search and all load math, drawn green in the grid. |
| `shedIn` | **The single source of truth for shed lists.** Scenarios derive theirs from it. There is deliberately no `scenarios.shedDevices` — the old file had both plus pre-rendered labels, three copies of one fact. |
| `estimatedWattsTotal` | Must equal the sum of its circuits' `estimatedWatts`. Validated. |
| `fedFromSlot` | Number for one leg of an MWBC, array for a true 240V load. Must be one of the device's own slots. Validated. |
| `notes` | **Array** on a device, **string** on a circuit. `noteList()` in `app.js` normalizes. |
| `labelSource` | `placeholder` or `auto-generated…` makes the validator warn and the UI show a "needs rewriting" callout. |
| `emptySlots` | Slots **verified** to hold no breaker. Anything neither occupied nor listed here renders "Not surveyed", because a slot nobody looked at is not the same claim as an absent breaker. "Fully surveyed" is derived (`occupied + empty == slots`), never stored, so it cannot drift. |
| `amps` | May be `null` for an installed device whose rating can't be read (B-6-8). The key must still be present so the omission is deliberate. A null-amps device is absent from all load math — the validator warns. |
| `circuits[].verified` | Whether the circuit was actually confirmed at the panel. `false` badges it "Unconfirmed" in search and "treat as a guess" in the modal. Absent ≠ false: absent means provenance was never recorded. |
| `unassignedEndpoints` | Endpoints known to exist with no breaker identified. **These appear in search** as "Breaker unknown" rows. Omitting them would imply the outlet doesn't exist; the honest answer is "we don't know yet". |
| `shortLabel` | Compact form for the printed door insert (~32 char cell). Falls back to `label`. Optional, but 14 of the app labels overflow without it. |
| `safetyWarnings[].panels` | Scopes a warning to specific panels; omit for "everywhere". Without it the Panel B card carried the Anker trickle-charge instruction, which is a Panel A device. |

### The load meter is a planning tool, not a measurement

`Model.loadSummary()` sums **connected** load — what is wired to each breaker —
and compares it to the source's `maxOutputWatts`. Nothing here measures anything
and it does not predict simultaneous draw. The UI says so explicitly; keep that
caveat if you touch the wording.

It is currently honest and alarming: after the Panel A shed list, ~10.7 kW of
connected load remains against the Anker's 3.8 kW output. That is expected for a
whole-panel transfer and is exactly why the shed list matters.

**The figure can also read LOW, which is the dangerous direction.** An installed
breaker with no circuits traced contributes 0 W. `loadSummary()` returns
`untracedDevices` / `untracedAmps` and the meter says "Reads LOW: N breakers still
on…" so the gap is visible. Panel B is the live example — B-6-8 (unidentified,
directory says "Furn"), B-10-12 (40A A/C) and B-28-30 (20A surge) have no loads
recorded, so **the Panel B number is not currently trustworthy.** The Panel A
number is sound.

`capacityKwh` (stored energy, how *long*) and `maxOutputWatts` (output ceiling,
how *much at once*) are different things. The meter uses watts. There is no
runtime estimate because that would need a duty-cycle assumption we don't have.

## The printed door insert

`scripts/make-insert.js` generates a card per panel into `dist/` (gitignored —
it is a print artifact, not part of the site). Two pages each: the directory for
the front, the outage procedure for the reverse. Print at 100% with margins set
to None; card trim defaults to 6.5in × 9in, override with `--width` / `--height`.

This exists because the handwritten cards in both panels are stale and contradict
the JSON (`directory-cards-stale`). Regenerating from the data is what keeps the
card in the door and the app telling the same story.

Constraints that are not cosmetic:

- **Grayscale-safe.** It gets printed on whatever printer is nearby, so no fact is
  carried by hue. Critical is bold + `●`, shed is a boxed scenario letter, the
  inlet is inverted, untraced is italic + `—`. `test/insert.js` asserts every
  colour in the sheet is achromatic.
- **One cell per handle.** A 2-pole breaker is a single `rowspan="2"` cell.
  Printing it as two rows would be the paper version of the bug that hid circuits
  in the app — it would read as two independent breakers.
- **The inlet is never in a shed list** and carries a `BACKUP FEED` tag. Tested.
- **Nothing is silently clipped.** Labels wider than the cell are reported on
  stdout with the device ids so you can add a `shortLabel`; the CSS ellipsis is a
  backstop, not the plan.
- **Every card is stamped with `metadata.lastUpdated`**, so a stale card in a door
  can be identified as stale.

## The offline contract

`sw.js` is cache-first with an explicit asset list. Three rules:

1. **Bump `CACHE`** (`blackstart-v1` → `v2`) on every deploy. Otherwise an
   installed app never refetches anything.
2. **Add every new file to `ASSETS`.** Unlisted means unavailable offline.
3. **Every listed path must exist.** `cache.addAll()` rejects atomically, so one
   bad path means the worker never installs and you lose *all* offline support.
   `validate.js` enforces this — it already caught exactly this bug once.

`data/*.json` is network-first (you edit it often) with a cache fallback.
Everything else is cache-first.

`install.html` explains Add to Home Screen. Worth knowing: Safari purges cached
data for ordinary bookmarked sites after ~7 days of no visits, but **home-screen
web apps are exempt**. Installing is what makes the offline copy durable, not
just convenient — which is why that page exists and links from the home view.

**No web fonts.** The system font stack only. The predecessor pulled Plus Jakarta
Sans and JetBrains Mono from Google Fonts, which is a network dependency in an
app whose entire purpose is working without one.

## Conventions

- Modern JS is fine (arrows, template literals, spread). This intentionally
  differs from the sibling `permitpal` repo, which mandates ES5 — no reason to
  churn working code backward, and every browser that can install a PWA has
  supported ES6 for years.
- `model.js` uses a UMD wrapper so Node and the browser share it. Keep it.
- All CSS is inline in `index.html`. Blackstart additions are in a clearly
  marked block at the end of the `<style>`.
- `viewport-fit=cover` in the viewport meta is **required** — without it every
  `env(safe-area-inset-*)` in the CSS resolves to `0px` and the bottom nav sits
  under the home indicator in standalone mode.

## When you touch data or src, also

- Run `npm test`.
- Bump `CACHE` in `sw.js`.
- Add any new file to `sw.js` `ASSETS`.
- Update `metadata.lastUpdated` in the data file — the home view shows it so a
  reader knows how fresh their offline copy is.

## State of the data (as of 2026-08-07)

Honest inventory, because the app's credibility depends on it:

- **Panel A** is photo-verified for hardware. Four 2-pole breakers still have no
  circuits traced: 19/21 (30A), 23/25 (20A), 27/29 (20A), and 5/7 has one leg only.
- **Panel B has never been photographed.** Seven devices carried forward from
  notes; 23 of 30 slots unaccounted for; main breaker, inlet slots, interlock
  type and receptacle configuration all unknown. `slotsSurveyed: false`.
- **Two high-severity open questions** worth resolving before a real transfer:
  the AC recorded at 3500 W sits on a 20A 2-pole that could not carry it, and the
  Panel A inlet appears to be a *female* L14-30 receptacle, which would imply a
  male-to-male cord. Both are in `openQuestions` and badged in the UI.
- `images/panel-b/step1-unplug-anker.jpg` is a stray copy from the old repo — it
  matches no step and is not cached. Delete or rename it once you know what it is.
- Only 1 of 14 walkthrough photos exists. The rest render a placeholder; the
  validator warns per missing file.
