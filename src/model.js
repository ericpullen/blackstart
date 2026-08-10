/* model.js — the data layer for Blackstart.
 *
 * Shared verbatim between the browser (window.Model) and Node
 * (scripts/validate.js requires it). Keep it free of DOM access.
 *
 * The core idea of the schema: one entry in `devices` per PHYSICAL BREAKER.
 * A 2-pole breaker is ONE device occupying two slots, because it has one
 * handle and trips as a unit. Circuits nest underneath a device. Any code
 * that reasons about "what happens when I flip this" must reason in devices,
 * never in slots.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Model = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = 2;

  /* Roles a device can play. Only `branch` is a load.
   *
   * `feedThrough` is NOT a breaker. It is a bus tap — a plug-on lug accessory
   * that occupies breaker positions but has no handle, no ampacity of its own
   * and no overcurrent protection. Everything downstream of it is protected
   * only by the panel main. It cannot be switched off, so it can never appear
   * in a shed list, and its downstream load is charged to the panel as
   * UNSHEDDABLE. What it feeds lives in data.subpanels, linked by `feeds`. */
  var ROLE_BRANCH = 'branch';
  var ROLE_INLET = 'generatorInlet';
  var ROLE_FEEDTHROUGH = 'feedThrough';

  /* ---------------------------------------------------------------- indexing */

  /* Build lookup tables once, then read from them everywhere. Returns the
   * same object shape whether the data came from fetch() or fs.readFileSync(). */
  function index(data) {
    var deviceById = Object.create(null);
    var slots = Object.create(null); /* panel -> slot -> {device, primary} */

    Object.keys(data.panels || {}).forEach(function (p) {
      slots[p] = Object.create(null);
    });

    (data.devices || []).forEach(function (d) {
      deviceById[d.id] = d;
      if (!slots[d.panel]) slots[d.panel] = Object.create(null);
      (d.slots || []).forEach(function (s, i) {
        slots[d.panel][s] = { device: d, primary: i === 0 };
      });
    });

    return { data: data, deviceById: deviceById, slots: slots };
  }

  function devicesIn(data, panel) {
    return (data.devices || []).filter(function (d) { return d.panel === panel; });
  }

  function isLoad(device) {
    return device.role === ROLE_BRANCH;
  }

  function isFeedThrough(device) {
    return device.role === ROLE_FEEDTHROUGH;
  }

  /* ---------------------------------------------------------------- subpanels */

  /* A subpanel hangs off a device in a parent panel — here, off a feed-through
   * lug with no handle. Its loads are real load on the parent panel but cannot
   * be shed there, so they are tracked separately and added back in
   * loadSummary rather than being folded into a device's circuits. */
  function subpanels(data) {
    return data.subpanels || [];
  }

  function subpanelById(data, id) {
    return subpanels(data).filter(function (s) { return s.id === id; })[0] || null;
  }

  function subpanelsFedFrom(data, panel) {
    return subpanels(data).filter(function (s) {
      return ((s.fedFrom || {}).panel) === panel;
    });
  }

  /* The subpanel fed by a given device, or null. */
  function subpanelOfDevice(data, device) {
    if (!device || !device.feeds) return null;
    return subpanelById(data, device.feeds);
  }

  /* Connected load below a subpanel. Read from estimatedWattsTotal, which the
   * validator pins to the sum of the APPLIANCES — never to the sum of the
   * breakers. Three 50A handles feeding one 20 kW heat kit is 20 kW, not 60. */
  function subpanelWatts(subpanel) {
    return (subpanel && subpanel.estimatedWattsTotal) || 0;
  }

  /* Appliances with no recorded draw contribute nothing, exactly like an
   * untraced breaker — so say how many there are instead of quietly rounding
   * the total down to something reassuring. */
  function subpanelUnknownAppliances(subpanel) {
    return ((subpanel || {}).appliances || []).filter(function (a) {
      return a.estimatedWatts === null || a.estimatedWatts === undefined;
    });
  }

  /* ------------------------------------------------------- slot reconciliation */

  /* Every slot is in exactly one of three states, and conflating the last two is
   * how you end up telling someone a breaker isn't there when nobody ever looked:
   *
   *   occupied   — a device claims it
   *   empty      — declared in panels[x].emptySlots; verified to have no breaker
   *   unaccounted— neither; we simply do not know
   *
   * A panel is fully surveyed when nothing is unaccounted for. That is derived,
   * not stored, so it cannot drift from the device list. */
  function slotState(data, panel, slot) {
    var idx = index(data);
    return slotStateFrom(idx, data, panel, slot);
  }

  function slotStateFrom(idx, data, panel, slot) {
    if ((idx.slots[panel] || {})[slot]) return 'occupied';
    var declared = ((data.panels || {})[panel] || {}).emptySlots || [];
    return declared.indexOf(slot) >= 0 ? 'empty' : 'unaccounted';
  }

  function surveyStatus(data, panel) {
    var panelDef = (data.panels || {})[panel] || {};
    var total = panelDef.slots || 0;
    var idx = index(data);
    var counts = { occupied: 0, empty: 0, unaccounted: 0 };
    for (var s = 1; s <= total; s++) counts[slotStateFrom(idx, data, panel, s)]++;
    counts.total = total;
    counts.surveyed = counts.unaccounted === 0;
    return counts;
  }

  /* ------------------------------------------------------------------ labels */

  function displayRoom(data, room) {
    var aliases = data.roomAliases || {};
    return aliases[room] || room;
  }

  /* "Dryer outlet (30A)" — the form used in shed lists and step tags. */
  function deviceLabel(device) {
    return device.label + ' (' + device.amps + 'A)';
  }

  /* "1,3" for a 2-pole, "9" for a single. */
  function slotLabel(device) {
    return (device.slots || []).join(',');
  }

  /* True when the label is still a machine-generated stand-in and a human
   * should rewrite it. Surfaced in the UI so placeholders don't read as fact. */
  function needsLabelReview(device) {
    return device.labelSource === 'placeholder' ||
      /^auto-generated/.test(device.labelSource || '');
  }

  /* A device is unverified if its hardware was never photographed, or the
   * panel it sits in carries an explicit low confidence. */
  function isUnverified(device) {
    var hw = device.hardware || {};
    return hw.photoVerified === false ||
      hw.confidence === 'unverified' ||
      hw.confidence === 'low';
  }

  /* ---------------------------------------------------------------- circuits */

  /* Flatten a device's circuits, inheriting the fields that live on the
   * device (amps, panel, poles) so a circuit row is self-contained.
   * `priority` resolves circuit-first, then device. */
  function circuitsOf(data, device) {
    return (device.circuits || []).map(function (c, i) {
      return {
        deviceId: device.id,
        circuitIndex: i,
        panel: device.panel,
        amps: device.amps,
        poles: device.poles,
        slots: device.slots,
        slotLabel: slotLabel(device),
        deviceLabel: device.label,
        circuitType: device.circuitType,
        physicalMarking: device.physicalMarking,
        hardware: device.hardware || {},
        room: c.room,
        displayRoom: displayRoom(data, c.room),
        endpoint: c.endpoint,
        estimatedWatts: c.estimatedWatts,
        fedFromSlot: c.fedFromSlot,
        voltage: c.voltage || (device.poles === 2 ? '240V' : '120V'),
        notes: c.notes || null,
        priority: c.priority || device.priority || null,
        /* Per-circuit provenance from the breaker walk-through. Absent means
         * never recorded, which is different from recorded-and-failed. */
        verified: c.verified === undefined ? null : c.verified,
        verificationMethod: c.verificationMethod || null,
        unmapped: false
      };
    });
  }

  /* Every circuit in the home, for search. Inlet breakers are not loads and
   * are deliberately excluded — they are not something you "find".
   *
   * `unassignedEndpoints` ARE included, as rows with no breaker. Someone
   * searching "driveway" needs to learn that we don't know its breaker; an
   * empty result would imply the outlet doesn't exist. */
  function allCircuits(data) {
    var out = [];
    (data.devices || []).forEach(function (d) {
      if (!isLoad(d)) return;
      out = out.concat(circuitsOf(data, d));
    });
    return out.concat(subpanelCircuits(data)).concat(unmappedCircuits(data));
  }

  /* Appliances behind a subpanel are searchable like anything else. Someone
   * typing "heat" during an outage has to be able to find the 20 kW heat kit
   * and learn that no breaker in the garage switches it off. */
  function subpanelCircuits(data) {
    var out = [];
    subpanels(data).forEach(function (sp) {
      var feed = ((data.devices || []).filter(function (d) {
        return d.id === (sp.fedFrom || {}).deviceId;
      })[0]) || null;

      (sp.appliances || []).forEach(function (a, i) {
        out.push({
          deviceId: null,
          subpanelId: sp.id,
          applianceIndex: i,
          circuitIndex: i,
          panel: (sp.fedFrom || {}).panel || null,
          amps: null,
          poles: null,
          slots: [],
          slotLabel: feed ? slotLabel(feed) : '?',
          deviceLabel: sp.name,
          circuitType: 'subpanel load (no breaker in the parent panel)',
          physicalMarking: null,
          hardware: {},
          room: a.room,
          displayRoom: displayRoom(data, a.room),
          endpoint: a.endpoint,
          estimatedWatts: a.estimatedWatts === undefined ? null : a.estimatedWatts,
          fedFromSlot: null,
          voltage: a.voltage || '240V',
          notes: a.notes || null,
          priority: a.priority || null,
          verified: a.verified === undefined ? null : a.verified,
          verificationMethod: a.verificationMethod || null,
          model: a.model || null,
          unmapped: false,
          unsheddable: true
        });
      });
    });
    return out;
  }

  function unmappedCircuits(data) {
    return (data.unassignedEndpoints || []).map(function (e, i) {
      return {
        deviceId: null,
        circuitIndex: i,
        unmappedIndex: i,
        panel: null,
        amps: null,
        poles: null,
        slots: [],
        slotLabel: '?',
        deviceLabel: 'Breaker unknown',
        circuitType: null,
        physicalMarking: null,
        hardware: {},
        room: e.room,
        displayRoom: displayRoom(data, e.room),
        endpoint: e.endpoint,
        estimatedWatts: null,
        fedFromSlot: null,
        voltage: null,
        notes: e.notes || null,
        priority: null,
        verified: false,
        verificationMethod: null,
        unmapped: true
      };
    });
  }

  /* Lowercased haystack for the search box. Includes the things people
   * actually type: room, alias, endpoint, notes, breaker id, catalog number
   * and any physical marking ("orange tape"). */
  function searchText(circuit) {
    return [
      circuit.room,
      circuit.displayRoom,
      circuit.endpoint,
      circuit.notes || '',
      circuit.deviceLabel,
      circuit.panel || '',
      circuit.panel ? circuit.panel + '-' + circuit.slotLabel : '',
      circuit.slotLabel,
      circuit.physicalMarking || '',
      circuit.hardware.catalogNumber || '',
      circuit.model || '',
      circuit.unmapped ? 'unknown unmapped untraced not traced' : '',
      circuit.unsheddable ? 'subpanel no breaker cannot be switched off' : ''
    ].join(' ').toLowerCase();
  }

  /* --------------------------------------------------------------- scenarios */

  function panelAvailable(data, scenarioKey, panel) {
    var sc = (data.scenarios || {})[scenarioKey] || {};
    var avail = sc.panelsAvailable || [];
    return avail.indexOf(panel) >= 0;
  }

  /* Devices to shed in a scenario, derived from devices[].shedIn.
   * shedIn on the device is the single source of truth — there is no
   * per-scenario list to keep in sync. */
  function shedDevices(data, scenarioKey, panel) {
    return (data.devices || []).filter(function (d) {
      if (panel && d.panel !== panel) return false;
      return (d.shedIn || []).indexOf(scenarioKey) >= 0;
    });
  }

  function sumWatts(devices) {
    return devices.reduce(function (n, d) {
      return n + (d.estimatedWattsTotal || 0);
    }, 0);
  }

  /* Load planning for one panel in one scenario.
   *
   * IMPORTANT: these are CONNECTED load estimates — the sum of what is wired
   * to each breaker — not a prediction of simultaneous draw. Nothing here
   * measures anything. It answers "if all of this ran at once, how far past
   * the source am I?", which is the useful question when deciding what to
   * shed. Treat `over` as a planning flag, not a trip prediction.
   */
  function loadSummary(data, panel, scenarioKey) {
    var panelDef = (data.panels || {})[panel] || {};
    var source = (data.backupSources || {})[panelDef.backupSource] || {};
    var loads = devicesIn(data, panel).filter(isLoad);
    var shed = shedDevices(data, scenarioKey, panel);
    var shedIds = shed.map(function (d) { return d.id; });

    var remaining = loads.filter(function (d) {
      return shedIds.indexOf(d.id) < 0;
    });

    /* Load that hangs off a feed-through tap is real load on this panel, but
     * no breaker here can remove it. It survives every shed list by
     * construction, so it goes into `remaining` unconditionally — and it is
     * reported separately, because "you cannot turn this off from here" is a
     * different instruction from "turn this off". */
    var subs = subpanelsFedFrom(data, panel);
    var unsheddableWatts = subs.reduce(function (n, s) {
      return n + subpanelWatts(s);
    }, 0);
    var unknownSubAppliances = subs.reduce(function (list, s) {
      return list.concat(subpanelUnknownAppliances(s));
    }, []);

    var connectedWatts = sumWatts(loads) + unsheddableWatts;
    var shedWatts = sumWatts(shed);
    var remainingWatts = sumWatts(remaining) + unsheddableWatts;
    var sourceWatts = source.maxOutputWatts || 0;

    /* Breakers that are installed but have no circuits traced contribute 0 W,
     * so the total reads LOW by an unknown margin. Surface that alongside the
     * number, or the meter quietly lies in the reassuring direction — which is
     * the worst direction for a load figure to lie in. */
    var untraced = remaining.filter(function (d) {
      return !d.circuits || d.circuits.length === 0;
    });
    var untracedAmps = untraced.reduce(function (n, d) { return n + (d.amps || 0); }, 0);
    /* If any untraced device has no readable rating, the amp figure itself is a
     * floor, not a total. Say so rather than quoting it as if it were complete. */
    var untracedAmpsPartial = untraced.some(function (d) {
      return d.amps === null || d.amps === undefined;
    });

    return {
      untracedDevices: untraced,
      untracedAmps: untracedAmps,
      untracedAmpsPartial: untracedAmpsPartial,
      panel: panel,
      sourceName: source.name || null,
      sourceShortName: source.shortName || source.name || null,
      capacityKwh: source.capacityKwh || null,
      sourceWatts: sourceWatts,
      connectedWatts: connectedWatts,
      shedWatts: shedWatts,
      remainingWatts: remainingWatts,
      shedDevices: shed,
      subpanels: subs,
      unsheddableWatts: unsheddableWatts,
      unknownSubpanelAppliances: unknownSubAppliances,
      over: sourceWatts > 0 && remainingWatts > sourceWatts,
      overBy: Math.max(0, remainingWatts - sourceWatts),
      /* 0..1 for a meter; clamped so a 3x overage still renders */
      ratio: sourceWatts > 0 ? Math.min(remainingWatts / sourceWatts, 1) : 0
    };
  }

  /* --------------------------------------------------------- open questions */

  /* Device id -> the open questions that name it, so the UI can badge a
   * breaker whose data is disputed instead of presenting it as settled. */
  function questionsByDevice(data) {
    var map = Object.create(null);
    (data.openQuestions || []).forEach(function (q) {
      (q.deviceIds || []).forEach(function (id) {
        if (!map[id]) map[id] = [];
        map[id].push(q);
      });
    });
    return map;
  }

  var SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };

  function sortedQuestions(data) {
    return (data.openQuestions || []).slice().sort(function (a, b) {
      var sa = SEVERITY_ORDER[a.severity] != null ? SEVERITY_ORDER[a.severity] : 9;
      var sb = SEVERITY_ORDER[b.severity] != null ? SEVERITY_ORDER[b.severity] : 9;
      if (sa !== sb) return sa - sb;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    ROLE_BRANCH: ROLE_BRANCH,
    ROLE_INLET: ROLE_INLET,
    ROLE_FEEDTHROUGH: ROLE_FEEDTHROUGH,
    index: index,
    devicesIn: devicesIn,
    isLoad: isLoad,
    isFeedThrough: isFeedThrough,
    subpanels: subpanels,
    subpanelById: subpanelById,
    subpanelsFedFrom: subpanelsFedFrom,
    subpanelOfDevice: subpanelOfDevice,
    subpanelWatts: subpanelWatts,
    subpanelUnknownAppliances: subpanelUnknownAppliances,
    subpanelCircuits: subpanelCircuits,
    slotState: slotState,
    surveyStatus: surveyStatus,
    unmappedCircuits: unmappedCircuits,
    displayRoom: displayRoom,
    deviceLabel: deviceLabel,
    slotLabel: slotLabel,
    needsLabelReview: needsLabelReview,
    isUnverified: isUnverified,
    circuitsOf: circuitsOf,
    allCircuits: allCircuits,
    searchText: searchText,
    panelAvailable: panelAvailable,
    shedDevices: shedDevices,
    sumWatts: sumWatts,
    loadSummary: loadSummary,
    questionsByDevice: questionsByDevice,
    sortedQuestions: sortedQuestions
  };
});
