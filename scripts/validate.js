#!/usr/bin/env node
/* validate.js — checks every home data file and the offline asset list.
 * No dependencies. Run: node scripts/validate.js
 * Exit code 1 on any error (CI runs this).
 *
 * This is the only safety net in the repo. There is no build step, so a typo
 * in a JSON file would otherwise ship straight to a phone that someone is
 * holding in a dark garage. Add a check here whenever you add a field.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var Model = require('../src/model.js');

var ROOT = path.join(__dirname, '..');
var DATA_DIR = path.join(ROOT, 'data');

var errors = [];
var warnings = [];

function err(m) { errors.push(m); }
function warn(m) { warnings.push(m); }

/* ------------------------------------------------------------------ helpers */

function isArray(x) { return Object.prototype.toString.call(x) === '[object Array]'; }

function fileExists(rel) {
  try { return fs.statSync(path.join(ROOT, rel)).isFile(); }
  catch (e) { return false; }
}

/* --------------------------------------------------------- data file checks */

function checkHome(data, file) {
  var where = file;

  if (data.schemaVersion !== Model.SCHEMA_VERSION) {
    err(where + ' — schemaVersion is ' + JSON.stringify(data.schemaVersion) +
      ', the app expects ' + Model.SCHEMA_VERSION);
  }

  ['home', 'backupSources', 'panels', 'devices', 'scenarios', 'walkthroughSteps']
    .forEach(function (k) {
      if (!data[k]) err(where + " — missing top-level '" + k + "'");
    });

  var panels = data.panels || {};
  var scenarioKeys = Object.keys(data.scenarios || {});

  /* backup sources referenced by panels must exist */
  Object.keys(panels).forEach(function (p) {
    var src = panels[p].backupSource;
    if (src && !(data.backupSources || {})[src]) {
      err(where + ' — panel ' + p + " references unknown backupSource '" + src + "'");
    }
    if (!panels[p].slots) err(where + ' — panel ' + p + ' has no slot count');
  });

  /* scenarios */
  scenarioKeys.forEach(function (k) {
    var sc = data.scenarios[k];
    if (!isArray(sc.panelsAvailable)) {
      err(where + " — scenario '" + k + "' needs a panelsAvailable array");
      return;
    }
    sc.panelsAvailable.forEach(function (p) {
      if (!panels[p]) err(where + " — scenario '" + k + "' lists unknown panel '" + p + "'");
    });
  });

  /* ------------------------------------------------------------- devices */

  var seenIds = Object.create(null);
  var slotOwner = Object.create(null); /* "A:7" -> device id */
  var loadTotals = Object.create(null);

  (data.devices || []).forEach(function (d, di) {
    var w = where + ' :: ' + (d.id || '(device #' + di + ')');

    ['id', 'panel', 'slots', 'poles', 'role', 'label'].forEach(function (f) {
      if (d[f] === undefined || d[f] === null) err(w + " — missing '" + f + "'");
    });
    /* amps may be null: an installed device whose rating we cannot read yet,
     * or a feed-through lug that has no rating to read. The key must still be
     * present so the omission is deliberate. */
    if (!('amps' in d)) {
      err(w + " — missing 'amps' (use null if the rating is genuinely unknown)");
    } else if (d.amps === null) {
      /* For a feed-through this is definitional, not a gap, so don't nag. */
      if (d.role !== Model.ROLE_FEEDTHROUGH) {
        warn(w + ' — amps is null; rating unknown, so this device is absent from all load math');
      }
    } else if (typeof d.amps !== 'number') {
      err(w + ' — amps must be a number or null');
    }
    if (d.role === Model.ROLE_FEEDTHROUGH && typeof d.amps === 'number') {
      err(w + ' — a feedThrough has no overcurrent protection, so amps must be null. ' +
        'Giving it a rating would imply a handle that can trip.');
    }

    if (d.id) {
      if (seenIds[d.id]) err(where + " — duplicate device id '" + d.id + "'");
      else seenIds[d.id] = true;
    }

    if (d.role !== Model.ROLE_BRANCH && d.role !== Model.ROLE_INLET &&
      d.role !== Model.ROLE_FEEDTHROUGH) {
      err(w + " — unknown role '" + d.role + "'");
    }

    var panel = panels[d.panel];
    if (!panel) {
      err(w + " — unknown panel '" + d.panel + "'");
      return;
    }

    if (!isArray(d.slots) || d.slots.length === 0) {
      err(w + ' — slots must be a non-empty array');
      return;
    }

    if (d.poles !== d.slots.length) {
      err(w + ' — poles is ' + d.poles + ' but slots has ' + d.slots.length +
        ' entry/entries (' + d.slots.join(',') + ')');
    }

    d.slots.forEach(function (s) {
      if (typeof s !== 'number' || s < 1 || s > panel.slots) {
        err(w + ' — slot ' + s + ' is outside panel ' + d.panel + "'s range 1-" + panel.slots);
        return;
      }
      var key = d.panel + ':' + s;
      if (slotOwner[key]) {
        err(where + ' — slot ' + d.panel + '-' + s + " is claimed by both '" +
          slotOwner[key] + "' and '" + d.id + "'");
      } else {
        slotOwner[key] = d.id;
      }
    });

    /* A 2-pole breaker straddles two adjacent positions in the SAME column.
     * Left column is odd, right column is even, so the pair differs by 2 and
     * shares parity. A pair like [1,2] would be physically impossible. */
    if (d.slots.length === 2) {
      var a = d.slots[0], b = d.slots[1];
      if (a % 2 !== b % 2) {
        err(w + ' — 2-pole slots [' + a + ',' + b + '] span both columns; ' +
          'a 2-pole breaker occupies two same-parity slots');
      } else if (Math.abs(b - a) !== 2) {
        err(w + ' — 2-pole slots [' + a + ',' + b + '] are not adjacent (expected a gap of 2)');
      }
    }

    /* shedIn must name real scenarios */
    (d.shedIn || []).forEach(function (k) {
      if (scenarioKeys.indexOf(k) < 0) {
        err(w + " — shedIn references unknown scenario '" + k + "'");
      }
    });

    /* an inlet is not a load and must not carry circuits or shed flags */
    if (d.role === Model.ROLE_INLET) {
      if ((d.circuits || []).length) err(w + ' — a generatorInlet must not have circuits');
      if ((d.shedIn || []).length) err(w + ' — a generatorInlet must not have shedIn entries');
    }

    /* A feed-through lug has no handle. Putting it in a shed list would tell
     * someone to switch off something they physically cannot, and hanging
     * circuits directly on it would hide the fact that the real disconnect is
     * in a different enclosure. Its loads belong to the subpanel it feeds. */
    if (d.role === Model.ROLE_FEEDTHROUGH) {
      if ((d.circuits || []).length) {
        err(w + ' — a feedThrough must not carry circuits directly; put them on the ' +
          'subpanel it feeds, so the disconnect location stays visible');
      }
      if ((d.shedIn || []).length) {
        err(w + ' — a feedThrough has no handle and cannot be shed');
      }
      if (!d.feeds) {
        err(w + " — a feedThrough must name what it feeds via 'feeds'");
      } else if (!Model.subpanelById(data, d.feeds)) {
        err(w + " — feeds '" + d.feeds + "' is not a known subpanel");
      }
    }

    /* ----------------------------------------------------------- circuits */

    var sum = 0;
    (d.circuits || []).forEach(function (c, ci) {
      var cw = w + ' circuit #' + ci + ' (' + (c.endpoint || '?') + ')';
      ['room', 'endpoint'].forEach(function (f) {
        if (!c[f]) err(cw + " — missing '" + f + "'");
      });
      if (typeof c.estimatedWatts !== 'number') {
        err(cw + ' — estimatedWatts must be a number');
      } else {
        sum += c.estimatedWatts;
      }

      if ('verified' in c && typeof c.verified !== 'boolean') {
        err(cw + ' — verified must be true or false');
      }
      if (c.verified === false) {
        warn(cw + ' — recorded but not confirmed; the app shows it as a guess');
      } else if (!('verified' in c)) {
        warn(cw + ' — no verified flag; provenance unknown');
      }

      /* fedFromSlot must point at a slot this breaker actually occupies,
       * otherwise the panel view would attribute a load to the wrong handle. */
      var fed = c.fedFromSlot;
      if (fed !== undefined && fed !== null) {
        var list = isArray(fed) ? fed : [fed];
        list.forEach(function (s) {
          if (d.slots.indexOf(s) < 0) {
            err(cw + ' — fedFromSlot ' + s + ' is not one of this device\'s slots [' +
              d.slots.join(',') + ']');
          }
        });
      }
    });

    if (d.circuits && d.circuits.length) {
      if (typeof d.estimatedWattsTotal !== 'number') {
        err(w + ' — estimatedWattsTotal must be a number');
      } else if (d.estimatedWattsTotal !== sum) {
        err(w + ' — estimatedWattsTotal is ' + d.estimatedWattsTotal +
          ' but its circuits sum to ' + sum);
      }
    }

    loadTotals[d.panel] = (loadTotals[d.panel] || 0) +
      (Model.isLoad(d) ? (d.estimatedWattsTotal || 0) : 0);

    /* An installed branch breaker with no circuits counts as 0 W, so the panel
     * total reads low. Name each one rather than only warning in aggregate. */
    if (Model.isLoad(d) && (!d.circuits || !d.circuits.length)) {
      warn(w + ' — installed but no circuits traced' +
        (d.amps ? ' (' + d.amps + 'A of capacity)' : '') +
        '; contributes 0 W to the panel load figure');
    }

    /* A product URL gets rendered as a real anchor, so it must be a plain
     * https link — never a javascript: or data: URI smuggled in through data. */
    if (d.equipment && d.equipment.productUrl !== undefined && d.equipment.productUrl !== null) {
      if (typeof d.equipment.productUrl !== 'string' ||
        d.equipment.productUrl.indexOf('https://') !== 0) {
        err(w + ' — equipment.productUrl must be an https:// URL (it is rendered as a link)');
      }
    }

    if (d.shortLabel !== undefined && typeof d.shortLabel !== 'string') {
      err(w + ' — shortLabel must be a string');
    }
    if (d.shortLabel && d.shortLabel.length > d.label.length) {
      warn(w + ' — shortLabel is longer than label; drop it or shorten it');
    }

    /* content debt, not a build failure */
    if (Model.needsLabelReview(d)) {
      warn(w + " — label is a " + d.labelSource + '; rewrite it for the app');
    }
  });

  /* ------------------------------------------------- slot reconciliation */

  /* Every slot should be either occupied by a device or declared in
   * emptySlots. Anything left over is a slot nobody has looked at, which the
   * app renders as "Not surveyed" rather than "Empty". */
  Object.keys(panels).forEach(function (p) {
    var panel = panels[p];
    var declared = panel.emptySlots;
    if (!declared) {
      warn(where + ' — panel ' + p + ' has no emptySlots list, so every unoccupied ' +
        'slot reads as "Not surveyed"');
      declared = [];
    }

    declared.forEach(function (s) {
      if (typeof s !== 'number' || s < 1 || s > panel.slots) {
        err(where + ' — panel ' + p + ' emptySlots lists ' + s + ', outside 1-' + panel.slots);
        return;
      }
      if (slotOwner[p + ':' + s]) {
        err(where + ' — panel ' + p + ' slot ' + s + " is declared empty but " +
          slotOwner[p + ':' + s] + ' occupies it');
      }
    });

    var unaccounted = [];
    for (var s2 = 1; s2 <= panel.slots; s2++) {
      if (!slotOwner[p + ':' + s2] && declared.indexOf(s2) < 0) unaccounted.push(s2);
    }
    if (unaccounted.length) {
      warn(where + ' — panel ' + p + ' has ' + unaccounted.length +
        ' slot(s) neither occupied nor declared empty: ' + unaccounted.join(', '));
    }
  });

  /* --------------------------------------------------- panel infrastructure */

  Object.keys(panels).forEach(function (p) {
    var inlet = panels[p].generatorInlet;
    if (!inlet) {
      warn(where + ' — panel ' + p + ' has no generatorInlet block');
      return;
    }
    if (inlet.deviceId) {
      var dev = seenIds[inlet.deviceId];
      if (!dev) {
        err(where + ' — panel ' + p + " generatorInlet.deviceId '" +
          inlet.deviceId + "' is not a known device");
      } else {
        var match = (data.devices || []).filter(function (d) { return d.id === inlet.deviceId; })[0];
        if (match && match.role !== Model.ROLE_INLET) {
          err(where + ' — panel ' + p + ' generatorInlet points at ' + match.id +
            ", whose role is '" + match.role + "' (expected generatorInlet)");
        }
      }
    } else {
      warn(where + ' — panel ' + p + ' generatorInlet has no deviceId yet (not surveyed)');
    }

    if (inlet.cable && !(data.cables || {})[inlet.cable]) {
      err(where + ' — panel ' + p + " generatorInlet.cable '" + inlet.cable +
        "' is not a known cable");
    }

    /* The gender of the house-side connector decides whether an ordinary cord
     * works or whether someone has to improvise one with exposed live pins.
     * It is the single most safety-relevant fact about an inlet, so an
     * unrecorded gender is a gap worth naming. */
    var conn = inlet.connection;
    if (!conn) {
      warn(where + ' — panel ' + p + ' generatorInlet has no connection block; ' +
        'nobody can tell what plugs into it');
    } else {
      if (!conn.gender) {
        warn(where + ' — panel ' + p + ' inlet connection has no gender recorded. ' +
          'Male (a flanged inlet) takes an ordinary cord; female would mean an ' +
          'improvised male-to-male one. Say which.');
      } else if (conn.gender === 'female') {
        warn(where + ' — panel ' + p + ' inlet connection is recorded FEMALE, which ' +
          'would require a male-to-male cord. Confirm this is really not a flanged inlet.');
      }
      if (conn.gender && conn.genderVerified !== true) {
        warn(where + ' — panel ' + p + ' inlet gender is recorded but not marked verified');
      }
    }
  });

  /* ------------------------------------------------------------- cables */

  Object.keys(data.cables || {}).forEach(function (k) {
    var c = data.cables[k];
    var cw = where + ' :: cable ' + k;
    ['name', 'configuration', 'ends'].forEach(function (f) {
      if (!c[f]) err(cw + " — missing '" + f + "'");
    });
    var usedBy = Object.keys(panels).filter(function (p) {
      return ((panels[p].generatorInlet || {}).cable) === k;
    });
    if (!usedBy.length) warn(cw + ' — no panel inlet references this cable');
  });

  /* ------------------------------------------------------------ subpanels */

  /* A subpanel is everything downstream of a feed-through tap. The rules that
   * matter here all guard one mistake: making its load look like something a
   * breaker in the parent panel can switch off, or counting one appliance once
   * per breaker that feeds it. */
  (data.subpanels || []).forEach(function (sp, si) {
    var sw = where + ' :: subpanel ' + (sp.id || '#' + si);

    ['id', 'name', 'location', 'fedFrom'].forEach(function (f) {
      if (!sp[f]) err(sw + " — missing '" + f + "'");
    });
    if (sp.id && seenIds[sp.id]) {
      err(sw + ' — subpanel id collides with a device id');
    }

    var from = sp.fedFrom || {};
    if (from.panel && !panels[from.panel]) {
      err(sw + " — fedFrom.panel '" + from.panel + "' is not a known panel");
    }
    if (!from.deviceId) {
      err(sw + ' — fedFrom.deviceId is required; a subpanel must say what feeds it');
    } else {
      var feeder = (data.devices || []).filter(function (d) { return d.id === from.deviceId; })[0];
      if (!feeder) {
        err(sw + " — fedFrom.deviceId '" + from.deviceId + "' is not a known device");
      } else {
        if (feeder.panel !== from.panel) {
          err(sw + ' — fedFrom says panel ' + from.panel + ' but ' + feeder.id +
            ' is in panel ' + feeder.panel);
        }
        if (feeder.feeds !== sp.id) {
          err(sw + ' — ' + feeder.id + " does not point back at this subpanel (its feeds is " +
            JSON.stringify(feeder.feeds) + ')');
        }
        if (feeder.role === Model.ROLE_BRANCH && !sp.mainBreaker) {
          warn(sw + ' — fed from a branch breaker but has no mainBreaker recorded; ' +
            'confirm where its disconnect actually is');
        }
      }
    }

    /* Appliance totals. The heat-kit case is the whole reason this is a rule:
     * three 50A handles feeding ONE 20 kW kit is 20 kW, and summing per
     * breaker would put 60 kW on the panel meter. Watts live on appliances,
     * never on the subpanel's breakers. */
    var applianceIds = Object.create(null);
    var appSum = 0;
    var unknownWatts = 0;
    (sp.appliances || []).forEach(function (a, ai) {
      var aw = sw + ' appliance ' + (a.id || '#' + ai);
      ['id', 'room', 'endpoint'].forEach(function (f) {
        if (!a[f]) err(aw + " — missing '" + f + "'");
      });
      if (a.id) {
        if (applianceIds[a.id]) err(aw + ' — duplicate appliance id');
        applianceIds[a.id] = false; /* flips true when a device claims it */
      }
      if (!('estimatedWatts' in a)) {
        err(aw + " — missing 'estimatedWatts' (use null if genuinely unknown)");
      } else if (a.estimatedWatts === null) {
        unknownWatts++;
        warn(aw + ' — no draw recorded, so it contributes 0 W and the subpanel total reads low');
      } else if (typeof a.estimatedWatts !== 'number') {
        err(aw + ' — estimatedWatts must be a number or null');
      } else {
        appSum += a.estimatedWatts;
      }
      if ('verified' in a && typeof a.verified !== 'boolean') {
        err(aw + ' — verified must be true or false');
      }
      if (a.verified === false) {
        warn(aw + ' — recorded but not confirmed; the app shows it as a guess');
      }
    });

    if (typeof sp.estimatedWattsTotal !== 'number') {
      err(sw + ' — estimatedWattsTotal must be a number');
    } else if (sp.estimatedWattsTotal !== appSum) {
      err(sw + ' — estimatedWattsTotal is ' + sp.estimatedWattsTotal +
        ' but its appliances sum to ' + appSum +
        ' (appliances carry the watts, never the breakers that feed them)');
    }

    /* Subpanel breakers. They must not carry watts of their own — that is the
     * double-count this schema exists to prevent. */
    var subDeviceIds = Object.create(null);
    (sp.devices || []).forEach(function (d, di) {
      var dw = sw + ' :: ' + (d.id || 'device #' + di);
      if (!d.id) err(dw + " — missing 'id'");
      else if (subDeviceIds[d.id] || seenIds[d.id]) {
        err(dw + ' — device id is not unique across the home');
      } else subDeviceIds[d.id] = true;

      if (!d.label) err(dw + " — missing 'label'");
      if (!('amps' in d)) err(dw + " — missing 'amps' (use null if unknown)");
      if ('estimatedWatts' in d || 'estimatedWattsTotal' in d) {
        err(dw + ' — subpanel breakers must not carry watts; put the load on the ' +
          'appliance they serve, or one appliance gets counted once per breaker');
      }
      (d.serves || []).forEach(function (aid) {
        if (!(aid in applianceIds)) {
          err(dw + " — serves '" + aid + "', which is not an appliance of this subpanel");
        } else {
          applianceIds[aid] = true;
        }
      });
      if (!(d.serves || []).length) {
        warn(dw + ' — serves nothing; the breaker is recorded but its load is not');
      }
    });

    Object.keys(applianceIds).forEach(function (aid) {
      if (!applianceIds[aid]) {
        warn(sw + " — appliance '" + aid + "' is not claimed by any subpanel breaker; " +
          'which one feeds it is unrecorded');
      }
    });

    if (!sp.mainBreaker && !sp.disconnectArrangement) {
      warn(sw + ' — no mainBreaker and no disconnectArrangement; a reader cannot tell ' +
        'how to kill power to it');
    }
  });

  /* ----------------------------------------------------- shed list sanity */

  scenarioKeys.forEach(function (k) {
    Object.keys(panels).forEach(function (p) {
      if (!Model.panelAvailable(data, k, p)) return;
      var sum = Model.loadSummary(data, p, k);
      if (sum.over) {
        warn(where + ' — scenario ' + k + ' / panel ' + p + ': ' + sum.remainingWatts +
          'W of connected load remains against a ' + sum.sourceWatts + 'W source (over by ' +
          sum.overBy + 'W). Not necessarily wrong, but the shed list may be incomplete.' +
          (sum.unsheddableWatts
            ? ' ' + sum.unsheddableWatts + 'W of that is behind a feed-through tap and ' +
              'cannot be shed at this panel at all.'
            : ''));
      }
    });
  });

  /* ------------------------------------------------------ open questions */

  (data.openQuestions || []).forEach(function (q) {
    if (!q.id) err(where + ' — an openQuestion is missing an id');
    (q.deviceIds || []).forEach(function (id) {
      if (!seenIds[id]) {
        err(where + " — openQuestion '" + q.id + "' references unknown device '" + id + "'");
      }
    });
    if (q.subpanelId && !Model.subpanelById(data, q.subpanelId)) {
      err(where + " — openQuestion '" + q.id + "' references unknown subpanel '" +
        q.subpanelId + "'");
    }
  });

  /* ----------------------------------------------------- safety warnings */

  (data.safetyWarnings || []).forEach(function (sw) {
    ['id', 'title', 'message', 'severity'].forEach(function (f) {
      if (!sw[f]) err(where + " — safetyWarning '" + (sw.id || '?') + "' missing '" + f + "'");
    });
    /* `panels` is optional and means "only these"; omitting it means "all". */
    if (sw.panels !== undefined) {
      if (!isArray(sw.panels)) {
        err(where + " — safetyWarning '" + sw.id + "' panels must be an array");
      } else {
        sw.panels.forEach(function (p) {
          if (!panels[p]) {
            err(where + " — safetyWarning '" + sw.id + "' names unknown panel '" + p + "'");
          }
        });
      }
    }
  });

  /* ------------------------------------------------------- walkthroughs */

  Object.keys(data.walkthroughSteps || {}).forEach(function (key) {
    var steps = data.walkthroughSteps[key];
    if (!isArray(steps)) {
      err(where + " — walkthroughSteps." + key + ' must be an array');
      return;
    }
    steps.forEach(function (s, i) {
      var sw = where + ' :: ' + key + ' step ' + (s.step != null ? s.step : i);
      ['title', 'instruction'].forEach(function (f) {
        if (!s[f]) err(sw + " — missing '" + f + "'");
      });
      if (s.breakersToTurnOff !== undefined &&
        s.breakersToTurnOff !== 'scenario-dependent' &&
        !isArray(s.breakersToTurnOff)) {
        err(sw + " — breakersToTurnOff must be 'scenario-dependent' or an array");
      }
      /* Missing photos are expected while the survey is in progress — the app
       * renders a placeholder. Warn so the gap stays visible. */
      if (s.image && !fileExists(s.image)) {
        warn(sw + ' — image not on disk yet: ' + s.image);
      }
    });
  });

  /* -------------------------------------------------- unassigned endpoints */

  (data.unassignedEndpoints || []).forEach(function (e, i) {
    var ew = where + ' :: unassignedEndpoints[' + i + ']';
    ['room', 'endpoint'].forEach(function (f) {
      if (!e[f]) err(ew + " — missing '" + f + "'");
    });
    if (e.panel || e.slot) {
      err(ew + ' — has a panel/slot, so it is no longer unassigned; move it into ' +
        "that device's circuits");
    }
  });
  if ((data.unassignedEndpoints || []).length) {
    warn(where + ' — ' + data.unassignedEndpoints.length +
      ' endpoint(s) have no known breaker; shown in search as "Breaker unknown"');
  }

  /* ---------------------------------------------------------- room aliases */

  var roomsUsed = Object.create(null);
  Model.allCircuits(data).forEach(function (c) { roomsUsed[c.room] = true; });
  Object.keys(data.roomAliases || {}).forEach(function (r) {
    if (!roomsUsed[r]) warn(where + " — roomAlias '" + r + "' matches no room in use");
  });

  return Object.keys(seenIds).length;
}

/* ------------------------------------------------- offline asset list check */

/* A single missing entry in sw.js ASSETS makes cache.addAll() reject, which
 * makes the service worker fail to install, which silently costs you ALL
 * offline support. So every listed path must exist. */
function checkServiceWorker() {
  var swPath = path.join(ROOT, 'sw.js');
  if (!fs.existsSync(swPath)) { err('sw.js — not found'); return; }
  var src = fs.readFileSync(swPath, 'utf8');
  var m = src.match(/ASSETS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) { err('sw.js — could not find an ASSETS array'); return; }

  var listed = m[1].match(/"([^"]+)"|'([^']+)'/g) || [];
  listed = listed.map(function (s) { return s.replace(/^['"]|['"]$/g, ''); });

  listed.forEach(function (rel) {
    if (rel === './' || rel === '.') return;
    if (!fileExists(rel)) {
      err('sw.js — ASSETS lists a file that does not exist: ' + rel +
        ' (cache.addAll would reject and offline support would break)');
    }
  });

  if (!/CACHE\s*=\s*["']blackstart-v\d+["']/.test(src)) {
    err('sw.js — CACHE must look like "blackstart-vN" so it can be bumped per deploy');
  }

  /* Every data file should be cached, or the app cannot start offline. */
  fs.readdirSync(DATA_DIR).filter(isJson).forEach(function (f) {
    var rel = 'data/' + f;
    if (listed.indexOf(rel) < 0) {
      err('sw.js — ASSETS is missing ' + rel + '; the app would not load it offline');
    }
  });

  /* Every src module should be cached too. */
  fs.readdirSync(path.join(ROOT, 'src')).filter(function (f) {
    return /\.js$/.test(f);
  }).forEach(function (f) {
    var rel = 'src/' + f;
    if (listed.indexOf(rel) < 0) {
      err('sw.js — ASSETS is missing ' + rel);
    }
  });

  return listed.length;
}

function isJson(f) { return /\.json$/.test(f); }

/* ------------------------------------------------------------- icon check */

/* index.html and install.html reference apple-touch-icon.png, and iOS ignores
 * manifest icons for the home screen. Without these the installed app gets a
 * screenshot of the page as its icon. Generated by `npm run icons`. */
function checkIcons() {
  ['assets/apple-touch-icon.png', 'assets/icon-192.png', 'assets/icon-512.png']
    .forEach(function (rel) {
      if (!fileExists(rel)) {
        warn(rel + ' — missing; run `npm run icons` and commit the result ' +
          '(GitHub Pages serves the repo directly, so it must be checked in)');
      }
    });
}

/* -------------------------------------------------------------------- main */

var files = fs.readdirSync(DATA_DIR).filter(isJson);
if (files.length === 0) err('data/ — no .json home files found');

var deviceCount = 0;
files.forEach(function (f) {
  var raw;
  try {
    raw = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
  } catch (e) {
    err('data/' + f + ' — unreadable: ' + e.message);
    return;
  }
  var data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    err('data/' + f + ' — invalid JSON: ' + e.message);
    return;
  }
  deviceCount += checkHome(data, 'data/' + f);
});

var assetCount = checkServiceWorker();
checkIcons();

warnings.forEach(function (w) { console.log('warn  ' + w); });
errors.forEach(function (e) { console.log('ERROR ' + e); });

console.log('');
console.log(files.length + ' home file(s), ' + deviceCount + ' device(s), ' +
  assetCount + ' cached asset(s) — ' + errors.length + ' error(s), ' +
  warnings.length + ' warning(s)');

process.exit(errors.length ? 1 : 0);
