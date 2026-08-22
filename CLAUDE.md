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

### Not every device is a breaker

`role: "feedThrough"` is a bus tap — Panel B 6/8 is a Leviton LFTLA plug-on
feed-through lug. It occupies two breaker positions and has **no handle, no
ampacity and no overcurrent protection**. Rules the validator enforces:
`amps` must be `null`, no `circuits`, no `shedIn`, and `feeds` must name an
entry in `subpanels[]` that points back at it.

Everything it feeds lives in that subpanel object, not in `circuits`, because
the disconnect is in a *different enclosure* and burying the loads on the tap
would hide that. The handwritten card labelled these slots "Furn", which reads
as a handle you can throw during an outage. There is no handle. The app draws
the cell dashed with "NO HANDLE", the printed card prints
`NOTHING TO SWITCH — FEEDS …`, and both are asserted in tests.

### Subpanels

`subpanels[]` holds everything downstream of such a tap. The rule that matters:
**watts live on `appliances`, never on the subpanel's `devices`.** The HVAC
subpanel has three 50A 2-pole breakers feeding *one* 20 kW Bryant KFCEH3301C20
heat kit — roughly 6,667 W per circuit. Summing per breaker would put 60 kW on
the meter. `estimatedWattsTotal` must equal the appliance sum, and the
validator rejects any `estimatedWatts` on a subpanel breaker.

`loadSummary()` adds subpanel load to the parent panel **and to `remaining`
unconditionally**, reporting it as `unsheddableWatts`. It survives every shed
list by construction, so "shed more" is the wrong instruction — "you cannot
shed this from here, the disconnect is at the air handler" is the right one.
The UI, the load meter and the door card all say that.

`monitoring.smartBreakerMonitorable: false` records the other consequence:
loads reaching a subpanel through a lug never pass a Panel B branch breaker,
so no LWHEM smart breaker can ever meter them. A CT pair on the feeder is the
only instrumentation path.

### Fields with non-obvious rules

| Field | Rule |
|---|---|
| `poles` | Must equal `slots.length`. Validated. |
| `slots` (2-pole) | Two same-parity slots two apart — odd = left column, even = right. `[1,2]` is physically impossible and is a validation error. |
| `role` | Only `branch` is a load. `generatorInlet` is the backup feed: excluded from search and all load math, drawn green in the grid. `feedThrough` is a bus tap with no handle — see above. |
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

It is currently honest and alarming: after the Panel A shed list, ~11.2 kW of
connected load remains against the Anker's 3.8 kW output (~10.7 kW in
truck-away, which sheds more). That is expected for a whole-panel transfer and
is exactly why the shed list matters.

Panel B is worse and for a different reason: ~22.8 kW against a **7.2 kW**
ceiling, of which 20 kW is the HVAC heat kit behind the feed-through tap and
**cannot be shed at the panel at all**. The Panel B ceiling is the 30A/240V
outdoor receptacle, not the truck — 7.2 kW, not the F-150's 9.6 kW. The plan is
to lock electric heat out at the Bryant Evolution Connex control
(SYSTXBBECC01-B) and run heat-pump-only, which is why B-10-12 (the 5-ton
outdoor unit) is deliberately **not** on the shed list.

**The figure can also read LOW, which is the dangerous direction.** An installed
breaker with no circuits traced contributes 0 W. `loadSummary()` returns
`untracedDevices` / `untracedAmps` and the meter says "Reads LOW: N breakers still
on…" so the gap is visible. Only B-10-12 (the 40A heat pump outdoor unit) is
still in that state — and it is the one thing the outage plan intends to *run*,
so its figure matters — and as of 2026-08-22 it is metered, so a real number can
replace it. Panel A remains fully traced and its meter carries no warning.

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

## State of the data (as of 2026-08-22)

Honest inventory, because the app's credibility depends on it:

- **22 of the 32 devices are now Leviton 2nd-gen smart breakers** (18 of Panel
  A's 22, 4 in Panel B), retrofitted 2026-08-22. Their `hardware.catalogNumber`
  is the model string the breaker itself reports through the LWHEM-2 cloud, and
  the part it replaced is kept in `replacedCatalogNumber`. Note the suffix is
  **`-0ST`**, not the `-ST` this file used to predict. Those records carry no
  `photoVerified` — deliberately: nobody has photographed the new bodies, but
  the hardware's own report is not weaker evidence than a photo, so they must
  not be badged unverified either. All 22 agreed with the amps and poles already
  recorded here, which is the strongest cross-check this data has had.
- **`monitoring.meteredBy` is the join to the energycap pipeline.** It names the
  hub id, the physical position and the `channel_id` (`breaker_p{position}`) the
  measurements land under. That pipeline inherits label, panel, slots and watts
  from THIS file, so a label fixed here reaches every query; `levitonLabel`
  records what the breaker calls itself in the Leviton app, which is worth
  seeing when it disagrees but is never authoritative.
- **B-10-12 is metered at last.** The 5-ton heat pump was the only device left
  contributing 0 W to the load meter's "reads LOW" warning, and it is exactly
  the thing the Panel B outage plan intends to run. A measured figure can
  replace the 0 W after a few days of heating and cooling — not from one
  sample, because a variable-speed unit at part capacity looks nothing like its
  peak. B-26 likewise now measures the Anker charge rate that is a 1,000 W
  placeholder.
- **Each panel's energy monitor sits on its own 2-pole dumb breaker**, and both
  are DO NOT SHED: A-27-29 for Panel A, B-17-19 (15 A, owner-confirmed) for
  Panel B. The reason is not the obvious one — switching one off de-energises
  nothing, because smart breakers are ordinary mechanical breakers, but it takes
  out all metering, the app and remote control for that panel. It also means the
  one load in the house that can never appear in the data is the metering system
  itself: the monitor's supply comes through a dumb breaker. B-17-19 also
  settles Panel B's slot count — 17/19 were recorded as verified empty from a
  photo and are not.
- **A-27-29 was NOT the Siemens SPD**, despite an earlier owner identification;
  Leviton's own "Smart Home" label for it was right. Panel A's surge protection
  is now a plug-on **Leviton LSPD1-T at 22/24**, and the external Siemens unit
  is gone from Panel A. Panel B keeps its Siemens SPD at 28/30.
- **The LSPD1-T is a COMBINATION device, and modelling it as a bare SPD is
  wrong.** Leviton's spec: "two 15A single-pole standard thermal magnetic
  circuit breakers" plus a Type 1 SPD (25 kA surge, 10 kA SCCR) in one plug-on
  body. So A-22 and A-24 keep their identities, their ten circuits and their
  ~770 W exactly as before — one body, but they switch and trip independently,
  which is what the panel reader needs, so they stay two devices. Their
  `hardware` records are identical and both say so; pulling the unit takes both
  circuits and the surge protection at once.
- **Switching those two breakers off does not disable surge protection.** The
  spec is explicit that the SPD is fed line-side and "surge protection
  continues, even if the breaker is off, or tripped" — a real improvement on the
  external Siemens unit, which sat behind its own breaker. So they can be shed
  like any other circuit.
- **A-22 and A-24 are the only Panel A branch circuits that can never report
  usage.** There is no smart variant of the LSPD1-T, so metering them means
  giving up the panel's surge protection or finding it two more slots, and Panel
  A has none free. Recorded in `monitoring` on both; the other 18 devices all
  report.
- **Panel A** is photo-verified for hardware and every breaker now has an
  identity. 19/21 is the water heater, 23/25 the mud-room mini-split (Pioneer
  12k), 27/29 the energy monitor's supply (**not** the SPD — corrected
  2026-08-22), 22/24 the Leviton LSPD1-T SPD. The MWBCs at 5/7, 10/12 and 13/15 are **confirmed**
  shared-neutral pairs, not 240V loads. What's left is that 5/7 and 10/12 each
  have a second leg (slots 5 and 12) with no endpoints recorded. No untraced
  capacity remains, so the Panel A meter no longer reads low.
- **Panel B** is photo-reconciled (16 occupied, 14 empty), but its inlet has
  never been photographed. Slots 6/8 are a feed-through lug, not a breaker, and
  the 20 kW behind it is the panel's dominant load. Only 10/12 (the heat pump)
  still has no load figure. **Fewer than 14 slots are actually available** — 5/7
  face the lug and the 2/0 feeder conductors probably make that pair unusable,
  which is also the likely reason the directory card lists a phantom oven there.
- **The orange tape means "shut this off in an outage."** Confirmed by the
  owner, recorded per device in `physicalMarkingMeaning`, and true of all three
  taped breakers (1/3 dryer, 10/12 kitchen + dishwasher, 19/21 water heater).
  `test/e2e.js` asserts the tape and `shedIn` cannot drift apart — if they do,
  the physical panel and the app give different instructions.
- **A surge protector carries an explicit 0 W circuit**, not an empty one, so it
  reads as "nothing to trace" rather than inflating the untraced-capacity
  warning. Empty `circuits` means nobody looked; 0 W means there is nothing to
  find.
- **The Anker charges from Panel B (slot 26) but backs up Panel A.** That is why
  B-26 is deliberately not shed: when the truck is on Panel B, that plug is the
  no-extra-cable way to recharge the Anker mid-outage.
- **Both inlets are MALE flanged inlets** (Reliance Controls PBN30 per the
  owner), connected with an ordinary L14-30 extension cord. This killed the
  male-to-male worry — the photo had been misread. The key is
  `generatorInlet.connection`, deliberately *not* `receptacle`, because calling
  a male inlet a receptacle is what caused the misreading. The cord is described
  once in top-level `cables{}` and referenced by `generatorInlet.cable`.
  `validate.js` warns if any inlet gender is missing, unverified, or female.
- **High-severity open questions** worth resolving before a real transfer: which
  HVAC subpanel circuit feeds the blower (until that is known, do **not** switch
  all three off — the heat pump needs the blower), and whether the unfused 2/0
  aluminum tap satisfies the NEC 10-ft tap rule (needs a measured run length and
  raceway status — **no code conclusion is recorded, and none should be quoted
  from this file**). Both are in `openQuestions`.
- `images/panel-b/step1-unplug-anker.jpg` is a stray copy from the old repo — it
  matches no step and is not cached. Delete or rename it once you know what it is.
- Only 1 of 14 walkthrough photos exists. The rest render a placeholder; the
  validator warns per missing file.
