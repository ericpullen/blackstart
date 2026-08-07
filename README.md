# Blackstart — Home Outage Guide

An offline-first web app for bringing a house up on backup power during an outage:
which breaker controls what, what to turn off first, and the exact step order for a
manual transfer.

**[blackstart.ericpullen.com](https://blackstart.ericpullen.com)**

*Blackstart* is the grid-operations term for restarting a power system with no
external electricity. That is the job.

## Why it exists

The person who needs this information is usually not the person who wrote it down.
They are standing at a breaker panel, in the dark, possibly alone, and the router is
down along with everything else.

So the app is built around three constraints:

- **It works with no power, no Wi-Fi and no signal.** Install it once and the whole
  thing — panel schedule, photos, walkthrough — lives on the device. Nothing is
  fetched from a CDN, not even fonts.
- **It admits what it doesn't know.** The data was reconstructed from photos of a
  1974 house. Unverified breakers are badged, contradictions are listed as open
  questions, and unsurveyed slots say "not surveyed" rather than "empty".
- **It reads like a person wrote it.** Breaker labels are plain language, not panel
  schedule shorthand.

## Features

**Search** — every outlet, light and appliance, by room, device, breaker number, or
the orange tape stuck on the handle. Filter by panel or by critical loads.

**Panel view** — the real layout, odd slots left and even right, with 2-pole
breakers shown as the single handle they actually are. Critical loads in red, the
generator inlet in green, disputed breakers badged.

**Walkthrough** — step-by-step transfer for each panel, with a tap-to-complete
checklist, the safety warnings up front, and a shed list that changes with the
scenario ("truck home" vs "truck away").

**Load check** — after shedding, how much connected load remains versus what the
backup source can actually deliver. A planning number, not a measurement, and the
app says so. It also warns when the number reads *low* because some breakers have
no loads traced.

**Printable door inserts** — `npm run insert` generates a panel directory card per
panel, plus the outage procedure for the reverse side. Generated from the same JSON,
so the card taped in the door can't drift from the app. Designed to stay readable in
black and white, because the phone in your hand may be dead.

## Running it locally

```bash
npm install     # one dev dependency (jsdom), for the test only
npm start       # → http://localhost:8000
```

Serve it over HTTP. Opening `index.html` from `file://` will not work — the app
loads its data with `fetch()`.

```bash
npm run validate   # check the data and the offline asset list
npm test           # validate + boot the app in jsdom + check the print output
npm run insert     # generate the printable panel door cards into dist/
```

## How it's built

Plain static HTML, CSS and JavaScript. No framework, no bundler, no build step.

```
index.html      shell, all CSS, the four views
src/model.js    data layer — shared verbatim with the Node validator
src/app.js      rendering and events
data/*.json     one file per house
sw.js           offline cache
scripts/        validate.js — the only safety net, run by CI
                make-insert.js — printable panel door cards
schema/         JSON Schema shape reference
test/           e2e.js (app, jsdom) + insert.js (print output)
```

`src/model.js` deliberately touches no DOM, so `scripts/validate.js` can `require`
it and check the real logic the browser runs rather than a reimplementation of it.

## Making it yours

The app is MIT licensed and reads a single data file. To point it at your own panel:

1. Add `data/<yourhouse>.json` — see **[AUTHORING.md](AUTHORING.md)** for the format
2. Change `DATA_URL` at the top of `src/app.js`
3. Add your file to `ASSETS` in `sw.js` and bump `CACHE`
4. Put your own domain in `CNAME` (or delete it and use `<user>.github.io/blackstart`)
5. `npm run validate`

Enable GitHub Pages on `main` with "Enforce HTTPS" on. HTTPS is not optional —
service workers refuse to register without it, and without a service worker there is
no offline support at all.

Nothing else in the app is specific to one house.

## Documentation

- **[AUTHORING.md](AUTHORING.md)** — the data format, field by field, and how to
  record what you haven't verified yet
- **[CLAUDE.md](CLAUDE.md)** — architecture, design rationale, and the constraints
  that are load-bearing

## A note on scope

This is a reference for a manual transfer setup that already exists. It does not
control anything, measure anything, or connect to anything. It will not tell you
whether your wiring is safe.

Interlocks, inlets and transfer equipment are the parts of this where being wrong
hurts someone. Get those inspected by an electrician.

## License

MIT. See [LICENSE](LICENSE).
