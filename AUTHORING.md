# Authoring home data

Everything Blackstart shows comes from one JSON file in `data/`. This is the
reference for that file. `schema/home.schema.json` is the shape; this document is
the *why*, and `scripts/validate.js` is what actually enforces the rules.

After **any** edit:

```bash
npm run validate     # or npm test to also boot the app
```

Then bump `CACHE` in `sw.js` so installed phones pick up the change, and update
`metadata.lastUpdated`.

---

## The one concept you need

**One entry in `devices` per physical breaker.** Not per circuit. Not per slot.

A 2-pole breaker is a single device with two slots, because it has one handle and
trips as a unit. If you turn it off, *everything* on both slots goes dark. Recording
it as two separate things is how the old version ended up hiding the basement
refrigerator from the panel view.

```
Physical reality                    →  Data
────────────────────────────────────────────────────────────────
One 15A breaker on slot 11             one device, slots: [11], poles: 1
One 15A 2-pole handle on slots 13+15   one device, slots: [13,15], poles: 2
Five outlets fed by slot 11            five entries in that device's circuits[]
```

### Slot numbering

Odd slots are the **left** column, even slots the **right** — same as the physical
panel. So a 2-pole breaker occupies two slots of the same parity, two apart:
`[13,15]` (left) or `[10,12]` (right). `[1,2]` would be one slot in each column,
which no breaker can do, and the validator rejects it.

---

## Adding a breaker

```json
{
  "id": "A-11",
  "panel": "A",
  "slots": [11],
  "poles": 1,
  "amps": 15,
  "role": "branch",
  "label": "Mud room + basement lights & plugs",
  "labelSource": "authored",
  "circuitType": "120V branch",
  "physicalMarking": null,
  "priority": null,
  "shedIn": [],
  "hardware": { "manufacturer": "Leviton", "catalogNumber": "LB115-T", "photoVerified": true },
  "circuits": [
    { "room": "Mud Room", "endpoint": "Floor plugs", "estimatedWatts": 100, "fedFromSlot": 11 }
  ],
  "notes": [],
  "estimatedWattsTotal": 100
}
```

### Field by field

| Field | Notes |
|---|---|
| `id` | `<panel>-<slots joined by ->`: `A-11`, `A-13-15`. Stable — `openQuestions` and the UI reference it. Changing an id is a rename everywhere. |
| `panel` | Must be a key in `panels`. |
| `slots` | Array, always. A single-pole breaker is `[11]`, not `11`. |
| `poles` | Must equal `slots.length`. |
| `amps` | The number on the handle. Use `null` — not `0`, and not a guess — if you genuinely cannot read it. The key must still be there. A null-amps device drops out of all load math and the validator warns. |
| `role` | `branch` for a load. `generatorInlet` for the backup feed — those are excluded from search and load math and drawn green in the grid. |
| `label` | **What the reader sees in the app.** Write it for a stressed non-technical person. "Kitchen fridge + counter, floor & microwave plugs" beats "Kitchen". Keep it short enough to fit a breaker tile. |
| `shortLabel` | Optional compact form for the **printed door insert**, where a cell is ~32 characters. Falls back to `label`. `npm run insert` tells you exactly which labels overflow. |
| `labelSource` | Provenance. Use `authored` once a human wrote it. `placeholder` and `auto-generated…` make the validator warn and the app show a "needs rewriting" callout. |
| `circuitType` | Free text: `120V branch`, `240V appliance`, `probable MWBC (two 120V legs, shared neutral)`. Displayed, not computed on. |
| `physicalMarking` | Anything written on or stuck to the breaker: `"orange tape"`. **Searchable** — people do search for this. |
| `priority` | `"critical"` or `null`. Marks the breaker red. Circuits can set it independently. |
| `shedIn` | Array of scenario keys where this breaker gets turned off. See below. |
| `hardware` | Optional. `photoVerified: false` makes the app badge it as unverified. |
| `circuits` | What it feeds. An **empty array means "breaker present, loads unknown"** — rendered differently from an empty slot, and it makes the panel's load figure read low (the meter says so). |
| `notes` | **An array of strings** on a device. |
| `estimatedWattsTotal` | Must equal the sum of the circuits' `estimatedWatts`. The validator will tell you the right number. |

### Circuits

```json
{ "room": "Unfinished Basement", "endpoint": "Ejector Pump", "estimatedWatts": 500,
  "fedFromSlot": 7, "priority": "critical", "notes": "Also has freezer plugged in" }
```

- `room` — the **canonical** name. `roomAliases` handles display, so keep using
  "Second Bedroom on Left" here even though the app shows "Office".
- `estimatedWatts` — a rough steady-draw estimate. Nobody measured these. They
  exist so the load meter can rank what is worth shedding.
- `fedFromSlot` — which of *this device's* slots feeds it. A plain number for one
  leg of a multi-wire circuit, an array for a true 240V load spanning both.
  Validated against the device's own slots.
- `notes` — **a string** here (an array on the device). Yes, that is inconsistent;
  it is what the data already used and `noteList()` normalizes both.
- `verified` / `verificationMethod` — whether you actually confirmed this at the
  panel. `true` shows "Confirmed — breaker walk-through" in the app. `false` badges
  the row **Unconfirmed** and the modal says "treat as a guess". Leaving the field
  off is a third state meaning nobody recorded provenance, and the validator warns
  about it. Prefer an explicit `false` over silence.

---

## Shed lists

`shedIn` on the device is the **single source of truth**. There is no per-scenario
shed list to keep in sync — scenarios derive theirs, and the walkthrough builds
its "turn these off" tags from it.

```json
"shedIn": ["truckHome", "truckAway"]
```

Read as: "turn this breaker off in both scenarios." Set it while you are looking at
the breaker, which is when you actually know.

A step picks it up automatically:

```json
{ "step": 2, "title": "Turn Off High-Draw Breakers",
  "instruction": "At Panel A, turn OFF these breakers:",
  "breakersToTurnOff": "scenario-dependent" }
```

`scenario-dependent` resolves to every device in that panel whose `shedIn`
contains the active scenario. You can also pass an explicit array of device ids,
but prefer `shedIn`.

---

## Scenarios

```json
"truckAway": {
  "name": "Conservation Mode",
  "shortName": "Truck Away",
  "description": "Truck is away - Anker only (Panel A)",
  "panelsAvailable": ["A"],
  "notes": "Only 3.8 kWh available. Prioritize refrigerators, sump pump, internet."
}
```

`panelsAvailable` drives which walkthrough sections appear. A panel left out is
hidden entirely. Capacity shown on the scenario button is summed from the
available panels' backup sources — not stored, so it cannot drift.

---

## Declaring empty slots

```json
"emptySlots": [5, 7, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 29]
```

Slots you have **looked at and confirmed hold no breaker**. This is not
bookkeeping — it is what lets the app distinguish two very different claims:

| State | How it renders | Means |
|---|---|---|
| A device claims the slot | the breaker tile | occupied |
| Listed in `emptySlots` | "Empty" | verified absent |
| Neither | "Not surveyed" | nobody looked |

A panel counts as fully surveyed when `occupied + emptySlots == slots`. That is
computed, never stored, so it cannot go stale. The validator warns about every
slot that is neither, and errors if you declare a slot empty while a device
occupies it.

## Endpoints with no known breaker

```json
"unassignedEndpoints": [
  { "room": "Outside Driveway", "endpoint": "Electrical plug", "notes": "Not traced." }
]
```

Things you know exist but haven't traced. **These show up in search** as rows
reading "Breaker unknown", and tapping one explains how to trace it. Leaving them
out would be worse than useless: someone searching "driveway" would get no result
and conclude the outlet isn't on this panel.

Once you trace one, move it into that device's `circuits` and delete it here.

## Recording what you don't know

This matters more than completeness. A confident wrong answer at a breaker panel
is worse than an admitted gap.

- **`hardware.photoVerified: false`** — badges the breaker in the UI.
- **`confidence: "unverified" | "low" | "medium" | "high"`** — on panels, main
  breakers, receptacles.
- **`emptySlots`** — see above. Omitting a slot is how you say "not surveyed".
- **`openQuestions`** — contradictions and unknowns, with `deviceIds` linking them
  to breakers so the grid can badge them with a `!`:

```json
{
  "id": "A-23-25-ac",
  "deviceIds": ["A-23-25", "A-19-21"],
  "recorded": "40A 2-pole, Mud Room Air Conditioner, 3500W",
  "observed": "20A 2-pole",
  "severity": "high",
  "resolution": "VERIFY BEFORE RELYING ON THIS. A 3500W condenser would not run on a 20A 2-pole."
}
```

`severity` is `high` / `medium` / `low` / `info` and controls ordering and colour.

---

## Safety warnings

```json
{ "id": "main-off-first", "title": "Main Breaker First",
  "message": "Always turn OFF the main breaker BEFORE engaging the generator inlet breaker.",
  "severity": "critical", "showInWalkthrough": true }
```

`showInWalkthrough: true` renders it at the top of the guide. `critical` is red,
`warning` amber. These are not decorative — put the real electrical hazards here.

Add `"panels": ["A"]` to scope a warning to one panel; **omit the field entirely**
for warnings that apply everywhere. This matters for the printed inserts, which are
per-panel: the Anker trickle-charge instruction has no business on the Panel B card.

---

## Walkthrough steps

```json
{ "step": 4, "title": "Connect Anker to Panel",
  "instruction": "Connect the Anker F3800+ output cable to the generator inlet…",
  "warning": "Optional. Renders in red.",
  "image": "images/panel-a/step4-connect-anker.jpg",
  "icon": "connect" }
```

`icon` names come from the `ICONS` map in `src/app.js`: `unplug`, `breaker-off`,
`breaker-on`, `main-off`, `connect`, `power-on`, `verify`, `truck`, `battery`,
`charging`. An unknown name degrades to no icon.

### Photos

Drop them in `images/panel-a/` or `images/panel-b/` and reference the path.
A missing file renders a visible placeholder and the validator warns — nothing
breaks. **If you add a photo you must also add it to `ASSETS` in `sw.js`**, or it
won't be there when the power is out, which is the only time it is needed.

Take them in landscape, well lit, and consider drawing a circle or arrow on the
breaker in question. Full resolution is fine; CSS handles the thumbnail.

---

## Printing the door inserts

```bash
npm run insert                                  # both panels -> dist/
node scripts/make-insert.js --panel A
node scripts/make-insert.js --width 6in --height 8.5in
```

**Measure your panel door first.** The default trim is 6.5in × 9in, which is a
guess; the dashed outline in the output is the cut line.

Print at **100% scale with margins set to None**, or the crop marks are wrong.
Each panel produces two pages — directory, then outage procedure — so duplex on
cardstock gives you a two-sided card.

The script reports any label too wide for a cell, with the device id, so you can
add a `shortLabel`. It also reports slots that are neither occupied nor declared
empty, and the card itself prints "NOT SURVEYED" in the footer if any remain — a
half-known panel should look half-known.

Everything on the card comes from the data: the directory, the shed lists (from
`shedIn`), the step order (from `walkthroughSteps`), the critical warnings, and the
`metadata.lastUpdated` stamp. Reprint after any data change rather than annotating
by hand — a marked-up card is how the old directory cards drifted.

---

## Adding a second house

The app loads one file, named at the top of `src/app.js`:

```js
var DATA_URL = 'data/montfort.json';
```

To fork this for your own panel: add `data/<yourhouse>.json`, point `DATA_URL` at
it, add it to `ASSETS` in `sw.js`, bump `CACHE`, update `CNAME` to your domain,
and run `npm run validate`. Nothing else in the app is house-specific.

---

## What the validator checks

Errors (CI fails):

- `schemaVersion` matches what the app expects
- Required top-level keys and required device fields
- Unique device ids; no slot claimed by two devices
- `poles` equals `slots.length`; slots within the panel's range
- 2-pole slots same-parity and adjacent
- `estimatedWattsTotal` equals the sum of its circuits
- `fedFromSlot` inside the device's own slots
- `amps` present (may be `null`); `verified` boolean if present
- No slot both occupied and declared empty; `emptySlots` within range
- `unassignedEndpoints` entries have a room and endpoint and no panel/slot
- `shedIn` and `panelsAvailable` reference real scenarios and panels
- `openQuestions.deviceIds` and `generatorInlet.deviceId` resolve
- A `generatorInlet` has no circuits and no `shedIn`
- Every `sw.js` `ASSETS` path exists, and every `src/*.js` and `data/*.json` is listed

Warnings (informational):

- Placeholder or auto-generated labels
- Circuits with `verified: false`, or with no `verified` flag at all
- Breakers installed with no circuits traced (they count as 0 W)
- Devices with `amps: null`
- Slots neither occupied nor declared empty
- Endpoints in `unassignedEndpoints`
- Missing step photos
- Missing generated icons
- Room aliases matching no room in use
- A scenario whose remaining connected load exceeds its source's output
