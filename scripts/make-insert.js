#!/usr/bin/env node
/* make-insert.js — generates printable panel door inserts from the home data.
 *
 *   node scripts/make-insert.js                    # all panels -> dist/
 *   node scripts/make-insert.js --panel A
 *   node scripts/make-insert.js --width 6in --height 8.5in
 *   node scripts/make-insert.js --data data/montfort.json --out dist
 *
 * Then open the HTML and print it. Chrome/Safari: set margins to None and
 * scale to 100%, or the crop marks lie to you.
 *
 * WHY THIS EXISTS
 * The handwritten directory cards in both panels are stale and contradict the
 * JSON (see the `directory-cards-stale` open question). This regenerates them
 * from the single source of truth, so the card in the door and the app agree.
 *
 * DESIGN CONSTRAINTS, all of which come from "someone reads this at the panel
 * with a flashlight during an outage":
 *
 *  - GRAYSCALE-SAFE. A door card gets printed on whatever printer is around.
 *    No fact is carried by colour alone; every marker is a glyph, a border or
 *    a weight change.
 *  - ONE ROW PER SLOT, ONE CELL PER HANDLE. A 2-pole breaker spans its two
 *    rows as a single merged cell, because that is what it physically is. The
 *    app had a bug where 2-pole breakers hid their circuits; the paper version
 *    of that bug would be listing one handle as two independent breakers.
 *  - THE INLET IS UNMISTAKABLE. Inverted, tagged, and excluded from every shed
 *    list. Switching it off at the wrong moment is the failure this guards.
 *  - UNVERIFIED DATA IS MARKED. Paper cannot show the app's badges and never
 *    updates itself, so anything unconfirmed carries a visible mark and the
 *    card is stamped with the data date.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var Model = require('../src/model.js');

var ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------ options */

function parseArgs(argv) {
  var o = { panel: 'all', out: 'dist', data: 'data/montfort.json',
            width: '6.5in', height: '9in', maxLabel: 32 };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--panel') o.panel = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--data') o.data = argv[++i];
    else if (a === '--width') o.width = argv[++i];
    else if (a === '--height') o.height = argv[++i];
    else if (a === '--max-label') o.maxLabel = Number(argv[++i]);
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { console.error('unknown option: ' + a); usage(); process.exit(1); }
  }
  return o;
}

function usage() {
  console.log('usage: node scripts/make-insert.js [--panel A|B|all] [--out dir]');
  console.log('       [--data file] [--width 6.5in] [--height 9in] [--max-label 32]');
}

/* ------------------------------------------------------------------ helpers */

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* The card gets shortLabel when present — app labels are written for a phone
 * screen and overflow a directory cell. Never silently truncate: a clipped
 * label on a panel door is worse than a short one, so overflow is reported. */
function cardLabel(device) {
  return device.shortLabel || device.label;
}

function amps(device) {
  return (device.amps === null || device.amps === undefined) ? '?' : device.amps + 'A';
}

/* --------------------------------------------------------------- the markers */

/* Every marker is a glyph so it survives a black-and-white printer. */
var MARK = {
  critical: '●',   /* ● keep this on if you can */
  unconfirmed: '?',     /* data not confirmed at the panel */
  untraced: '—',   /* — installed, nothing traced */
  feedThrough: '⇥' /* ⇥ no handle: a tap feeding another enclosure */
};

/* One-letter tags for the shed columns. Derived from the last word of each
 * scenario name ("Truck Home" -> H), but two scenarios can easily collide on a
 * letter, so fall back to numbers for the whole set rather than print two
 * different scenarios under the same mark. */
function scenarioTags(data) {
  var keys = Object.keys(data.scenarios || {});
  var tags = {};
  var seen = {};
  var collision = false;

  keys.forEach(function (k) {
    var sc = data.scenarios[k] || {};
    var name = String(sc.shortName || sc.name || k);
    var parts = name.split(/\s+/);
    var t = (parts[parts.length - 1] || name).charAt(0).toUpperCase();
    if (seen[t]) collision = true;
    seen[t] = true;
    tags[k] = t;
  });

  if (collision) keys.forEach(function (k, i) { tags[k] = String(i + 1); });
  return tags;
}

/* ------------------------------------------------------------------- render */

function renderCard(data, panelKey, opt, report) {
  var panel = data.panels[panelKey];
  var idx = Model.index(data);
  var slots = idx.slots[panelKey] || {};
  var src = data.backupSources[panel.backupSource] || {};
  var survey = Model.surveyStatus(data, panelKey);
  var scenarioKeys = Object.keys(data.scenarios || {});
  var mb = panel.mainBreaker || {};
  var tags = scenarioTags(data);

  /* Scenarios this panel actually participates in. The legend and the shed
   * blocks must both use this list, or the card advertises a marker that can
   * never appear on it. */
  var panelScenarios = scenarioKeys.filter(function (k) {
    return Model.panelAvailable(data, k, panelKey);
  });

  /* ---- directory rows: 2 columns, odd left / even right, like the panel ---- */
  var rows = '';
  var spanned = Object.create(null); /* slot -> already covered by a rowspan */

  for (var slot = 1; slot <= panel.slots; slot += 2) {
    rows += '<tr>';
    rows += slotNum(slot);
    rows += slotCell(slot);
    rows += slotCell(slot + 1);
    rows += slotNum(slot + 1);
    rows += '</tr>';
  }

  function slotNum(n) {
    return '<td class="n">' + n + '</td>';
  }

  function slotCell(n) {
    if (spanned[n]) return '';

    var entry = slots[n];
    if (!entry) {
      var declared = (panel.emptySlots || []).indexOf(n) >= 0;
      return '<td class="c blank">' + (declared ? 'empty' : 'not surveyed') + '</td>';
    }

    var d = entry.device;
    /* Merge the two rows of a 2-pole handle into one cell. */
    var span = 1;
    if (d.poles === 2 && entry.primary) {
      span = 2;
      spanned[d.slots[1]] = true;
    } else if (!entry.primary) {
      return ''; /* covered by the rowspan above */
    }

    var feedThrough = Model.isFeedThrough(d);
    var sub = feedThrough ? Model.subpanelOfDevice(data, d) : null;

    var cls = ['c'];
    if (d.role === Model.ROLE_INLET) cls.push('inlet');
    if (feedThrough) cls.push('tap');
    if (d.priority === 'critical') cls.push('crit');
    var untraced = Model.isLoad(d) && (!d.circuits || !d.circuits.length);
    if (untraced) cls.push('untraced');

    var marks = [];
    if (d.priority === 'critical') marks.push(MARK.critical);
    if (untraced) marks.push(MARK.untraced);
    if (feedThrough) marks.push(MARK.feedThrough);
    if (hasUnconfirmed(d)) marks.push(MARK.unconfirmed);

    var sheds = panelScenarios.filter(function (k) {
      return (d.shedIn || []).indexOf(k) >= 0;
    }).map(function (k) {
      return '<b class="off">' + esc(tags[k]) + '</b>';
    }).join('');

    var label = cardLabel(d);
    if (label.length > opt.maxLabel) {
      report.overflow.push({ id: d.id, len: label.length, label: label });
    }

    return '<td class="' + cls.join(' ') + '"' + (span > 1 ? ' rowspan="2"' : '') + '>' +
      '<span class="lbl">' + esc(label) + '</span>' +
      '<span class="meta">' + esc(feedThrough ? 'NO HANDLE' : amps(d)) +
      (d.poles === 2 && !feedThrough ? ' 2P' : '') +
      (marks.length ? ' ' + marks.join('') : '') +
      '</span>' +
      (sheds ? '<span class="offs">' + sheds + '</span>' : '') +
      (d.role === Model.ROLE_INLET ? '<span class="tagline">BACKUP FEED</span>' : '') +
      (feedThrough
        ? '<span class="tagline">NOTHING TO SWITCH &mdash; FEEDS ' +
          esc((sub ? (sub.shortName || sub.name) : 'A SUBPANEL').toUpperCase()) + '</span>'
        : '') +
      '</td>';
  }

  function hasUnconfirmed(d) {
    if (Model.isUnverified(d)) return true;
    return (d.circuits || []).some(function (c) { return c.verified === false; });
  }

  /* ---- shed lists, derived from devices[].shedIn ---- */
  var shedBlocks = panelScenarios.map(function (k) {
    var sc = data.scenarios[k];
    var shed = Model.shedDevices(data, k, panelKey);
    var sum = Model.loadSummary(data, panelKey, k);
    return '<div class="shed">' +
      '<div class="shed-h"><b class="off">' + esc(tags[k]) + '</b> ' +
      esc(sc.shortName || sc.name) + '</div>' +
      (shed.length
        ? '<ol class="shed-l">' + shed.map(function (d) {
          return '<li><span class="sn">' + esc(Model.slotLabel(d)) + '</span> ' +
            esc(cardLabel(d)) + ' <i>' + esc(amps(d)) + '</i></li>';
        }).join('') + '</ol>'
        : '<p class="none">Nothing to turn off.</p>') +
      '<p class="budget">' + esc(fmtW(sum.remainingWatts)) + ' left connected vs ' +
      esc(fmtW(sum.sourceWatts)) + ' available' +
      (sum.over ? ' &mdash; OVER by ' + esc(fmtW(sum.overBy)) : '') +
      (sum.unsheddableWatts
        ? '. ' + esc(fmtW(sum.unsheddableWatts)) + ' of that is behind a feed-through tap ' +
          'and cannot be switched off here.'
        : '') +
      (sum.untracedDevices.length
        ? (sum.unsheddableWatts ? ' ' : '. ') + 'Reads low: ' + sum.untracedDevices.length +
          ' breaker(s) untraced.'
        : (sum.unsheddableWatts ? '' : '.')) +
      '</p>' +
      '</div>';
  }).join('');

  /* ---- what this panel CANNOT switch off ---- */

  /* A breaker sweep of this panel does not reach these loads. Printing them
   * beside the shed list is the only way the card stops implying it does. */
  var subBlocks = Model.subpanelsFedFrom(data, panelKey).map(function (sp) {
    return '<div class="shed tap-block">' +
      '<div class="shed-h">' + MARK.feedThrough + ' ' + esc(sp.name) + ' &mdash; ' +
      esc(fmtW(sp.estimatedWattsTotal)) + '</div>' +
      '<p class="tap-where"><b>Fed through ' + esc((sp.fedFrom || {}).deviceId || '?') +
      ', which has no handle.</b> Nothing in ' + esc(panel.name) +
      ' disconnects it. The only disconnect is inside the subpanel: ' +
      esc(sp.location) + '.</p>' +
      /* Deliberately NOT the .shed-l ordered list. A numbered list under a
       * shed heading reads as "do these in order"; these are the handles you
       * must NOT throw as a set. Different thing, different shape. */
      ((sp.devices || []).length
        ? '<p class="tap-where">Inside it: ' + sp.devices.map(function (d) {
          return esc((d.amps ? d.amps + 'A' : '?') + ' ' + d.label);
        }).join(' &middot; ') + '</p>'
        : '') +
      ((sp.notes || []).length
        ? '<p class="tap-dont">' + esc(sp.notes[sp.notes.length - 1]) + '</p>'
        : '') +
      '</div>';
  }).join('');

  /* ---- procedure summary, straight from the walkthrough ---- */
  var wkey = 'panel' + panelKey;
  var steps = (data.walkthroughSteps || {})[wkey] || [];
  var procedure = steps.map(function (s) {
    return '<li>' + esc(s.title) + '</li>';
  }).join('');

  /* A warning with no `panels` applies everywhere; one that names panels only
   * belongs on those cards. Without this the Panel B card carried the Anker
   * trickle-charge instruction, which is a Panel A device. */
  var warnings = (data.safetyWarnings || [])
    .filter(function (w) {
      if (w.severity !== 'critical') return false;
      return !w.panels || w.panels.indexOf(panelKey) >= 0;
    })
    .map(function (w) { return '<li>' + esc(w.message) + '</li>'; }).join('');

  var stamp = (data.metadata || {}).lastUpdated || 'unknown';

  return {
    html: page(data, panelKey, panel, src, mb, survey, rows, shedBlocks, subBlocks,
               procedure, warnings, stamp, panelScenarios, tags, opt),
    survey: survey
  };
}

/* Which end of the cord goes where. Cheap to print and it is the one thing a
 * person is actually holding when they read the back of this card. */
function connectionNote(data, panel) {
  var inlet = panel.generatorInlet || {};
  var c = inlet.connection;
  if (!c) return '';
  var cable = (data.cables || {})[inlet.cable];

  return '<div class="conn">' +
    '<b>Inlet:</b> ' +
    [c.configuration, c.deviceType].filter(Boolean).map(esc).join(' &mdash; ') +
    (c.location ? '<br><b>Where:</b> ' + esc(c.location) : '') +
    (cable ? '<br><b>Cord:</b> ' + esc(cable.howItConnects || cable.ends) : '') +
    '</div>';
}

function fmtW(n) {
  if (!n) return '0 W';
  return n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + ' kW' : n + ' W';
}

function page(data, key, panel, src, mb, survey, rows, shedBlocks, subBlocks,
              procedure, warnings, stamp, panelScenarios, tags, opt) {
  var legend = [
    MARK.critical + ' critical &mdash; keep powered',
    MARK.untraced + ' installed, nothing traced',
    MARK.unconfirmed + ' not confirmed at the panel'
  ].concat(subBlocks ? [MARK.feedThrough + ' no handle &mdash; feeds another enclosure'] : [])
    .concat(panelScenarios.map(function (k) {
    var sc = data.scenarios[k];
    return '<b class="off">' + esc(tags[k]) + '</b> turn off in ' +
      esc(sc.shortName || sc.name);
  })).join(' &nbsp;&middot;&nbsp; ');

  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8">' +
    '<title>' + esc(panel.name) + ' insert &mdash; ' + esc(data.home.name) + '</title>' +
    '<style>' + css(opt) + '</style></head><body>' +

    /* ---- FRONT: the directory ---- */
    '<section class="card">' +
      '<header>' +
        '<div class="title">' +
          '<h1>' + esc(panel.name) + '</h1>' +
          '<p>' + esc(data.home.name) + '</p>' +
        '</div>' +
        '<div class="src">' +
          '<p><b>MAIN ' + esc(mb.amps ? mb.amps + 'A' : '?') + '</b></p>' +
          '<p>' + esc(src.name || 'no backup source') + '</p>' +
          '<p>' + esc(src.capacityKwh ? src.capacityKwh + ' kWh / ' + fmtW(src.maxOutputWatts) + ' max' : '') + '</p>' +
        '</div>' +
      '</header>' +

      '<table class="dir"><thead><tr>' +
        '<th class="n">#</th><th>Left column (odd)</th>' +
        '<th>Right column (even)</th><th class="n">#</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +

      '<p class="legend">' + legend + '</p>' +

      '<p class="foot">' +
        '<b>2-pole breakers share one handle</b> &mdash; a cell spanning two rows is ' +
        'ONE breaker. Switching it off kills both slots.' +
      '</p>' +

      '<footer>' +
        '<span>Generated from blackstart &mdash; data as of ' + esc(stamp) + '</span>' +
        '<span>' + survey.occupied + ' breakers &middot; ' + survey.empty + ' empty' +
        (survey.unaccounted ? ' &middot; ' + survey.unaccounted + ' NOT SURVEYED' : '') +
        '</span>' +
      '</footer>' +
    '</section>' +

    /* ---- BACK: what to do in an outage ---- */
    '<section class="card back">' +
      '<header>' +
        '<div class="title">' +
          '<h1>Outage procedure</h1>' +
          '<p>' + esc(panel.name) + ' &mdash; ' + esc(src.name || '') + '</p>' +
        '</div>' +
      '</header>' +

      (warnings ? '<div class="warn"><h2>Before you start</h2><ul>' + warnings + '</ul></div>' : '') +

      '<div class="cols">' +
        '<div>' +
          '<h2>Turn these off first</h2>' + shedBlocks +
          (subBlocks ? '<h2>You cannot switch these off here</h2>' + subBlocks : '') +
        '</div>' +
        '<div>' +
          '<h2>Step order</h2>' +
          '<ol class="proc">' + procedure + '</ol>' +
          connectionNote(data, panel) +
          '<p class="foot">Full instructions, photos and search: ' +
          '<b>blackstart.ericpullen.com</b></p>' +
        '</div>' +
      '</div>' +

      '<footer>' +
        '<span>Load figures are CONNECTED load, not a measurement.</span>' +
        '<span>Data as of ' + esc(stamp) + '</span>' +
      '</footer>' +
    '</section>' +

    '</body></html>\n';
}

/* ---------------------------------------------------------------------- css */

function css(opt) {
  return [
  '@page { size: letter; margin: 0; }',
  '* { box-sizing: border-box; margin: 0; padding: 0; }',
  'html, body { background: #fff; color: #000; }',
  'body { font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;',
  '  -webkit-font-smoothing: antialiased; }',

  /* One card per printed page, centred, with crop marks at the trim line. */
  '.card { width: ' + opt.width + '; height: ' + opt.height + ';',
  '  margin: 0 auto; padding: 0.22in 0.24in 0.18in; display: flex;',
  '  flex-direction: column; outline: 1px dashed #bbb; outline-offset: 0;',
  '  page-break-after: always; break-after: page; overflow: hidden; }',
  '.card:last-child { page-break-after: auto; break-after: auto; }',
  '@media print { .card { outline: 1px dashed #ccc; } }',
  '@media screen { body { background: #e8e8ea; padding: 24px 0; }',
  '  .card { background: #fff; margin-bottom: 24px; box-shadow: 0 2px 12px rgba(0,0,0,.18); } }',

  /* header */
  'header { display: flex; justify-content: space-between; align-items: flex-end;',
  '  border-bottom: 2.5px solid #000; padding-bottom: 5px; margin-bottom: 7px; }',
  '.title h1 { font-size: 17pt; font-weight: 800; letter-spacing: -0.4px; line-height: 1; }',
  '.title p { font-size: 8pt; text-transform: uppercase; letter-spacing: 1.1px; margin-top: 2px; }',
  '.src { text-align: right; font-size: 7.2pt; line-height: 1.35; }',
  '.src b { font-size: 9pt; }',

  /* directory table */
  'table.dir { width: 100%; border-collapse: collapse; table-layout: fixed; }',
  'table.dir th { font-size: 6.2pt; text-transform: uppercase; letter-spacing: 0.7px;',
  '  border-bottom: 1px solid #000; padding: 2px 3px; text-align: left; font-weight: 700; }',
  'table.dir th.n, table.dir td.n { width: 0.28in; text-align: center; }',
  'table.dir td { border-bottom: 0.5px solid #999; padding: 2px 3px; vertical-align: middle;',
  '  height: 0.245in; }',
  'td.n { font-size: 7.5pt; font-weight: 700; font-variant-numeric: tabular-nums;',
  '  background: #ececec; border-right: 0.5px solid #999; border-left: 0.5px solid #999; }',
  'td.c { font-size: 7.4pt; line-height: 1.15; }',
  '.lbl { display: block; font-weight: 600; overflow: hidden; white-space: nowrap;',
  '  text-overflow: ellipsis; }',
  '.meta { font-size: 6pt; color: #333; font-variant-numeric: tabular-nums; }',

  /* states — glyph and weight, never colour alone */
  'td.blank { color: #999; font-style: italic; font-size: 6.6pt; }',
  'td.crit { background: #f0f0f0; }',
  'td.crit .lbl { font-weight: 800; }',
  'td.untraced .lbl { font-weight: 500; font-style: italic; }',
  'td.inlet { background: #000; color: #fff; }',
  'td.inlet .meta { color: #ddd; }',
  /* a feed-through lug is not a breaker: heavy dashed box, never a shed target */
  'td.tap { border: 1.5px dashed #000; }',
  'td.tap .lbl { font-weight: 800; }',
  '.tagline { display: block; font-size: 5.6pt; font-weight: 800; letter-spacing: 1px; }',
  '.offs { float: right; margin-left: 3px; }',
  'b.off { display: inline-block; min-width: 8.5pt; padding: 0 1.5pt; margin-left: 1.5pt;',
  '  border: 0.8px solid #000; font-size: 5.8pt; font-weight: 800; text-align: center;',
  '  line-height: 1.5; }',
  'td.inlet b.off { border-color: #fff; }',

  /* legend + footers */
  '.legend { font-size: 5.9pt; margin-top: 5px; line-height: 1.5; }',
  '.foot { font-size: 6.2pt; margin-top: 4px; line-height: 1.4; }',
  'footer { margin-top: auto; padding-top: 5px; border-top: 0.5px solid #999;',
  '  display: flex; justify-content: space-between; font-size: 5.6pt; color: #444; }',

  /* back side */
  '.back h2 { font-size: 7.4pt; text-transform: uppercase; letter-spacing: 0.9px;',
  '  border-bottom: 1px solid #000; padding-bottom: 2px; margin-bottom: 5px; }',
  '.warn { border: 1.5px solid #000; padding: 6px 8px; margin-bottom: 8px; }',
  '.warn h2 { border: 0; margin-bottom: 3px; }',
  '.warn ul { list-style: none; font-size: 7.4pt; line-height: 1.35; }',
  '.warn li { padding-left: 10px; position: relative; margin-bottom: 2px; }',
  '.warn li::before { content: "!"; position: absolute; left: 0; font-weight: 800; }',
  '.cols { display: flex; gap: 0.22in; flex: 1; }',
  '.cols > div { flex: 1; min-width: 0; }',
  '.shed { margin-bottom: 9px; }',
  '.shed-h { font-size: 7.4pt; font-weight: 700; margin-bottom: 3px; }',
  '.shed-l { list-style: none; font-size: 7.2pt; line-height: 1.45; }',
  '.shed-l li { border-bottom: 0.5px dotted #aaa; padding: 1px 0; }',
  '.shed-l .sn { display: inline-block; min-width: 0.3in; font-weight: 800;',
  '  font-variant-numeric: tabular-nums; }',
  '.shed-l i { font-style: normal; color: #444; font-size: 6.4pt; }',
  '.none { font-size: 7pt; font-style: italic; color: #555; }',
  '.tap-block { border: 1px dashed #000; padding: 5px 6px; }',
  '.tap-where { font-size: 6.6pt; line-height: 1.4; margin-bottom: 3px; }',
  '.tap-dont { font-size: 6.6pt; line-height: 1.4; font-weight: 700;',
  '  border-top: 0.5px solid #999; padding-top: 3px; }',
  '.budget { font-size: 6.2pt; margin-top: 3px; line-height: 1.35; }',
  'ol.proc { font-size: 7.2pt; line-height: 1.5; padding-left: 14px; }',
  'ol.proc li { margin-bottom: 1px; }',
  '.conn { font-size: 6.6pt; line-height: 1.45; margin-top: 6px;',
  '  border: 0.8px solid #000; padding: 4px 5px; }'
  ].join('\n');
}

/* -------------------------------------------------------------------- main */

var opt = parseArgs(process.argv.slice(2));
var dataPath = path.resolve(ROOT, opt.data);
var data;
try {
  data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
} catch (e) {
  console.error('could not read ' + opt.data + ': ' + e.message);
  process.exit(1);
}

if (data.schemaVersion !== Model.SCHEMA_VERSION) {
  console.error('schemaVersion ' + data.schemaVersion + ' but this script expects ' +
    Model.SCHEMA_VERSION);
  process.exit(1);
}

var panelKeys = opt.panel === 'all' ? Object.keys(data.panels) : [opt.panel];
panelKeys.forEach(function (k) {
  if (!data.panels[k]) { console.error('no such panel: ' + k); process.exit(1); }
});

var outDir = path.resolve(ROOT, opt.out);
fs.mkdirSync(outDir, { recursive: true });

var report = { overflow: [] };
var written = [];

panelKeys.forEach(function (k) {
  var card = renderCard(data, k, opt, report);
  var file = 'insert-panel-' + k.toLowerCase() + '.html';
  fs.writeFileSync(path.join(outDir, file), card.html);
  written.push({ file: path.relative(process.cwd(), path.join(outDir, file)),
                 panel: k, survey: card.survey });
});

/* ------------------------------------------------------------------ report */

written.forEach(function (w) {
  console.log('wrote ' + w.file + '  (panel ' + w.panel + ': ' +
    w.survey.occupied + ' breakers, ' + w.survey.empty + ' empty' +
    (w.survey.unaccounted ? ', ' + w.survey.unaccounted + ' NOT SURVEYED' : '') + ')');
  if (w.survey.unaccounted) {
    console.log('  warn  panel ' + w.panel + ' is not fully surveyed; the card will say so');
  }
});

if (report.overflow.length) {
  console.log('');
  console.log('warn  ' + report.overflow.length + ' label(s) are wider than ' +
    opt.maxLabel + ' characters and will be clipped with an ellipsis.');
  console.log('      Add a shorter "shortLabel" to these devices:');
  report.overflow
    .sort(function (a, b) { return b.len - a.len; })
    .forEach(function (o) {
      console.log('        ' + o.id.padEnd(10) + String(o.len).padStart(3) + '  ' + o.label);
    });
}

console.log('');
console.log('Print at 100% scale with margins set to None. Each panel makes two');
console.log('pages: the directory, then the outage procedure for the back.');
console.log('Card trim size is ' + opt.width + ' x ' + opt.height +
  ' (override with --width / --height).');
