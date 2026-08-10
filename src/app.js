/* app.js — UI for Blackstart.
 *
 * Reads home data through Model (src/model.js) and renders four views.
 * Nothing here computes electrical facts; that all lives in Model so the
 * Node validator can check the same logic the app runs.
 *
 * Two rules that matter:
 *
 *  1. NEVER interpolate data into an inline event handler attribute. The old
 *     version serialized a circuit object into onclick='...' and any apostrophe
 *     in the data (a room called "Jordan's Room") silently broke the handler.
 *     Everything here is delegated and addressed by data-id attributes.
 *  2. ALWAYS run data through esc() on the way into innerHTML.
 */
(function () {
  'use strict';

  var DATA_URL = 'data/montfort.json';
  var THEME_KEY = 'blackstart-theme';

  var state = {
    data: null,
    idx: null,
    filter: 'all',
    scenario: 'truckHome',
    panel: 'A',
    completed: { panelA: [], panelB: [] },
    zoom: 1
  };

  /* ------------------------------------------------------------- utilities */

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function watts(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + ' kW';
    return n + ' W';
  }

  /* Device-level notes are an array, circuit-level notes a string. Normalize. */
  function noteList(n) {
    if (!n) return [];
    return (Object.prototype.toString.call(n) === '[object Array]') ? n : [n];
  }

  var ICONS = {
    unplug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 01-12 0V8z"/><path d="M12 17v5"/>',
    'breaker-off': '<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M5 20h14"/>',
    'breaker-on': '<path d="M12 20V9"/><path d="M8 13l4-4 4 4"/><path d="M5 4h14"/>',
    'main-off': '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
    connect: '<path d="M10 13a5 5 0 007.07 0l3-3a5 5 0 00-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 00-7.07 0l-3 3a5 5 0 007.07 7.07l1.5-1.5"/>',
    'power-on': '<path d="M18.36 6.64A9 9 0 1 1 5.64 6.64"/><path d="M12 2v10"/>',
    verify: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
    truck: '<path d="M3 17V7h11v10"/><path d="M14 10h4l3 3v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
    battery: '<rect x="2" y="8" width="17" height="9" rx="2"/><path d="M22 11v3"/>',
    charging: '<rect x="2" y="8" width="17" height="9" rx="2"/><path d="M22 11v3"/><path d="M10 10l-2 3h3l-2 3"/>'
  };

  function icon(name) {
    if (!name || !ICONS[name]) return '';
    return '<svg class="step-icon" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">' +
      ICONS[name] + '</svg>';
  }

  /* --------------------------------------------------------------- booting */

  function boot() {
    if (!document.documentElement.getAttribute('data-theme')) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }

    fetch(DATA_URL, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data.schemaVersion !== Model.SCHEMA_VERSION) {
          throw new Error('This data file is schemaVersion ' + data.schemaVersion +
            ' but the app expects ' + Model.SCHEMA_VERSION +
            '. Update the app or the data file — do not trust a partial render.');
        }
        state.data = data;
        state.idx = Model.index(data);
        render();
      })
      .catch(function (e) {
        fatal(e && e.message ? e.message : String(e));
      });
  }

  /* A data problem must be loud. A half-rendered panel schedule is worse than
   * no panel schedule when someone is standing at the breaker box. */
  function fatal(msg) {
    var main = document.querySelector('.main');
    if (!main) return;
    main.innerHTML =
      '<div class="fatal">' +
      '<h2>Could not load home data</h2>' +
      '<p>' + esc(msg) + '</p>' +
      '<p class="fatal-hint">If you opened this file directly, serve it over HTTP instead ' +
      '(<code>npm start</code>) — <code>fetch()</code> does not work from <code>file://</code>.</p>' +
      '</div>';
  }

  function render() {
    renderHome();
    renderCircuitList('');
    renderPanel('A');
    renderPanel('B');
    renderOpenQuestions();
    renderWalkthrough();
  }

  /* ------------------------------------------------------------------ home */

  function renderHome() {
    var d = state.data;
    var host = el('home-status');
    if (host) {
      host.innerHTML = Object.keys(d.panels).map(function (p) {
        var panel = d.panels[p];
        var src = d.backupSources[panel.backupSource] || {};
        var stats = [];
        if (src.capacityKwh) stats.push(src.capacityKwh + ' kWh stored');
        if (src.maxOutputWatts) stats.push(watts(src.maxOutputWatts) + ' max');
        return '<div class="status-card">' +
          '<div class="card-top"><span class="panel-chip ' + esc(p.toLowerCase()) + '">' +
          esc(p) + '</span>' + esc(panel.name) + '</div>' +
          '<div class="src-name">' + esc(src.name || 'No backup source') + '</div>' +
          (stats.length ? '<div class="src-stats">' + esc(stats.join(' · ')) + '</div>' : '') +
          (src.connectionType ? '<div class="src-loc">' + esc(src.connectionType) + '</div>' : '') +
          (panel.slotsSurveyed === false ? '<div class="card-flag">Not surveyed</div>' : '') +
          '</div>';
      }).join('');
    }

    var sub = el('home-subtitle');
    if (sub) sub.textContent = d.home.name + ' emergency power reference';

    var stamp = el('data-stamp');
    if (stamp) {
      var when = (d.metadata || {}).lastUpdated;
      stamp.textContent = when ? 'Offline copy — data as of ' + when : '';
    }
  }

  /* ---------------------------------------------------------------- search */

  function circuitRows() {
    var rows = Model.allCircuits(state.data);

    if (state.filter === 'A' || state.filter === 'B') {
      rows = rows.filter(function (c) { return c.panel === state.filter; });
    } else if (state.filter === 'critical') {
      rows = rows.filter(function (c) { return c.priority === 'critical'; });
    }
    return rows;
  }

  function renderCircuitList(query) {
    var list = el('circuit-list');
    if (!list) return;
    var q = (query || '').toLowerCase().trim();
    var rows = circuitRows();

    if (q) {
      rows = rows.filter(function (c) { return Model.searchText(c).indexOf(q) >= 0; });
    }

    rows.sort(function (a, b) {
      if (a.displayRoom !== b.displayRoom) return a.displayRoom.localeCompare(b.displayRoom);
      return a.endpoint.localeCompare(b.endpoint);
    });

    if (!rows.length) {
      list.innerHTML = '<div class="empty-state">' +
        '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" ' +
        'stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 ' +
        '10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><p>No circuits found</p></div>';
      return;
    }

    list.innerHTML = rows.map(function (c) {
      var tags = [];
      if (c.priority === 'critical') tags.push('<span class="tag critical">Critical</span>');
      if (c.estimatedWatts) tags.push('<span class="tag watts">' + esc(watts(c.estimatedWatts)) + '</span>');
      if (c.voltage === '240V') tags.push('<span class="tag volts">240V</span>');
      if (c.verified === false && !c.unmapped) {
        tags.push('<span class="tag unverified">Unconfirmed</span>');
      }

      /* Loads behind a subpanel get a row too, flagged so nobody goes looking
       * for a breaker in the garage that does not exist. */
      if (c.subpanelId) {
        tags.push('<span class="tag untraced">No breaker in Panel ' + esc(c.panel) + '</span>');
        return '<button type="button" class="circuit-item subpanel-item"' +
          ' data-subpanel="' + esc(c.subpanelId) + '">' +
          '<div class="circuit-header">' +
          '<span class="circuit-endpoint">' + esc(c.endpoint) + '</span>' +
          '<span class="circuit-breaker">' + esc(c.panel + '-' + c.slotLabel) + '</span>' +
          '</div>' +
          '<div class="circuit-room">' + esc(c.displayRoom) + '</div>' +
          '<div class="circuit-tags">' + tags.join('') + '</div>' +
          '</button>';
      }

      /* An endpoint with no known breaker still gets a row. Hiding it would
       * imply it doesn't exist; the honest answer is "we don't know yet". */
      if (c.unmapped) {
        return '<button type="button" class="circuit-item unmapped"' +
          ' data-unmapped="' + c.unmappedIndex + '">' +
          '<div class="circuit-header">' +
          '<span class="circuit-endpoint">' + esc(c.endpoint) + '</span>' +
          '<span class="circuit-breaker">?</span>' +
          '</div>' +
          '<div class="circuit-room">' + esc(c.displayRoom) + '</div>' +
          '<div class="circuit-tags"><span class="tag untraced">Breaker unknown</span></div>' +
          '</button>';
      }

      return '<button type="button" class="circuit-item' +
        (c.priority === 'critical' ? ' taped' : '') + '"' +
        ' data-device="' + esc(c.deviceId) + '" data-circuit="' + c.circuitIndex + '">' +
        '<div class="circuit-header">' +
        '<span class="circuit-endpoint">' + esc(c.endpoint) + '</span>' +
        '<span class="circuit-breaker">' + esc(c.panel + '-' + c.slotLabel) + '</span>' +
        '</div>' +
        '<div class="circuit-room">' + esc(c.displayRoom) + '</div>' +
        (tags.length ? '<div class="circuit-tags">' + tags.join('') + '</div>' : '') +
        '</button>';
    }).join('');
  }

  function showUnmapped(i) {
    var e = (state.data.unassignedEndpoints || [])[i];
    if (!e) return;
    var html = '<div class="modal-callout warn">No breaker has been identified for this yet. ' +
      'It is listed so you know it exists and is untraced, not because it is missing.</div>';
    html += detailRow('Room', esc(Model.displayRoom(state.data, e.room)));
    html += detailRow('Breaker', 'Unknown');
    if (e.notes) html += detailRow('Notes', esc(e.notes));
    html += '<div class="modal-callout">To trace it: switch breakers off one at a time and check ' +
      'this outlet. Good candidates are any breaker with no circuits recorded — see the open ' +
      'questions in the Panels view.</div>';
    openModal(e.endpoint, html);
  }

  /* ---------------------------------------------------------------- panels */

  function renderPanel(p) {
    var panel = state.data.panels[p];
    if (!panel) return;

    var head = el('panel-' + p.toLowerCase() + '-main');
    if (head) head.innerHTML = mainBreakerHtml(p, panel);

    var grid = el('panel-' + p.toLowerCase() + '-grid');
    if (!grid) return;

    var slots = state.idx.slots[p] || {};
    var questions = Model.questionsByDevice(state.data);
    var html = '';

    for (var row = 1; row <= panel.slots; row += 2) {
      html += slotHtml(row, slots[row], panel, questions, p);
      html += '<div class="breaker-divider"></div>';
      html += slotHtml(row + 1, slots[row + 1], panel, questions, p);
    }
    grid.innerHTML = html;

    renderSubpanels(p);
  }

  function mainBreakerHtml(p, panel) {
    var mb = panel.mainBreaker || {};
    var known = typeof mb.amps === 'number';
    return '<div class="main-breaker' + (known ? '' : ' unverified') + '">' +
      '<span class="main-breaker-label">MAIN</span>' +
      '<span class="main-breaker-value">' +
      (known ? esc(mb.amps + 'A ' + (mb.poles || 2) + '-pole') : 'Not recorded') +
      '</span>' +
      (mb.catalogNumber ? '<span class="main-breaker-part">' + esc(mb.catalogNumber) + '</span>' : '') +
      (mb.confidence && mb.confidence !== 'high'
        ? '<span class="badge warn" title="' + esc(mb.notes || '') + '">' + esc(mb.confidence) + '</span>'
        : '') +
      '</div>';
  }

  function slotHtml(slot, entry, panel, questions, panelKey) {
    /* Odd slots sit in the left column, even in the right — and the handle bar
     * is drawn on the center-facing edge, same as the physical panel. */
    var side = slot % 2 === 1 ? 'side-l' : 'side-r';

    /* No device here. "Declared empty" (we looked, nothing there) and
     * "unaccounted" (nobody looked) are different claims and must not both
     * render as "Empty". */
    if (!entry) {
      var declaredEmpty = (panel.emptySlots || []).indexOf(slot) >= 0;
      return '<div class="breaker-slot ' + side + ' ' + (declaredEmpty ? 'empty' : 'unsurveyed') + '">' +
        '<span class="slot-num">#' + slot + '</span>' +
        '<span class="slot-label">' + (declaredEmpty ? 'Empty' : 'Not surveyed') + '</span></div>';
    }

    var d = entry.device;

    /* The lower half of a 2-pole breaker. Not clickable — the handle is one
     * unit, so the top half owns the interaction. */
    if (!entry.primary) {
      /* A feed-through lug has no handle to be the other half OF, so say what
       * it actually is rather than pointing at a handle that isn't there. */
      var contLabel = Model.isFeedThrough(d) ? '↑ same lug' : '↑ same handle';
      return '<div class="breaker-slot continued ' + side +
        (d.role === Model.ROLE_INLET ? ' inlet-cont' : '') +
        (Model.isFeedThrough(d) ? ' feedthrough-cont' : '') + '">' +
        '<span class="slot-num">#' + slot + '</span>' +
        '<span class="slot-label">' + contLabel + '</span></div>';
    }

    var feedThrough = Model.isFeedThrough(d);
    var sub = feedThrough ? Model.subpanelOfDevice(state.data, d) : null;

    var cls = ['breaker-slot', side];
    if (d.role === Model.ROLE_INLET) cls.push('inlet');
    if (feedThrough) cls.push('feedthrough');
    if (d.priority === 'critical') cls.push('critical');
    if (!d.circuits || !d.circuits.length) {
      /* "untraced" means a breaker whose loads nobody followed. Neither the
       * inlet nor a feed-through lug is that — one is the source, the other
       * has its loads recorded on the subpanel it feeds. */
      if (d.role === Model.ROLE_BRANCH) cls.push('unknown-load');
    }
    if (d.poles === 2) cls.push('double-top');

    var badges = '';
    if (Model.isUnverified(d)) badges += '<span class="slot-badge unverified" title="Hardware not photo-verified">?</span>';
    if (questions[d.id]) badges += '<span class="slot-badge question" title="Has an open question">!</span>';

    /* amps can legitimately be null: an installed-but-unidentified device, or
     * a feed-through lug that has no rating because it has no handle. Those
     * are different claims and must not read the same. */
    var meta;
    if (feedThrough) {
      meta = 'NO HANDLE' + (sub ? ' · feeds ' + (sub.shortName || sub.name) : '');
    } else {
      meta = ((d.amps === null || d.amps === undefined) ? '?A' : d.amps + 'A') +
        (d.circuits && d.circuits.length > 1 ? ' · ' + d.circuits.length + ' loads' : '') +
        (d.role === Model.ROLE_BRANCH && (!d.circuits || !d.circuits.length) ? ' · untraced' : '');
    }

    return '<button type="button" class="' + cls.join(' ') + '" data-device="' + esc(d.id) + '">' +
      '<span class="slot-num">#' + slot + (d.poles === 2 ? '/' + d.slots[1] : '') + '</span>' +
      '<span class="slot-label">' + esc(d.label) + '</span>' +
      '<span class="slot-meta">' + esc(meta) + '</span>' + badges +
      '</button>';
  }

  function renderOpenQuestions() {
    var host = el('open-questions');
    if (!host) return;
    var qs = Model.sortedQuestions(state.data);
    if (!qs.length) { host.innerHTML = ''; return; }

    host.innerHTML = '<div class="section-header">Open Questions (' + qs.length + ')</div>' +
      '<p class="section-note">Things in this file that are unconfirmed or contradictory. ' +
      'Breakers named here carry a <span class="slot-badge question inline">!</span> in the grid.</p>' +
      qs.map(function (q) {
        return '<div class="question-card sev-' + esc(q.severity) + '">' +
          '<div class="question-head">' +
          '<span class="question-id">' + esc(q.id) + '</span>' +
          '<span class="tag sev-' + esc(q.severity) + '">' + esc(q.severity) + '</span>' +
          '</div>' +
          (q.recorded ? '<div class="question-row"><span>Recorded</span><span>' + esc(q.recorded) + '</span></div>' : '') +
          (q.observed ? '<div class="question-row"><span>Observed</span><span>' + esc(q.observed) + '</span></div>' : '') +
          '<p class="question-resolution">' + esc(q.resolution) + '</p>' +
          ((q.deviceIds || []).length
            ? '<div class="question-devices">' + q.deviceIds.map(function (id) {
              return '<button type="button" class="chip-link" data-device="' + esc(id) + '">' + esc(id) + '</button>';
            }).join('') + '</div>'
            : '') +
          '</div>';
      }).join('');
  }

  /* ---------------------------------------------------------------- modals */

  function openModal(title, html) {
    el('modal-title').textContent = title;
    el('modal-content').innerHTML = html;
    el('modal-overlay').classList.add('active');
  }

  function closeModal(event) {
    if (!event || event.target === el('modal-overlay')) {
      el('modal-overlay').classList.remove('active');
    }
  }

  function detailRow(label, value, extraClass) {
    return '<div class="detail-row"><span class="detail-label">' + esc(label) + '</span>' +
      '<span class="detail-value' + (extraClass ? ' ' + extraClass : '') + '">' + value + '</span></div>';
  }

  function showDevice(deviceId) {
    var d = state.idx.deviceById[deviceId];
    if (!d) return;
    var data = state.data;
    var panel = data.panels[d.panel] || {};
    var src = data.backupSources[panel.backupSource] || {};
    var hw = d.hardware || {};
    var questions = Model.questionsByDevice(data)[d.id] || [];

    var html = '';

    if (d.role === Model.ROLE_INLET) {
      html += '<div class="modal-callout">This is the backup feed, not a load. ' +
        'It is interlocked against the main breaker — they can never both be ON.</div>';
      html += inletConnectionHtml(panel);
    }
    var fedSub = Model.subpanelOfDevice(data, d);
    if (Model.isFeedThrough(d)) {
      html += '<div class="modal-callout warn"><strong>This is not a breaker.</strong> ' +
        'It is a plug-on lug that taps the bus and passes the feed straight through. ' +
        'There is no handle here and nothing to switch off. Everything downstream is ' +
        'protected only by this panel\'s ' +
        esc((panel.mainBreaker || {}).amps ? panel.mainBreaker.amps + 'A main' : 'main breaker') +
        '.' + (fedSub
          ? ' The only disconnect for those loads is inside the ' + esc(fedSub.name) +
            ' — ' + esc(fedSub.location) + '.'
          : '') + '</div>';
    }
    if (Model.needsLabelReview(d)) {
      html += '<div class="modal-callout warn">This breaker\'s label is a placeholder ' +
        '(' + esc(d.labelSource) + ') and still needs rewriting.</div>';
    }

    html += detailRow(Model.isFeedThrough(d) ? 'Position' : 'Breaker',
      esc(d.panel + '-' + Model.slotLabel(d)));
    html += detailRow('Panel', esc(panel.name || d.panel) + (panel.location ? ' · ' + esc(panel.location) : ''));
    html += detailRow('Rating', Model.isFeedThrough(d)
      ? esc('no overcurrent protection · ' + d.poles + ' pole-spaces')
      : esc((d.amps === null || d.amps === undefined
        ? 'amperage unknown' : d.amps + 'A') + ' · ' + d.poles + '-pole'));
    if (d.circuitType) html += detailRow('Type', esc(d.circuitType));
    if (d.equipment) {
      var eq = d.equipment;
      html += detailRow('Equipment', esc([eq.manufacturer, eq.model].filter(Boolean).join(' ') ||
        eq.description || '—'));
    }
    if (d.physicalMarking) {
      html += detailRow('Marking', esc(d.physicalMarking) +
        (d.physicalMarkingMeaning
          ? ' <span class="detail-hint">' + esc(d.physicalMarkingMeaning) + '</span>'
          : ''));
    }
    if (Model.isLoad(d)) {
      html += detailRow('Connected load', esc(watts(d.estimatedWattsTotal)) +
        ' <span class="detail-hint">estimated</span>');
    }
    if (src.name) html += detailRow('Backup source', esc(src.name));
    if ((d.shedIn || []).length) {
      html += detailRow('Turned off in', d.shedIn.map(function (k) {
        var sc = (data.scenarios || {})[k] || {};
        return '<span class="tag">' + esc(sc.shortName || sc.name || k) + '</span>';
      }).join(' '));
    }
    if (d.priority === 'critical') {
      html += detailRow('Priority', '⚠️ Critical load', 'critical-text');
    }

    /* circuits */
    if (d.circuits && d.circuits.length) {
      html += '<div class="detail-section">Feeds ' + d.circuits.length + ' load' +
        (d.circuits.length > 1 ? 's' : '') + '</div>';
      html += Model.circuitsOf(data, d).map(function (c) {
        return '<div class="circuit-line' + (c.priority === 'critical' ? ' critical' : '') + '">' +
          '<div class="circuit-line-head">' +
          '<span>' + esc(c.endpoint) + '</span>' +
          '<span class="circuit-line-watts">' + esc(watts(c.estimatedWatts)) + '</span>' +
          '</div>' +
          '<div class="circuit-line-sub">' + esc(c.displayRoom) +
          (c.fedFromSlot != null ? ' · slot ' + esc([].concat(c.fedFromSlot).join('/')) : '') +
          (c.verified === false ? ' · <span class="inline-warn">unconfirmed</span>' : '') +
          '</div>' +
          (c.notes ? '<div class="circuit-line-note">' + esc(c.notes) + '</div>' : '') +
          '</div>';
      }).join('');
    } else if (d.role === Model.ROLE_BRANCH) {
      html += '<div class="modal-callout warn">This breaker is installed but nothing is ' +
        'recorded on it yet. Trace it before relying on the panel schedule.</div>';
    }

    if (fedSub) html += subpanelHtml(fedSub);

    /* the appliance on the end of it, when we know what it is */
    if (d.equipment && (d.equipment.description || d.equipment.productUrl)) {
      html += '<div class="detail-section">Equipment</div>';
      if (d.equipment.description) {
        html += '<div class="modal-callout">' + esc(d.equipment.description) + '</div>';
      }
      /* Validated as https:// in validate.js — never render an unchecked href. */
      if (d.equipment.productUrl) {
        html += '<div class="modal-callout">Product page (needs a connection): ' +
          '<a class="ext-link" href="' + esc(d.equipment.productUrl) +
          '" rel="noreferrer noopener" target="_blank">' +
          esc(d.equipment.model || d.equipment.productUrl) + '</a></div>';
      }
    }

    /* hardware */
    html += '<div class="detail-section">Hardware</div>';
    if (hw.photoVerified === false) {
      html += '<div class="modal-callout warn">Not photo-verified. ' +
        esc(hw.notes || '') + '</div>';
    }
    if (hw.manufacturer) html += detailRow('Manufacturer', esc(hw.manufacturer));
    if (hw.catalogNumber) html += detailRow('Catalog number', esc(hw.catalogNumber));
    if (hw.breakerType) html += detailRow('Breaker type', esc(hw.breakerType));
    if (hw.voltage) html += detailRow('Voltage', esc(hw.voltage));
    if (hw.interruptRating) html += detailRow('Interrupt rating', esc(hw.interruptRating));
    if (hw.smartReplacement) {
      html += detailRow('Smart upgrade', esc(hw.smartReplacement) +
        ' <span class="detail-hint">drop-in metering replacement</span>');
    }

    noteList(d.notes).forEach(function (n) {
      html += '<div class="modal-callout">' + esc(n) + '</div>';
    });

    questions.forEach(function (q) {
      html += '<div class="modal-callout warn"><strong>' + esc(q.id) + '</strong> — ' +
        esc(q.resolution) + '</div>';
    });

    openModal(d.label, html);
  }

  /* What physically plugs into the inlet. The gender of the house-side
   * connector is the fact worth leading with: male pins mean an ordinary cord,
   * and the alternative is somebody improvising one with live exposed pins. */
  function inletConnectionHtml(panel) {
    var inlet = (panel || {}).generatorInlet || {};
    var c = inlet.connection;
    if (!c) return '';

    var cable = (state.data.cables || {})[inlet.cable];
    var html = '<div class="detail-section">What plugs in here</div>';

    if (c.location) html += detailRow('Where', esc(c.location));
    if (c.deviceType) html += detailRow('Inlet', esc(c.deviceType));
    if (c.configuration) html += detailRow('Configuration', esc(c.configuration));
    if (c.manufacturer || c.model) {
      html += detailRow('Part', esc([c.manufacturer, c.model].filter(Boolean).join(' ')) +
        (c.modelConfidence && c.modelConfidence !== 'high'
          ? ' <span class="detail-hint">model ' + esc(c.modelConfidence) + ' confidence</span>'
          : ''));
    }
    if (cable) {
      html += detailRow('Cable', esc(cable.name));
      html += '<div class="modal-callout">' + esc(cable.howItConnects || cable.ends) + '</div>';
    }
    if (c.notes) {
      html += '<div class="modal-callout' + (c.confidence === 'high' ? '' : ' warn') + '">' +
        esc(c.notes) + '</div>';
    }
    return html;
  }

  /* Everything downstream of a feed-through tap, rendered the same way in the
   * breaker modal and on the panel view. The load-bearing facts are: where the
   * disconnect physically is, that the parent panel has none, and that the
   * appliance total is NOT the sum of the breakers feeding it. */
  function subpanelHtml(sp) {
    var html = '<div class="detail-section">' + esc(sp.name) + '</div>';

    html += '<div class="modal-callout warn"><strong>No breaker in Panel ' +
      esc((sp.fedFrom || {}).panel || '?') + ' disconnects this.</strong> ' +
      esc(sp.disconnectArrangement || 'Its disconnecting means is inside the subpanel.') +
      ' Location: ' + esc(sp.location) + '.</div>';

    html += detailRow('Fed from', esc((sp.fedFrom || {}).panel + '-' +
      ((sp.fedFrom || {}).deviceId || '?').replace(/^[A-Z]-/, '')));
    if (sp.feeder) {
      html += detailRow('Feeder', esc(sp.feeder.conductor +
        (sp.feeder.ampacityAmps ? ' · ~' + sp.feeder.ampacityAmps + 'A' : '')));
      html += detailRow('Protected by', esc(sp.feeder.protectedBy || 'unknown'));
    }
    html += detailRow('Connected load', esc(watts(sp.estimatedWattsTotal)) +
      ' <span class="detail-hint">cannot be shed at the panel</span>');
    if (sp.enclosure && sp.enclosure.description) {
      html += detailRow('Enclosure', esc(sp.enclosure.description));
    }

    if ((sp.devices || []).length) {
      html += '<div class="detail-section">Breakers inside it</div>';
      html += (sp.devices || []).map(function (d) {
        var serves = (d.serves || []).map(function (aid) {
          var a = (sp.appliances || []).filter(function (x) { return x.id === aid; })[0];
          return a ? a.endpoint : aid;
        }).join(', ');
        return '<div class="circuit-line">' +
          '<div class="circuit-line-head"><span>' + esc(d.label) + '</span>' +
          '<span class="circuit-line-watts">' +
          esc((d.amps === null || d.amps === undefined ? '?' : d.amps + 'A') +
            (d.poles === 2 ? ' 2-pole' : '')) + '</span></div>' +
          (serves ? '<div class="circuit-line-sub">serves ' + esc(serves) + '</div>' : '') +
          noteList(d.notes).map(function (n) {
            return '<div class="circuit-line-note">' + esc(n) + '</div>';
          }).join('') +
          '</div>';
      }).join('');
    }

    if ((sp.appliances || []).length) {
      html += '<div class="detail-section">What it actually feeds</div>';
      html += (sp.appliances || []).map(function (a) {
        return '<div class="circuit-line">' +
          '<div class="circuit-line-head"><span>' + esc(a.endpoint) + '</span>' +
          '<span class="circuit-line-watts">' + esc(watts(a.estimatedWatts)) + '</span></div>' +
          '<div class="circuit-line-sub">' + esc(a.displayRoom || a.room) +
          (a.model ? ' · ' + esc(a.manufacturer ? a.manufacturer + ' ' + a.model : a.model) : '') +
          (a.verified === false ? ' · <span class="inline-warn">unconfirmed</span>' : '') +
          '</div>' +
          (a.rating ? '<div class="circuit-line-sub">' + esc(a.rating) + '</div>' : '') +
          (a.notes ? '<div class="circuit-line-note">' + esc(a.notes) + '</div>' : '') +
          '</div>';
      }).join('');
    }

    if (sp.monitoring && sp.monitoring.smartBreakerMonitorable === false) {
      html += '<div class="modal-callout"><strong>Not smart-breaker monitorable.</strong> ' +
        esc(sp.monitoring.reason) +
        (sp.monitoring.instrumentationPath ? ' ' + esc(sp.monitoring.instrumentationPath) : '') +
        '</div>';
    }

    noteList(sp.notes).forEach(function (n) {
      html += '<div class="modal-callout">' + esc(n) + '</div>';
    });

    return html;
  }

  function showSubpanel(id) {
    var sp = Model.subpanelById(state.data, id);
    if (!sp) return;
    openModal(sp.name, subpanelHtml(sp));
  }

  /* A card under the panel grid, because a reader standing at Panel B needs to
   * learn that part of this panel's load lives in another enclosure BEFORE
   * they conclude a breaker sweep switched everything off. */
  function renderSubpanels(p) {
    var host = el('panel-' + p.toLowerCase() + '-subpanels');
    if (!host) return;
    var subs = Model.subpanelsFedFrom(state.data, p);
    if (!subs.length) { host.innerHTML = ''; return; }

    host.innerHTML = subs.map(function (sp) {
      return '<button type="button" class="subpanel-card" data-subpanel="' + esc(sp.id) + '">' +
        '<div class="subpanel-head"><span class="subpanel-tag">Downstream subpanel</span>' +
        '<span class="subpanel-watts">' + esc(watts(sp.estimatedWattsTotal)) + '</span></div>' +
        '<div class="subpanel-name">' + esc(sp.name) + '</div>' +
        '<div class="subpanel-sub">Fed through ' +
        esc((sp.fedFrom || {}).deviceId || '?') + ' · ' + esc(sp.location) + '</div>' +
        '<div class="subpanel-warn">No breaker in Panel ' + esc(p) +
        ' can switch this off.</div>' +
        '</button>';
    }).join('');
  }

  function showCircuit(deviceId, circuitIndex) {
    var d = state.idx.deviceById[deviceId];
    if (!d) return;
    var rows = Model.circuitsOf(state.data, d);
    var c = rows[circuitIndex];
    if (!c) { showDevice(deviceId); return; }

    var data = state.data;
    var panel = data.panels[d.panel] || {};
    var src = data.backupSources[panel.backupSource] || {};

    var html = '';
    html += detailRow('Room', esc(c.displayRoom));
    html += detailRow('Breaker', esc(c.panel + '-' + c.slotLabel) + ' · ' + esc(d.label));
    html += detailRow('Rating', esc((d.amps === null || d.amps === undefined
      ? 'amperage unknown' : d.amps + 'A') + ' · ' + d.poles + '-pole · ' + c.voltage));
    html += detailRow('Est. draw', esc(watts(c.estimatedWatts)));
    if (src.name) html += detailRow('Backup source', esc(src.name));
    if (c.notes) html += detailRow('Notes', esc(c.notes));
    if (c.verified === true) {
      html += detailRow('Confirmed', 'Yes' + (c.verificationMethod ?
        ' <span class="detail-hint">' + esc(c.verificationMethod) + '</span>' : ''));
    } else if (c.verified === false) {
      html += detailRow('Confirmed', 'Not yet \u2014 treat as a guess', 'critical-text');
    }
    if (c.priority === 'critical') html += detailRow('Priority', '⚠️ Critical load', 'critical-text');

    if (d.poles === 2) {
      html += '<div class="modal-callout">This is a 2-pole, common-trip breaker covering slots ' +
        esc(Model.slotLabel(d)) + '. Turning it off also kills everything else on that handle.</div>';
    }
    if (d.circuits.length > 1) {
      html += '<div class="detail-section">Also on this breaker</div>';
      html += rows.filter(function (r, i) { return i !== circuitIndex; }).map(function (r) {
        return '<div class="circuit-line"><div class="circuit-line-head">' +
          '<span>' + esc(r.endpoint) + '</span>' +
          '<span class="circuit-line-watts">' + esc(watts(r.estimatedWatts)) + '</span>' +
          '</div><div class="circuit-line-sub">' + esc(r.displayRoom) + '</div></div>';
      }).join('');
    }

    html += '<button type="button" class="modal-action" data-device="' + esc(d.id) + '">' +
      'See the whole breaker</button>';

    openModal(c.endpoint, html);
  }

  /* ----------------------------------------------------------- walkthrough */

  var PANEL_OF = { panelA: 'A', panelB: 'B' };

  function renderWalkthrough() {
    var data = state.data;

    /* scenario buttons */
    var picker = el('scenario-selector');
    if (picker) {
      picker.innerHTML = Object.keys(data.scenarios).map(function (k) {
        var sc = data.scenarios[k];
        var kwh = sc.panelsAvailable.reduce(function (n, p) {
          var s = data.backupSources[(data.panels[p] || {}).backupSource] || {};
          return n + (s.capacityKwh || 0);
        }, 0);
        return '<button type="button" class="scenario-btn' + (k === state.scenario ? ' active' : '') +
          '" data-scenario="' + esc(k) + '">' +
          '<span class="scenario-tick"><svg fill="none" stroke="currentColor" stroke-width="3" ' +
          'stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">' +
          '<path d="M5 13l4 4L19 7"/></svg></span>' +
          '<h4>' + esc(sc.shortName || sc.name) + '</h4>' +
          '<p>' + esc(sc.name) + '</p>' +
          '<div class="capacity">' + esc(kwh ? kwh.toFixed(1) : '—') +
          ' <span class="cap-unit">kWh stored</span></div>' +
          '</button>';
      }).join('');
    }

    /* safety warnings straight from the data */
    var warn = el('safety-warnings');
    if (warn) {
      warn.innerHTML = (data.safetyWarnings || [])
        .filter(function (w) { return w.showInWalkthrough; })
        .map(function (w) {
          return '<div class="warning-box sev-' + esc(w.severity) + '">' +
            '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" ' +
            'stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 ' +
            '2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 ' +
            '1.732 3z"/></svg>' +
            '<div><h4>' + esc(w.title) + '</h4><p>' + esc(w.message) + '</p></div></div>';
        }).join('');
    }

    Object.keys(PANEL_OF).forEach(function (key) {
      var p = PANEL_OF[key];
      var section = el('section-' + key);
      var available = Model.panelAvailable(data, state.scenario, p);
      if (section) section.style.display = available ? 'block' : 'none';
      if (!available) return;

      var host = el('steps-' + key);
      if (host) {
        /* The first incomplete step is where the reader actually is. Light it. */
        var steps = data.walkthroughSteps[key] || [];
        var current = -1;
        for (var i = 0; i < steps.length; i++) {
          if (state.completed[key].indexOf(i) < 0) { current = i; break; }
        }
        host.innerHTML = steps.map(function (step, i) {
          return stepHtml(step, i, key, p, i === current);
        }).join('');
      }

      var loadHost = el('load-' + key);
      if (loadHost) loadHost.innerHTML = loadSummaryHtml(p);
    });

    updateProgress();
  }

  function loadSummaryHtml(p) {
    var s = Model.loadSummary(state.data, p, state.scenario);
    if (!s.sourceWatts) return '';

    var pct = Math.min(100, Math.round(s.ratio * 100));
    return '<div class="load-meter' + (s.over ? ' over' : '') + '">' +
      '<div class="load-head">' +
      '<div class="load-figure"><small>Connected after shedding</small>' +
      '<strong>' + esc(watts(s.remainingWatts)) + '</strong></div>' +
      '<div class="load-figure load-max"><small>' + esc(s.sourceShortName) + ' max output</small>' +
      esc(watts(s.sourceWatts)) + '</div>' +
      '</div>' +
      '<div class="load-bar"><div class="load-fill" style="width:' + pct + '%"></div></div>' +
      '<p class="load-note">' +
      (s.over
        ? '<strong>Over by ' + esc(watts(s.overBy)) + ' if everything runs at once.</strong> '
        : '') +
      'This is the sum of what is <em>wired</em> to the remaining breakers, not a measurement ' +
      'and not a prediction of simultaneous draw. Use it to decide what else to turn off.' +
      '</p>' +
      (s.shedDevices.length
        ? '<p class="load-note dim">Shedding ' + s.shedDevices.length + ' breaker' +
        (s.shedDevices.length > 1 ? 's' : '') + ' removes ' + esc(watts(s.shedWatts)) + '.</p>'
        : '<p class="load-note dim">No breakers are shed in this scenario.</p>') +
      /* Load behind a feed-through tap survives every shed list, because there
       * is no handle to throw. Saying so beside the number is the difference
       * between "shed more" and "you cannot shed this from here". */
      (s.unsheddableWatts
        ? '<p class="load-note untraced-warn">' + esc(watts(s.unsheddableWatts)) +
        ' of that is behind ' + (s.subpanels.length > 1 ? 'feed-through taps' :
          'the feed-through tap at ' + esc((s.subpanels[0].fedFrom || {}).deviceId)) +
        ' and <strong>no breaker in this panel can remove it</strong>' +
        (s.subpanels.length === 1
          ? ' — the only disconnect is inside the ' + esc(s.subpanels[0].name) + ', ' +
            esc(s.subpanels[0].location) + '.'
          : '.') +
        (s.unknownSubpanelAppliances.length
          ? ' ' + s.unknownSubpanelAppliances.length + ' load' +
            (s.unknownSubpanelAppliances.length > 1 ? 's' : '') +
            ' down there has no draw recorded, so even that figure is a floor.'
          : '') + '</p>'
        : '') +
      (s.untracedDevices.length
        ? '<p class="load-note untraced-warn">Reads LOW: ' + s.untracedDevices.length +
        ' breaker' + (s.untracedDevices.length > 1 ? 's' : '') + ' still on (' +
        esc(s.untracedAmps
          ? s.untracedAmps + 'A' + (s.untracedAmpsPartial ? '+' : '') + ' of capacity'
          : 'rating unknown') +
        ') have no loads traced, so they count as 0 W here.' +
        (s.untracedAmpsPartial
          ? ' One of them has no readable amp rating, so even that figure is a floor.'
          : '') + '</p>'
        : '') +
      '</div>';
  }

  function stepHtml(step, index, key, panel, isCurrent) {
    var done = state.completed[key].indexOf(index) >= 0;
    var html = '';

    var breakers = '';
    if (step.breakersToTurnOff === 'scenario-dependent') {
      var shed = Model.shedDevices(state.data, state.scenario, panel);
      breakers = shed.length
        ? '<div class="step-breakers">' + shed.map(function (d) {
          return '<span class="step-breaker-tag" data-device="' + esc(d.id) + '">' +
            esc(Model.deviceLabel(d)) + ' <em>' + esc(Model.slotLabel(d)) + '</em></span>';
        }).join('') + '</div>'
        : '<div class="step-breakers"><span class="step-breaker-tag none">Nothing to turn off</span></div>';
    } else if (Object.prototype.toString.call(step.breakersToTurnOff) === '[object Array]') {
      breakers = '<div class="step-breakers">' + step.breakersToTurnOff.map(function (id) {
        var d = state.idx.deviceById[id];
        return '<span class="step-breaker-tag"' + (d ? ' data-device="' + esc(d.id) + '"' : '') + '>' +
          esc(d ? Model.deviceLabel(d) : id) + '</span>';
      }).join('') + '</div>';
    }

    var image = '';
    if (step.image) {
      image = '<div class="step-image-container" data-image="' + esc(step.image) + '" ' +
        'data-image-title="' + esc(step.title) + '">' +
        '<img class="step-image" src="' + esc(step.image) + '" alt="' + esc(step.title) + '" ' +
        'loading="lazy" onerror="this.closest(\'.step-image-container\').classList.add(\'missing\')">' +
        '<div class="step-image-tap-hint">Tap to zoom</div>' +
        '<div class="step-image-placeholder">Photo not added yet — ' +
        esc(step.image.split('/').pop()) + '</div>' +
        '</div>';
    }

    html += '<div class="step-item' + (done ? ' completed' : '') + (isCurrent ? ' current' : '') +
      '" data-step="' + index + '" data-panel-key="' + esc(key) + '">' +
      '<button type="button" class="step-toggle" aria-pressed="' + done + '">' +
      '<span class="step-num">' +
      '<span class="num">' + esc(step.step != null ? step.step : index + 1) + '</span>' +
      '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/>' +
      '</svg></span>' +
      '<span class="step-content">' +
      '<span class="step-title">' + icon(step.icon) + esc(step.title) + '</span>' +
      '<span class="step-instruction">' + esc(step.instruction) + '</span>' +
      '</span></button>' +
      breakers +
      (step.warning ? '<div class="step-warning">' + esc(step.warning) + '</div>' : '') +
      image +
      '</div>';

    return html;
  }

  function toggleStep(key, index) {
    var arr = state.completed[key];
    var at = arr.indexOf(index);
    if (at >= 0) arr.splice(at, 1);
    else arr.push(index);
    renderWalkthrough();
  }

  function updateProgress() {
    Object.keys(PANEL_OF).forEach(function (key) {
      var bar = el('progress-' + key);
      if (!bar) return;
      var total = (state.data.walkthroughSteps[key] || []).length;
      var pct = total ? (state.completed[key].length / total) * 100 : 0;
      bar.style.width = pct + '%';
    });
  }

  function setScenario(k) {
    var any = state.completed.panelA.length || state.completed.panelB.length;
    if (any && k !== state.scenario &&
      !window.confirm('Switching scenarios will reset your progress. Continue?')) return;
    if (k !== state.scenario) state.completed = { panelA: [], panelB: [] };
    state.scenario = k;
    renderWalkthrough();
  }

  function resetWalkthrough() {
    state.completed = { panelA: [], panelB: [] };
    renderWalkthrough();
  }

  /* ----------------------------------------------------------- image modal */

  function openImage(src, title) {
    var img = el('image-modal-img');
    img.src = src;
    img.className = 'image-modal-img fit';
    img.style.transform = '';
    state.zoom = 1;
    el('image-modal-title').textContent = title || '';
    el('image-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
    var hint = el('image-modal-hint');
    hint.classList.remove('hidden');
    setTimeout(function () { hint.classList.add('hidden'); }, 3000);
  }

  function closeImage() {
    el('image-modal').classList.remove('active');
    document.body.style.overflow = '';
  }

  function setZoom(z) {
    var img = el('image-modal-img');
    state.zoom = Math.max(1, Math.min(z, 4));
    if (state.zoom === 1) {
      img.classList.remove('zoomed');
      img.classList.add('fit');
      img.style.transform = '';
    } else {
      img.classList.remove('fit');
      img.classList.add('zoomed');
      img.style.transform = 'scale(' + state.zoom + ')';
    }
  }

  /* ----------------------------------------------------------- navigation */

  var VIEWS = ['home-view', 'search-view', 'panels-view', 'walkthrough-view'];

  function showView(id) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    document.querySelectorAll('.nav-btn').forEach(function (b) { b.classList.remove('active'); });
    var view = el(id);
    if (view) view.classList.add('active');
    var btn = document.querySelector('[data-view="' + id + '"]');
    if (btn) btn.classList.add('active');
    window.scrollTo(0, 0);
  }

  function searchFor(term) {
    showView('search-view');
    el('search-input').value = term;
    renderCircuitList(term);
  }

  function setFilter(f) {
    state.filter = f;
    document.querySelectorAll('.chip[data-filter]').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-filter') === f);
    });
    renderCircuitList(el('search-input').value);
  }

  function showPanel(p) {
    state.panel = p;
    document.querySelectorAll('.tab-btn[data-panel]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-panel') === p);
    });
    ['A', 'B'].forEach(function (k) {
      var v = el('panel-' + k.toLowerCase() + '-visual');
      if (v) v.style.display = k === p ? 'block' : 'none';
    });
  }

  function toggleTheme() {
    var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  }

  /* ------------------------------------------------------------- listeners */

  function wire() {
    /* One delegated click handler. Data never touches an attribute handler. */
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || typeof t.closest !== 'function') return;

      var nav = t.closest('[data-view]');
      if (nav) { showView(nav.getAttribute('data-view')); return; }

      var chip = t.closest('.chip[data-filter]');
      if (chip) { setFilter(chip.getAttribute('data-filter')); return; }

      var tab = t.closest('.tab-btn[data-panel]');
      if (tab) { showPanel(tab.getAttribute('data-panel')); return; }

      var scen = t.closest('[data-scenario]');
      if (scen) { setScenario(scen.getAttribute('data-scenario')); return; }

      var quick = t.closest('[data-search]');
      if (quick) { searchFor(quick.getAttribute('data-search')); return; }

      var img = t.closest('[data-image]');
      if (img && !img.classList.contains('missing')) {
        openImage(img.getAttribute('data-image'), img.getAttribute('data-image-title'));
        return;
      }

      var stepBtn = t.closest('.step-toggle');
      if (stepBtn) {
        var item = stepBtn.closest('.step-item');
        toggleStep(item.getAttribute('data-panel-key'), Number(item.getAttribute('data-step')));
        return;
      }

      var un = t.closest('[data-unmapped]');
      if (un) { showUnmapped(Number(un.getAttribute('data-unmapped'))); return; }

      var subp = t.closest('[data-subpanel]');
      if (subp) { showSubpanel(subp.getAttribute('data-subpanel')); return; }

      /* A circuit row carries both a device and a circuit index. */
      var row = t.closest('[data-circuit]');
      if (row) {
        showCircuit(row.getAttribute('data-device'), Number(row.getAttribute('data-circuit')));
        return;
      }

      var dev = t.closest('[data-device]');
      if (dev) { showDevice(dev.getAttribute('data-device')); return; }

      if (t.closest('[data-action="reset"]')) { resetWalkthrough(); return; }
      if (t.closest('[data-action="theme"]')) { toggleTheme(); return; }
      if (t.closest('[data-action="close-modal"]')) { closeModal(); return; }
      if (t.closest('[data-action="close-image"]')) { closeImage(); return; }
      if (t.closest('[data-action="zoom-in"]')) { setZoom(state.zoom + 0.5); return; }
      if (t.closest('[data-action="zoom-out"]')) { setZoom(state.zoom - 0.5); return; }
      /* closest, not id — the tap usually lands on the <img> inside. */
      if (t.closest('#image-modal-container')) { setZoom(state.zoom === 1 ? 2 : 1); return; }
      /* Only a backdrop tap closes the detail modal, never a tap inside it. */
      if (t.id === 'modal-overlay') { closeModal(e); return; }
    });

    var search = el('search-input');
    if (search) {
      search.addEventListener('input', function () { renderCircuitList(search.value); });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeImage(); closeModal(); }
    });

    /* swipe between views */
    var main = document.querySelector('.main');
    if (main) {
      var x0 = 0, y0 = 0;
      main.addEventListener('touchstart', function (e) {
        x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
      }, { passive: true });
      main.addEventListener('touchend', function (e) {
        if (el('image-modal').classList.contains('active')) return;
        var dx = e.changedTouches[0].clientX - x0;
        var dy = e.changedTouches[0].clientY - y0;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          var cur = document.querySelector('.view.active');
          var i = VIEWS.indexOf(cur ? cur.id : '');
          if (dx < 0 && i < VIEWS.length - 1) showView(VIEWS[i + 1]);
          else if (dx > 0 && i > 0) showView(VIEWS[i - 1]);
        }
      }, { passive: true });
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    wire();
    boot();
  });
})();
