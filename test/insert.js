#!/usr/bin/env node
/* insert.js — checks the generated panel door inserts.
 * Run: node test/insert.js   (also part of npm test)
 *
 * The insert is the one output nobody can fix in the field. It gets printed,
 * slid into a panel door, and read months later by whoever is standing there.
 * These checks guard the properties that make it trustworthy:
 *
 *   - every slot appears exactly once, in the right column
 *   - a 2-pole handle is ONE cell, never two independent-looking entries
 *   - the generator inlet is marked and never appears in a shed list
 *   - panel-specific warnings only appear on their own panel's card
 *   - nothing is silently clipped
 *   - it survives a black-and-white printer
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var execFileSync = require('child_process').execFileSync;
var JSDOM = require('jsdom').JSDOM;
var Model = require('../src/model.js');

var ROOT = path.join(__dirname, '..');
var DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/montfort.json'), 'utf8'));

var failures = [];
var checks = 0;

function check(name, actual, expected) {
  checks++;
  var ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  if (!ok) {
    failures.push(name + ' — got ' + JSON.stringify(actual) +
      (typeof expected === 'function' ? '' : ', expected ' + JSON.stringify(expected)));
  }
}

/* ---- generate into a throwaway directory so we never read a stale dist/ ---- */

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blackstart-insert-'));
var stdout;
try {
  stdout = execFileSync(process.execPath,
    [path.join(ROOT, 'scripts/make-insert.js'), '--out', tmp],
    { cwd: ROOT, encoding: 'utf8' });
} catch (e) {
  console.log('FAIL  make-insert.js exited non-zero:\n' + (e.stdout || '') + (e.stderr || ''));
  process.exit(1);
}

check('generator reports no clipped labels', /label\(s\) are wider/.test(stdout), false);

var docs = {};
Object.keys(DATA.panels).forEach(function (p) {
  var f = path.join(tmp, 'insert-panel-' + p.toLowerCase() + '.html');
  check('panel ' + p + ' insert was written', fs.existsSync(f), true);
  if (fs.existsSync(f)) {
    var raw = fs.readFileSync(f, 'utf8');
    docs[p] = { raw: raw, doc: new JSDOM(raw).window.document };
  }
});

/* -------------------------------------------------------------- per panel */

Object.keys(docs).forEach(function (p) {
  var doc = docs[p].doc;
  var raw = docs[p].raw;
  var panel = DATA.panels[p];
  var devices = Model.devicesIn(DATA, p);
  var w = 'panel ' + p + ': ';

  var rows = doc.querySelectorAll('table.dir tbody tr');
  check(w + 'one row per slot pair', rows.length, panel.slots / 2);

  /* Every slot number appears exactly once, and odd numbers sit in the left
   * number column while even sit in the right — same as the physical panel. */
  var nums = [];
  var misplaced = 0;
  [].forEach.call(rows, function (tr) {
    var ncells = [].filter.call(tr.children, function (c) {
      return c.classList.contains('n');
    });
    if (ncells.length !== 2) { misplaced++; return; }
    var left = Number(ncells[0].textContent);
    var right = Number(ncells[1].textContent);
    if (left % 2 !== 1 || right % 2 !== 0 || right !== left + 1) misplaced++;
    nums.push(left, right);
  });
  check(w + 'every row has a left-odd / right-even number pair', misplaced, 0);
  check(w + 'all slot numbers present exactly once', nums.length, panel.slots);
  check(w + 'slot numbers are 1..' + panel.slots,
    nums.slice().sort(function (a, b) { return a - b; }).join(','),
    Array.apply(null, { length: panel.slots })
      .map(function (_, i) { return i + 1; }).join(','));

  /* A 2-pole handle must be a single merged cell. Two separate cells would
   * read as two independent breakers, which is the paper version of the bug
   * that hid circuits in the app. */
  var twoPole = devices.filter(function (d) { return d.poles === 2; });
  var spans = doc.querySelectorAll('table.dir td.c[rowspan="2"]');
  check(w + 'one merged cell per 2-pole handle', spans.length, twoPole.length);

  var descCells = doc.querySelectorAll('table.dir td.c');
  check(w + 'description cells = slots minus merged rows',
    descCells.length, panel.slots - twoPole.length);

  /* Every device is printed once — no slot duplicated, none dropped. Counted
   * per distinct label text, because two devices may legitimately share one
   * (both "Unidentified" breakers; their slot numbers and amps disambiguate). */
  var labels = [].map.call(doc.querySelectorAll('table.dir .lbl'), function (e) {
    return e.textContent;
  });
  check(w + 'one printed label per device', labels.length, devices.length);
  var wanted = {};
  devices.forEach(function (d) {
    var t = d.shortLabel || d.label;
    wanted[t] = (wanted[t] || 0) + 1;
  });
  Object.keys(wanted).forEach(function (t) {
    var n = labels.filter(function (l) { return l === t; }).length;
    check(w + 'label "' + t + '" printed ' + wanted[t] + 'x', n, wanted[t]);
  });

  /* The inlet must be visually distinct and must never be listed as something
   * to switch off. Getting this wrong is the whole reason the card exists. */
  var inlets = devices.filter(function (d) { return d.role === Model.ROLE_INLET; });
  check(w + 'inlet cell is marked', doc.querySelectorAll('td.inlet').length, inlets.length);
  if (inlets.length) {
    check(w + 'inlet carries a BACKUP FEED tag',
      /BACKUP FEED/.test(doc.querySelector('td.inlet').textContent), true);
    var shedText = [].map.call(doc.querySelectorAll('.shed-l li'), function (e) {
      return e.textContent;
    }).join(' | ');
    inlets.forEach(function (d) {
      check(w + 'inlet ' + d.id + ' is absent from every shed list',
        shedText.indexOf(d.shortLabel || d.label) >= 0, false);
    });
    check(w + 'inlet cell has no shed marker',
      doc.querySelector('td.inlet').querySelectorAll('b.off').length, 0);
  }

  /* Declared-empty vs unaccounted must stay distinguishable on paper too. */
  var declared = (panel.emptySlots || []).length;
  check(w + 'declared-empty slots say "empty"',
    [].filter.call(doc.querySelectorAll('td.blank'), function (c) {
      return c.textContent.trim() === 'empty';
    }).length, declared);
  var survey = Model.surveyStatus(DATA, p);
  check(w + 'unaccounted slots say "not surveyed"',
    [].filter.call(doc.querySelectorAll('td.blank'), function (c) {
      return c.textContent.trim() === 'not surveyed';
    }).length, survey.unaccounted);

  /* Panel-scoped safety warnings. */
  (DATA.safetyWarnings || []).forEach(function (sw) {
    if (sw.severity !== 'critical') return;
    var applies = !sw.panels || sw.panels.indexOf(p) >= 0;
    check(w + "warning '" + sw.id + "' " + (applies ? 'present' : 'absent'),
      raw.indexOf(sw.message) >= 0, applies);
  });

  /* The legend must only advertise scenarios this panel takes part in. */
  var legend = doc.querySelector('.legend').textContent;
  Object.keys(DATA.scenarios).forEach(function (k) {
    var sc = DATA.scenarios[k];
    var name = sc.shortName || sc.name;
    check(w + "legend mentions '" + name + "' only if applicable",
      legend.indexOf(name) >= 0, Model.panelAvailable(DATA, k, p));
  });

  /* Shed lists must match what the model derives from devices[].shedIn. */
  Object.keys(DATA.scenarios).forEach(function (k) {
    if (!Model.panelAvailable(DATA, k, p)) return;
    var shed = Model.shedDevices(DATA, k, p);
    var block = [].filter.call(doc.querySelectorAll('.shed'), function (s) {
      return s.querySelector('.shed-h').textContent
        .indexOf(DATA.scenarios[k].shortName || DATA.scenarios[k].name) >= 0;
    })[0];
    check(w + k + ' shed block exists', !!block, true);
    if (block) {
      check(w + k + ' shed block lists every shed device',
        block.querySelectorAll('.shed-l li').length, shed.length);
    }
  });

  /* Provenance: a card with no date can't be identified as stale. */
  check(w + 'card is stamped with the data date',
    raw.indexOf(DATA.metadata.lastUpdated) >= 0, true);

  /* Two pages: directory, then procedure for the reverse. */
  check(w + 'two cards (front and back)', doc.querySelectorAll('section.card').length, 2);
  check(w + 'procedure lists every walkthrough step',
    doc.querySelectorAll('ol.proc li').length,
    (DATA.walkthroughSteps['panel' + p] || []).length);
});

/* --------------------------------------------------------- grayscale-safe */

/* This gets printed on whatever printer is nearby. If any fact were carried by
 * hue alone it would vanish in black and white, so every colour in the sheet
 * must be achromatic (R, G and B within a few points of each other). */
var anyRaw = docs[Object.keys(docs)[0]].raw;
var hexes = anyRaw.match(/#[0-9a-fA-F]{3,6}\b/g) || [];
var chromatic = hexes.filter(function (h) {
  var v = h.slice(1);
  if (v.length === 3) v = v[0] + v[0] + v[1] + v[1] + v[2] + v[2];
  if (v.length !== 6) return false;
  var r = parseInt(v.slice(0, 2), 16);
  var g = parseInt(v.slice(2, 4), 16);
  var b = parseInt(v.slice(4, 6), 16);
  return Math.max(r, g, b) - Math.min(r, g, b) > 8;
});
check('every colour is achromatic (survives a B&W printer)', chromatic, function (c) {
  return c.length === 0;
});
check('found colours to check', hexes.length, function (n) { return n > 5; });

/* ------------------------------------------------------------------ report */

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}

if (failures.length) {
  failures.forEach(function (f) { console.log('FAIL  ' + f); });
  console.log('');
  console.log(checks + ' checks, ' + failures.length + ' failed');
  process.exit(1);
}
console.log(checks + ' checks, all passed');
process.exit(0);
