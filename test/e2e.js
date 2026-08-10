#!/usr/bin/env node
/* e2e.js — boots the real index.html in jsdom against the real data file and
 * asserts the app actually rendered. Run: node test/e2e.js
 *
 * This is a smoke test, not a unit test. It exists to catch the failure mode
 * that matters most in a no-build-step repo: the app silently rendering
 * nothing because a selector, an id or a data field drifted.
 *
 * Requires the one dev dependency: npm install
 */
'use strict';

var fs = require('fs');
var path = require('path');
var JSDOM = require('jsdom').JSDOM;

var ROOT = path.join(__dirname, '..');
var DATA_FILE = 'data/montfort.json';

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

/* Inline the external scripts so jsdom executes them during parsing and
 * DOMContentLoaded fires normally. Loading them as real subresources is
 * flakier and depends on jsdom's resource loader. */
function buildHtml() {
  var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ['src/model.js', 'src/app.js'].forEach(function (rel) {
    var tag = '<script src="' + rel + '"></script>';
    if (html.indexOf(tag) < 0) {
      throw new Error('index.html no longer loads ' + rel + ' — update test/e2e.js');
    }
    var code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    html = html.replace(tag, '<script>\n' + code + '\n</script>');
  });
  return html;
}

var data = JSON.parse(fs.readFileSync(path.join(ROOT, DATA_FILE), 'utf8'));

var dom = new JSDOM(buildHtml(), {
  runScripts: 'dangerously',
  url: 'http://localhost/',
  pretendToBeVisual: true,
  beforeParse: function (window) {
    /* The app fetches its data; serve it from disk. */
    window.fetch = function (url) {
      if (String(url).indexOf('montfort.json') >= 0) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () { return Promise.resolve(JSON.parse(JSON.stringify(data))); }
        });
      }
      return Promise.reject(new Error('unexpected fetch: ' + url));
    };
    window.scrollTo = function () {};
    window.confirm = function () { return true; };
  }
});

var window = dom.window;
var document = window.document;

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }
function text(sel) { var e = $(sel); return e ? e.textContent.trim() : null; }

/* Let the fetch promise chain settle. */
setTimeout(function () {
  run();
  report();
}, 60);

function run() {
  /* --- did it boot at all --- */
  check('no fatal error banner', !$('.fatal'), true);
  check('home subtitle filled from data', text('#home-subtitle'),
    function (v) { return v && v.indexOf(data.home.name) === 0; });
  check('status cards rendered', $$('#home-status .status-card').length,
    Object.keys(data.panels).length);
  check('data stamp shows lastUpdated', text('#data-stamp'),
    function (v) { return v && v.indexOf(data.metadata.lastUpdated) >= 0; });

  /* --- search --- */
  var Model = window.Model;
  var totalCircuits = Model.allCircuits(data).length;
  check('every circuit rendered', $$('#circuit-list .circuit-item').length, totalCircuits);
  check('generator inlet excluded from circuit list',
    Model.allCircuits(data).some(function (c) { return c.deviceId === 'A-2-4'; }), false);

  /* The old app serialized circuits into onclick attributes, which broke on
   * any apostrophe in the data. Assert we never do that again. */
  var listHtml = $('#circuit-list').innerHTML;
  check('no inline handlers in rendered rows', /onclick=/i.test(listHtml), false);
  check('rows addressed by device id', /data-device="A-6"/.test(listHtml), true);

  /* Rooms with apostrophes are the exact case that broke the old build: an
   * alias like "Myia's Bedroom" terminated the single-quoted onclick attribute.
   * Assert the text renders literally (not double-escaped into the visible
   * output) and that the row is addressed by attribute instead. The clickable
   * half of this is covered by the "every circuit row opens a modal" check. */
  var apostropheRows = [].filter.call($$('#circuit-list .circuit-item'), function (r) {
    return r.textContent.indexOf('Myia') >= 0;
  });
  check('apostrophe rooms rendered', apostropheRows.length, function (n) { return n > 0; });
  check('apostrophe renders literally, not as an entity',
    apostropheRows.length && apostropheRows[0].querySelector('.circuit-room').textContent,
    "Myia's Bedroom");

  /* --- panel grid: the bug that hid basement loads --- */
  check('panel A renders all 30 slots', $$('#panel-a-grid .breaker-slot').length, 30);
  var gridA = $('#panel-a-grid').innerHTML;
  check('MWBC breaker A-5-7 shows its real label, not "Unknown 240V circuit"',
    gridA.indexOf('Basement') >= 0, true);
  check('no "Unknown 240V circuit" anywhere', gridA.indexOf('Unknown 240V') >= 0, false);
  check('inlet breaker styled as inlet', $$('#panel-a-grid .inlet').length, 1);
  check('2-pole lower half marked as same handle',
    (gridA.match(/same handle/g) || []).length,
    data.devices.filter(function (d) { return d.panel === 'A' && d.poles === 2; }).length);
  check('critical breakers highlighted',
    $$('#panel-a-grid .breaker-slot.critical').length,
    function (n) { return n >= 3; });

  /* --- declared-empty vs unaccounted --- */
  check('panel B renders all 30 slots', $$('#panel-b-grid .breaker-slot').length, 30);
  check('panel B declared-empty slots render as Empty',
    $$('#panel-b-grid .breaker-slot.empty').length, data.panels.B.emptySlots.length);
  check('both panels fully reconcile, so nothing reads "Not surveyed"',
    $$('.breaker-slot.unsurveyed').length, 0);
  Object.keys(data.panels).forEach(function (p) {
    var st = Model.surveyStatus(data, p);
    check('panel ' + p + ' slots reconcile (occupied + empty = total)',
      st.occupied + st.empty, st.total);
    check('panel ' + p + ' reports surveyed', st.surveyed, true);
  });

  /* --- the Panel B safety correction (v2.2) --- */
  /* Slots 2/4 were recorded as a 50A double oven and were therefore ON the
   * Panel B shed list. They are the generator inlet. If this regresses, the
   * walkthrough tells someone to switch off the feed they are about to need
   * while leaving a 5 kW oven live behind a 30A inlet. */
  var b24 = data.devices.filter(function (d) { return d.id === 'B-2-4'; })[0];
  check('B-2-4 exists', !!b24, true);
  check('B-2-4 is the generator inlet, not a load', b24.role, 'generatorInlet');
  check('B-2-4 is not in any shed list', (b24.shedIn || []).length, 0);
  check('B-2-4 carries no circuits', (b24.circuits || []).length, 0);
  check('panels.B.generatorInlet points at B-2-4', data.panels.B.generatorInlet.deviceId, 'B-2-4');
  check('the double oven moved off 2/4',
    data.devices.some(function (d) {
      return (d.circuits || []).some(function (c) { return /oven/i.test(c.endpoint); }) &&
        d.id !== 'B-2-4';
    }), true);
  check('panel B grid marks 2/4 as the inlet', $$('#panel-b-grid .inlet').length, 1);
  check('the inlet never appears in the Panel B shed list',
    $('#steps-panelB').innerHTML.toLowerCase().indexOf('generator inlet (f-150') >= 0, false);

  /* --- unassigned endpoints are searchable, not hidden --- */
  var unmappedRows = $$('#circuit-list .circuit-item.unmapped');
  check('untraced endpoints get rows', unmappedRows.length, data.unassignedEndpoints.length);
  check('searching an untraced endpoint finds it',
    (function () {
      var input = $('#search-input');
      input.value = 'driveway';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      var n = $$('#circuit-list .circuit-item').length;
      input.value = '';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      return n;
    })(), function (n) { return n > 0; });
  check('an untraced row opens a modal explaining it is untraced',
    (function () {
      $$('#circuit-list .circuit-item.unmapped')[0]
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      return /No breaker has been identified/.test($('#modal-content').textContent);
    })(), true);

  /* --- circuit-level verification --- */
  var unconfirmed = Model.allCircuits(data).filter(function (c) { return c.verified === false; });
  check('some circuits are flagged unconfirmed', unconfirmed.length,
    function (n) { return n > 0; });
  check('unconfirmed circuits are badged in search',
    $$('#circuit-list .tag.unverified').length,
    unconfirmed.filter(function (c) { return !c.unmapped; }).length);

  /* --- untraced capacity must not read as safe --- */
  var sumB = Model.loadSummary(data, 'B', 'truckHome');
  check('Panel B has untraced breakers', sumB.untracedDevices.length,
    function (n) { return n > 0; });
  check('Panel B load meter warns that it reads low',
    /reads low/i.test($('#load-panelB').textContent), true);

  /* --- a null amperage must not render as "nullA" --- */
  check('null amperage never renders as nullA',
    $('#panel-b-grid').innerHTML.indexOf('nullA') >= 0, false);

  /* --- the feed-through lug at Panel B 6/8 (v2.3) --- */
  /* 6/8 is a Leviton LFTLA bus tap, not a breaker. Everything below rests on
   * it never reading as something a person can switch off: the directory card
   * called it "Furn", which implies exactly the handle that isn't there. */
  var b68 = data.devices.filter(function (d) { return d.id === 'B-6-8'; })[0];
  check('B-6-8 is a feedThrough, not a branch', b68.role, 'feedThrough');
  check('B-6-8 has no ampacity', b68.amps, null);
  check('B-6-8 is in no shed list', (b68.shedIn || []).length, 0);
  check('B-6-8 carries no circuits of its own', (b68.circuits || []).length, 0);
  check('B-6-8 names the subpanel it feeds', !!Model.subpanelById(data, b68.feeds), true);
  check('B-6-8 is excluded from search like any non-load',
    Model.allCircuits(data).some(function (c) { return c.deviceId === 'B-6-8'; }), false);

  var gridB = $('#panel-b-grid').innerHTML;
  check('feed-through cell is styled as one', $$('#panel-b-grid .feedthrough').length, 1);
  check('feed-through says NO HANDLE rather than an amp rating',
    gridB.indexOf('NO HANDLE') >= 0, true);
  check('feed-through is not labelled untraced',
    $('#panel-b-grid .feedthrough').textContent.indexOf('untraced') >= 0, false);
  check('feed-through lower half says "same lug", not "same handle"',
    $$('#panel-b-grid .feedthrough-cont').length, 1);
  check('tapping the feed-through explains there is nothing to switch',
    (function () {
      $('#panel-b-grid .feedthrough')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      return /nothing to switch off/i.test($('#modal-content').textContent);
    })(), true);

  /* --- subpanel load counts, and counts as unsheddable --- */
  var sp = Model.subpanelById(data, 'hvac-strips');
  check('the heat kit is one 20 kW appliance, not three', sp.estimatedWattsTotal, 20000);
  check('subpanel breakers carry no watts of their own',
    sp.devices.every(function (d) { return !('estimatedWatts' in d); }), true);
  check('Panel B load includes the subpanel', sumB.unsheddableWatts, 20000);
  check('subpanel load survives the shed list',
    Model.loadSummary(data, 'B', 'truckHome').remainingWatts >= 20000, true);
  check('the load meter says it cannot be removed at the panel',
    /no breaker in this panel can remove it/i.test($('#load-panelB').textContent), true);
  check('a subpanel card is rendered under the Panel B grid',
    $$('#panel-b-subpanels .subpanel-card').length, 1);
  check('the subpanel card names where the real disconnect is',
    (function () {
      $('#panel-b-subpanels .subpanel-card')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      return /air handler/i.test($('#modal-content').textContent);
    })(), true);

  /* Someone typing "heat" in an outage has to find the 20 kW of strips and
   * learn no garage breaker touches them. */
  check('subpanel appliances are searchable',
    $$('#circuit-list .circuit-item.subpanel-item').length, sp.appliances.length);
  check('subpanel rows say there is no breaker for them',
    $('#circuit-list .circuit-item.subpanel-item').textContent.indexOf('No breaker') >= 0, true);

  /* --- the orange tape means "shed this" (v2.4) --- */
  /* The tape was already on the panel; nobody had recorded what it meant. Now
   * that it does mean something, the data and the tape must agree, or the
   * physical panel and the app give different instructions. */
  var taped = data.devices.filter(function (d) { return d.physicalMarking === 'orange tape'; });
  check('every taped breaker says what the tape means',
    taped.every(function (d) { return !!d.physicalMarkingMeaning; }), true);
  check('every taped breaker is shed in every scenario it can be',
    taped.every(function (d) {
      return Object.keys(data.scenarios).every(function (k) {
        return !Model.panelAvailable(data, k, d.panel) || (d.shedIn || []).indexOf(k) >= 0;
      });
    }), true);
  check('the tape meaning reaches the modal',
    (function () {
      $('#panel-a-grid button[data-device="A-1-3"]')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      return /shut this off in an outage/i.test($('#modal-content').textContent);
    })(), true);

  /* --- an SPD draws nothing; that is not the same as untraced --- */
  var sumA = Model.loadSummary(data, 'A', 'truckHome');
  check('Panel A has no untraced breakers left', sumA.untracedDevices.length, 0);
  check('Panel A load meter drops the "reads low" warning',
    /reads low/i.test($('#load-panelA').textContent), false);
  check('the surge protectors are recorded at 0 W, not left blank',
    data.devices.filter(function (d) {
      return /surge/i.test(d.label);
    }).every(function (d) { return d.estimatedWattsTotal === 0 && d.circuits.length === 1; }), true);

  /* --- no placeholder labels survive --- */
  check('no device label is still a placeholder',
    data.devices.filter(Model.needsLabelReview).length, 0);

  /* --- the trickle-charge outlet is on the OTHER panel --- */
  /* The Anker backs up Panel A but charges from Panel B-26. Someone hunting
   * for that outlet on the Panel A schedule will not find it. */
  var b26 = data.devices.filter(function (d) { return d.id === 'B-26'; })[0];
  check('B-26 is the Anker trickle-charge plug', /trickle/i.test(b26.label), true);
  check('the trickle-charge warning names the breaker',
    data.safetyWarnings.some(function (w) {
      return w.id === 'trickle-charge' && /slot 26/i.test(w.message);
    }), true);
  check('B-26 is not shed, so the truck can still recharge the Anker',
    (b26.shedIn || []).length, 0);

  /* --- the inlets are MALE, so an ordinary cord works (v2.5) --- */
  /* This was the male-to-male worry. If a connection is ever recorded female
   * again, someone is being told to improvise a cord with live exposed pins. */
  Object.keys(data.panels).forEach(function (p) {
    var conn = (data.panels[p].generatorInlet || {}).connection || {};
    check('panel ' + p + ' inlet gender is recorded', conn.gender, 'male');
    check('panel ' + p + ' inlet gender is verified, not read off a photo',
      conn.genderVerified, true);
    check('panel ' + p + ' inlet names a real cable',
      !!(data.cables || {})[data.panels[p].generatorInlet.cable], true);
  });
  check('no inlet is described as a receptacle any more',
    Object.keys(data.panels).some(function (p) {
      return !!data.panels[p].generatorInlet.receptacle;
    }), false);
  check('the cable spells out which end is which',
    /male/i.test(data.cables['l1430-ext'].ends) &&
    /female/i.test(data.cables['l1430-ext'].ends), true);
  check('tapping the inlet says what plugs into it',
    (function () {
      $('#panel-a-grid button[data-device="A-2-4"]')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      var t = $('#modal-content').textContent;
      return /what plugs in here/i.test(t) && /male/i.test(t);
    })(), true);

  /* --- product links must never be an injection vector --- */
  check('every equipment productUrl is a plain https link',
    data.devices.every(function (d) {
      var u = (d.equipment || {}).productUrl;
      return !u || u.indexOf('https://') === 0;
    }), true);

  /* --- the heat-pump-only plan must not contradict itself --- */
  var b1012 = data.devices.filter(function (d) { return d.id === 'B-10-12'; })[0];
  check('the heat pump is not shed, since the plan is to run it', (b1012.shedIn || []).length, 0);
  check('the Panel B walkthrough starts with the thermostat lockout',
    /connex/i.test(data.walkthroughSteps.panelB[1].instruction), true);
  check('no step tells you to kill all three subpanel breakers',
    data.walkthroughSteps.panelB.some(function (s) {
      return /all three/i.test(s.instruction) && !/do not/i.test(s.instruction);
    }), false);

  /* --- open questions --- */
  check('open questions rendered', $$('#open-questions .question-card').length,
    data.openQuestions.length);
  check('disputed breakers badged in the grid',
    $$('#panel-a-grid .slot-badge.question').length, function (n) { return n > 0; });

  /* --- walkthrough --- */
  check('scenario buttons rendered', $$('#scenario-selector .scenario-btn').length,
    Object.keys(data.scenarios).length);
  check('safety warnings come from data', $$('#safety-warnings .warning-box').length,
    data.safetyWarnings.filter(function (w) { return w.showInWalkthrough; }).length);
  check('panel A steps rendered', $$('#steps-panelA .step-item').length,
    data.walkthroughSteps.panelA.length);
  check('shed list resolved from shedIn',
    $('#steps-panelA').innerHTML.indexOf('Dryer outlet (30A)') >= 0, true);
  check('load meter present', !!$('#load-panelA .load-bar'), true);
  check('load meter flags the overage',
    $('#load-panelA').className.indexOf('') === 0 && !!$('#load-panelA .load-meter.over'), true);

  /* Panel B is hidden in the Anker-only scenario. */
  var scenarioBtns = $$('#scenario-selector .scenario-btn');
  check('truckHome shows panel B', $('#section-panelB').style.display, 'block');

  var awayBtn = null;
  for (var i = 0; i < scenarioBtns.length; i++) {
    if (scenarioBtns[i].getAttribute('data-scenario') === 'truckAway') awayBtn = scenarioBtns[i];
  }
  check('found truckAway button', !!awayBtn, true);
  if (awayBtn) {
    awayBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('truckAway hides panel B', $('#section-panelB').style.display, 'none');
    check('truckAway sheds more than truckHome',
      ($('#steps-panelA').innerHTML.match(/step-breaker-tag/g) || []).length,
      function (n) { return n >= 4; });
  }

  /* --- interaction: opening a breaker --- */
  var slot = $('#panel-a-grid button[data-device]');
  slot.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('breaker tap opens the modal', $('#modal-overlay').className.indexOf('active') >= 0, true);
  check('modal has content', text('#modal-content'), function (v) { return v && v.length > 20; });

  /* --- interaction: a circuit row with an apostrophe in its room --- */
  var rows = $$('#circuit-list .circuit-item[data-circuit]');
  var clicked = 0;
  for (var j = 0; j < rows.length; j++) {
    rows[j].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    if ($('#modal-content').textContent.trim().length > 10) clicked++;
  }
  check('every circuit row opens a populated modal', clicked, rows.length);

  /* --- step completion --- */
  var toggle = $('#steps-panelA .step-toggle');
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('completing a step marks it done',
    $('#steps-panelA .step-item').className.indexOf('completed') >= 0, true);
  check('progress bar advances', $('#progress-panelA').style.width,
    function (v) { return v && v !== '0%'; });
}

function report() {
  if (failures.length) {
    failures.forEach(function (f) { console.log('FAIL  ' + f); });
    console.log('');
    console.log(checks + ' checks, ' + failures.length + ' failed');
    process.exit(1);
  }
  console.log(checks + ' checks, all passed');
  process.exit(0);
}
