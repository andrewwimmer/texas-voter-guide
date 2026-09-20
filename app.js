/* Lone Star Voter Guide — vanilla JS, no dependencies.
   Reads candidates.json, lists races in certified ballot order (or grouped by
   jurisdiction), and renders every endorsement and donation with a clickable
   source link. */

(function () {
  'use strict';

  var DATA_URL = 'candidates.json';

  // Plain-language explanations of what each office does, each carrying links
  // to the law it summarizes. Supplementary to the ballot, never required by
  // it: if this file is missing or malformed every race title stays exactly
  // the text the certification report printed.
  var OFFICES_URL = 'data/offices.json';

  var TYPE_LABELS = {
    'federal': 'Federal',
    'state': 'State',
    'county': 'County & precinct'
  };

  // Keys are the party strings as they appear in candidates.json (upper case,
  // as transcribed from the certification report); values are for display.
  var PARTY_LABELS = {
    'REPUBLICAN': 'Republican',
    'DEMOCRATIC': 'Democratic',
    'LIBERTARIAN': 'Libertarian',
    'GREEN': 'Green'
  };

  var state = {
    candidates: [],
    type: 'all',
    jurisdiction: 'all',
    // Party never removes anything: it highlights one party and dims the rest,
    // so a race always shows its full field of candidates.
    party: 'all',
    search: '',
    // 'ballot' renders one continuous list in certified ballot order;
    // 'jurisdiction' groups the same races under their level of government.
    sort: 'ballot',
    // Set once an address resolves to a precinct; ballotActive is the
    // "show only my races" / "show all races" switch over the same result.
    ballot: null,
    ballotActive: false,
    // The race list is not on the page at all until a lookup resolves or the
    // landing panel's browse button is pressed. Filtering and rendering are
    // unaffected — this only decides whether the list is on screen.
    racesRevealed: false,
    // Office explanations, compiled from data/offices.json. Empty until that
    // file loads, and left empty if it fails — see OFFICES_URL.
    offices: [],
    officeNotes: []
  };

  var els = {
    results: document.getElementById('results'),
    count: document.getElementById('result-count'),
    type: document.getElementById('filter-type'),
    jurisdiction: document.getElementById('filter-jurisdiction'),
    party: document.getElementById('filter-party'),
    sort: document.getElementById('filter-sort'),
    partyNote: document.getElementById('party-note'),
    search: document.getElementById('filter-search'),
    reset: document.getElementById('filter-reset'),
    print: document.getElementById('print-ballot'),
    printHeader: document.getElementById('print-header'),
    printFooter: document.getElementById('print-footer'),
    lastUpdated: document.getElementById('last-updated'),
    counts: document.querySelectorAll('[data-count]'),
    lookupForm: document.getElementById('lookup-form'),
    lookupAddress: document.getElementById('lookup-address'),
    lookupSubmit: document.getElementById('lookup-submit'),
    lookupStatus: document.getElementById('lookup-status'),
    lookupResult: document.getElementById('lookup-result'),
    landingGate: document.getElementById('landing-gate'),
    browse: document.getElementById('browse'),
    browseAll: document.getElementById('browse-all')
  };

  /* ---------- helpers ---------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setStatus(message, isError) {
    els.results.innerHTML = '';
    els.results.appendChild(el('div', 'status' + (isError ? ' status-error' : ''), message));
  }

  // Only http(s) links become anchors — anything else is shown as plain text
  // so a bad data entry can't turn into a javascript: link.
  function safeUrl(url) {
    if (typeof url !== 'string') return null;
    var trimmed = url.trim();
    return /^https?:\/\//i.test(trimmed) ? trimmed : null;
  }

  function formatDate(value) {
    if (typeof value !== 'string') return '';
    var m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return value; // pass through placeholder / non-ISO values as-is
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (isNaN(d.getTime())) return value;
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function formatAmount(value) {
    if (typeof value !== 'number' || !isFinite(value)) {
      return value === undefined || value === null ? '' : String(value);
    }
    return '$' + value.toLocaleString('en-US');
  }

  function jurisdictionName(c) {
    return (c.jurisdiction && c.jurisdiction.name) || 'Unspecified jurisdiction';
  }

  function jurisdictionType(c) {
    return (c.jurisdiction && c.jurisdiction.type) || 'other';
  }

  /* ---------- filtering ---------- */

  function matchesSearch(c, needle) {
    if (!needle) return true;
    var haystack = [
      c.candidate,
      c.race,
      c.party,
      jurisdictionName(c),
      (c.endorsements || []).map(function (e) { return e.organization; }).join(' '),
      (c.donations || []).map(function (d) { return d.donor; }).join(' ')
    ].join(' ').toLowerCase();
    return haystack.indexOf(needle) !== -1;
  }

  // The counties a record is gated to, as a list: none for a statewide record
  // (county null or absent), one for a county record, and several for a
  // regional court that spans counties. An array comes back as a sorted copy,
  // so two records naming the same counties in a different order agree.
  function recordCounties(c) {
    if (c.county === undefined || c.county === null) return [];
    if (Array.isArray(c.county)) return c.county.slice().sort();
    return [c.county];
  }

  // True when this race is on the looked-up voter's ballot. Two independent
  // gates, both read off the candidate record rather than its race title:
  // county (a candidate naming a county appears only for a voter in that
  // county) and district (a candidate carrying a district appears only when
  // the number matches the precinct's). A candidate null on a field is not
  // gated by it — that is what carries statewide races onto every ballot.
  function matchesBallot(c) {
    if (!state.ballotActive || !state.ballot) return true;

    var counties = recordCounties(c);
    if (counties.length && counties.indexOf(state.ballot.county) === -1) {
      return false;
    }

    var rule = districtRule(c.district);
    if (!rule.field) return true;
    return rule.value !== null && rule.value === state.ballot.districts[rule.field];
  }

  // candidates.json carries the party exactly as the certification report
  // prints it; compare on a canonical upper-case form so a stray "Republican"
  // still matches the "REPUBLICAN" the dropdown sends.
  function partyKey(c) {
    return String(c.party === undefined || c.party === null ? '' : c.party)
      .replace(/\s+/g, ' ').trim().toUpperCase();
  }

  function partyLabel(key) {
    return PARTY_LABELS[key] || key;
  }

  // No party at all, which on this ballot means the office is nonpartisan by
  // law rather than a partisan seat nobody filed for. The distinction drives
  // everything below: a nonpartisan candidate is not "from another party", so
  // a party selection must not dim them, must not count their race as a race
  // the party left uncontested, and must not drop them from the printed slate.
  function isNonpartisan(c) {
    return partyKey(c) === '';
  }

  // Deliberately NOT part of applyFilters: a party selection dims candidates,
  // it never drops them, so every race keeps its whole field on screen.
  function matchesParty(c) {
    return state.party === 'all' || partyKey(c) === state.party;
  }

  // How many of a race's candidates are from the selected party, or null when
  // the question does not apply — no party selected, or a nonpartisan race,
  // where there is no party to be missing. null is what keeps a nonpartisan
  // race out of both the "no X candidate" flag and the unmatched-race tally;
  // 0 means a partisan race the selected party genuinely is not contesting.
  function partyMatchCount(race) {
    if (state.party === 'all') return null;
    var partisan = race.candidates.filter(function (c) { return !isNonpartisan(c); });
    return partisan.length ? partisan.filter(matchesParty).length : null;
  }

  function applyFilters() {
    var needle = state.search.trim().toLowerCase();
    return state.candidates.filter(function (c) {
      if (!matchesBallot(c)) return false;
      if (state.type !== 'all' && jurisdictionType(c) !== state.type) return false;
      if (state.jurisdiction !== 'all' && jurisdictionName(c) !== state.jurisdiction) return false;
      return matchesSearch(c, needle);
    });
  }

  /* ---------- grouping ---------- */

  // ballotOrder is the entry's 1-based position in the certification report,
  // so it orders races against each other and candidates within a race in the
  // one sequence a voter actually meets at the polls. Candidates are never
  // sorted by name: on a ballot, name order is not the order.
  //
  // A candidate with a real position always precedes one without, which is why
  // the two Infinity cases are tested outright rather than inferred from the
  // subtraction: finite - Infinity is -Infinity, which would read as "sorts
  // first" from the wrong side of the pair.
  //
  // The id tiebreak applies only to genuinely equal positions — including two
  // that are both Infinity, where the subtraction would be NaN and a NaN
  // comparator leaves the order undefined per spec.
  function byBallotOrder(a, b) {
    var oa = ballotOrder(a);
    var ob = ballotOrder(b);
    if (oa !== ob) {
      if (oa === Infinity) return 1;
      if (ob === Infinity) return -1;
      return oa - ob;
    }
    return idOf(a).localeCompare(idOf(b));
  }

  function idOf(c) {
    return String(c.id === undefined || c.id === null ? '' : c.id);
  }

  // The position is keyed by county, because the same statewide candidate sits
  // at a different place on each county's ballot. Which county that is follows
  // the lookup when one is active and falls back to DEFAULT_COUNTY otherwise.
  // A bare number is still honored, so a record written
  // against the older shape keeps working.
  function ballotOrder(c) {
    var value = c.ballotOrder;
    if (typeof value === 'number') return value;
    if (!value || typeof value !== 'object') return Infinity;
    var n = value[ballotCounty()];
    return typeof n === 'number' ? n : Infinity;
  }

  // A race title is not unique once a second county is in the data. "COUNTY
  // JUDGE", "DISTRICT CLERK" and "COUNTY COMMISSIONER PRECINCT 2" are each a
  // different office in Dallas than in Tarrant, printed under the identical
  // string, so the county joins the key.
  //
  // A candidate with no county is statewide and takes NO_COUNTY: a slot no
  // county name can occupy, so a statewide race groups as itself instead of
  // folding into whichever county's race happens to share its title.
  function raceKey(c) {
    var counties = recordCounties(c);
    var county = counties.length ? counties.join(',') : NO_COUNTY;
    return (c.race || 'Unspecified race') + '||' + (c.electionDate || '') + '||' + county;
  }

  // The county rides along on the race, not just in its key: two counties can
  // certify the same race title, and once the group is built the title alone
  // no longer says which office it is. Absent county is normalized to null so
  // a statewide race reads the same whether the record omitted the field or
  // set it null.
  function newRace(c) {
    return {
      race: c.race || 'Unspecified race',
      county: c.county === undefined ? null : c.county,
      electionDate: c.electionDate || '',
      candidates: []
    };
  }

  // -> [{ race, county, electionDate, candidates: [...] }] in certified ballot
  // order, with no jurisdiction grouping: the flat list the ballot itself is.
  function racesInBallotOrder(list) {
    var order = [];
    var byKey = {};

    list.slice().sort(byBallotOrder).forEach(function (c) {
      var key = raceKey(c);
      if (!byKey[key]) {
        byKey[key] = newRace(c);
        order.push(key);
      }
      byKey[key].candidates.push(c);
    });

    return order.map(function (key) { return byKey[key]; });
  }

  // -> [{ name, type, races: [{ race, county, electionDate, candidates }] }]
  function groupByJurisdiction(list) {
    var order = [];
    var byName = {};

    list.forEach(function (c) {
      var name = jurisdictionName(c);
      if (!byName[name]) {
        byName[name] = { name: name, type: jurisdictionType(c), raceOrder: [], races: {} };
        order.push(name);
      }
      var group = byName[name];
      var key = raceKey(c);
      if (!group.races[key]) {
        group.races[key] = newRace(c);
        group.raceOrder.push(key);
      }
      group.races[key].candidates.push(c);
    });

    return order
      .sort(function (a, b) { return a.localeCompare(b); })
      .map(function (name) {
        var group = byName[name];
        var races = group.raceOrder.map(function (key) { return group.races[key]; });
        // County is the last tiebreak rather than no tiebreak at all: two
        // counties certifying one title are two races that tie on every field
        // above, and leaving them to sort stability makes their order an
        // accident of insertion. A statewide race carries no county and sorts
        // ahead of any county's.
        races.sort(function (a, b) {
          if (a.electionDate !== b.electionDate) {
            return a.electionDate < b.electionDate ? -1 : 1;
          }
          var byRace = a.race.localeCompare(b.race);
          if (byRace !== 0) return byRace;
          return String(a.county || '').localeCompare(String(b.county || ''));
        });
        races.forEach(function (r) { r.candidates.sort(byBallotOrder); });
        return { name: group.name, type: group.type, races: races };
      });
  }

  // The landing copy quotes how many races and candidates this guide holds.
  // Both are counted off the loaded data rather than written into the markup,
  // so importing another county cannot leave the page describing the last one.
  // Races are counted by raceKey, the same identity the list itself groups on,
  // which is why two counties' identically titled offices count as two.
  //
  // Every [data-count] node is filled, so one number can appear in several
  // sentences. A node whose name is not a total is left alone rather than
  // blanked: an unrecognized name is a typo in the markup, and the visible
  // placeholder says so more clearly than an empty gap.
  function fillCounts() {
    var seen = Object.create(null);
    var raceCount = 0;
    state.candidates.forEach(function (c) {
      var key = raceKey(c);
      if (!seen[key]) { seen[key] = true; raceCount++; }
    });

    var totals = { races: raceCount, candidates: state.candidates.length };
    for (var i = 0; i < els.counts.length; i++) {
      var node = els.counts[i];
      var value = totals[node.getAttribute('data-count')];
      if (value !== undefined) node.textContent = String(value);
    }
  }

  /* ---------- office explanations ---------- */

  /* offices.json carries a "matches" regular expression per office, tested
     against the trimmed race title, and an optional "counties" list that
     narrows it to the counties that actually elect that office. The gate
     matters because three counties print some identical titles over
     different offices: "JUDGE, COUNTY COURT AT LAW NO. 1" is a Tarrant
     office here, and the Dallas and Collin races under that same string are
     deliberately left unexplained rather than given Tarrant's description.

     Nothing is inferred. A race whose title no pattern matches keeps its
     title exactly as certified, with no button and no panel. */

  // Patterns are compiled once, at load. A pattern that will not compile
  // drops that one office rather than throwing: a typo in the data file
  // should cost its own entry, not the whole ballot.
  function compileOffices(data) {
    var offices = [];
    var notes = [];
    if (!data || typeof data !== 'object') return { offices: offices, notes: notes };

    function compile(entry) {
      if (!entry || typeof entry.matches !== 'string') return null;
      try {
        return new RegExp(entry.matches);
      } catch (err) {
        return null;
      }
    }

    if (Array.isArray(data.offices)) {
      data.offices.forEach(function (o) {
        var re = compile(o);
        if (re) offices.push({ entry: o, re: re });
      });
    }
    if (Array.isArray(data.notes)) {
      data.notes.forEach(function (n) {
        var re = compile(n);
        if (re) notes.push({ entry: n, re: re });
      });
    }
    return { offices: offices, notes: notes };
  }

  // A race object carries the same `county` shape a candidate record does
  // (null, a string, or a list for a district two counties share), so the
  // record-level reader works on it unchanged.
  function officeMatches(race, compiled) {
    var title = String(race.race || '').trim();
    if (!compiled.re.test(title)) return false;

    var counties = compiled.entry.counties;
    if (!Array.isArray(counties) || !counties.length) return true;

    // County-gated: the race has to name one of those counties. A statewide
    // race names none, so it does not qualify — which is the intent, since
    // every county-gated office here is a county office.
    var mine = recordCounties(race);
    return mine.some(function (name) { return counties.indexOf(name) !== -1; });
  }

  // First match wins. The data is written so at most one office matches any
  // title — the report on this pass found no race matching two — but taking
  // the first keeps a future overlap from rendering two stacked panels.
  function findOffice(race) {
    for (var i = 0; i < state.offices.length; i++) {
      if (officeMatches(race, state.offices[i])) return state.offices[i].entry;
    }
    return null;
  }

  // Notes are cross-cutting facts about a race that are not about the office
  // itself — "unexpired term" is true of a seat, not of the job — so they are
  // matched separately and all matches are shown.
  function findNotes(race) {
    var title = String(race.race || '').trim();
    return state.officeNotes
      .filter(function (n) { return n.re.test(title); })
      .map(function (n) { return n.entry; });
  }

  // aria-controls needs an id that is unique on the page. render() rebuilds
  // the whole list, so a counter that only ever climbs is simpler than
  // deriving an id from the title — and two counties' same-titled races
  // cannot collide on it.
  var officePanelSeq = 0;

  function renderOfficePanel(office, notes, panelId) {
    var panel = el('div', 'office-panel');
    panel.id = panelId;
    panel.hidden = true;

    panel.appendChild(el('p', 'office-desc', office.description || ''));

    notes.forEach(function (note) {
      if (note.text) panel.appendChild(el('p', 'office-note', note.text));
    });

    // Links are taken from the data verbatim; safeUrl only refuses anything
    // that is not http(s), it never rewrites one.
    var laws = Array.isArray(office.law) ? office.law : [];
    var links = [];
    laws.forEach(function (law) {
      if (!law) return;
      var url = safeUrl(law.url);
      if (!url) return;
      var a = el('a', 'office-law-link', (law.label || url) + ' ↗');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      links.push(a);
    });

    if (links.length) {
      var wrap = el('p', 'office-law');
      wrap.appendChild(el('span', 'office-law-label', 'In law'));
      links.forEach(function (a) { wrap.appendChild(a); });
      panel.appendChild(wrap);
    }

    return panel;
  }

  // Turns the race title into a disclosure button over its explanation.
  // Returns null when no office matched, and the caller then renders the
  // title as the plain heading it has always been.
  function buildOfficeDisclosure(race) {
    var office = findOffice(race);
    if (!office) return null;

    var panelId = 'office-panel-' + (++officePanelSeq);
    var panel = renderOfficePanel(office, findNotes(race), panelId);

    var btn = el('button', 'office-toggle');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', panelId);
    btn.appendChild(el('span', 'office-toggle-text', race.race));
    // The marker is decorative: the button's name is the race title, and
    // aria-expanded already says which way it is pointing.
    var icon = el('span', 'office-toggle-icon', '?');
    icon.setAttribute('aria-hidden', 'true');
    btn.appendChild(icon);

    // Tap, not hover: a touch screen has no hover, and on a pointer device an
    // explanation that appears on the way past is noise over a long list.
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      panel.hidden = open;
    });

    return { button: btn, panel: panel };
  }

  /* ---------- rendering ---------- */

  function renderSourceLink(item) {
    var url = safeUrl(item.sourceUrl);
    var label = item.sourceLabel || 'Source';
    if (!url) {
      return el('span', 'item-meta', label + ': no valid source URL in data');
    }
    var a = el('a', 'source-link', label + ' ↗');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = url;
    return a;
  }

  function renderItemList(items, kind) {
    var ul = el('ul', 'item-list');

    items.forEach(function (item) {
      var li = el('li');

      var name = el('span', 'item-name',
        kind === 'donation' ? (item.donor || 'Unnamed donor')
                            : (item.organization || 'Unnamed organization'));
      li.appendChild(name);

      if (kind === 'donation' && item.amount !== undefined && item.amount !== null) {
        li.appendChild(document.createTextNode(' — '));
        li.appendChild(el('span', 'amount', formatAmount(item.amount)));
      }

      if (item.date) {
        li.appendChild(document.createTextNode(' '));
        li.appendChild(el('span', 'item-meta', '(' + formatDate(item.date) + ')'));
      }

      if (item.note) {
        li.appendChild(el('span', 'item-note', item.note));
      }

      li.appendChild(renderSourceLink(item));
      ul.appendChild(li);
    });

    return ul;
  }

  // A section with nothing in it is not rendered at all — an empty heading
  // over a "none recorded" line is noise on every one of 153 candidates.
  function renderDetail(title, items, kind) {
    if (!items || !items.length) return null;
    var wrap = el('div', 'detail');
    wrap.appendChild(el('p', 'detail-label', title));
    wrap.appendChild(renderItemList(items, kind));
    return wrap;
  }

  // Party chips state the party three ways at once: spelled out, as a letter,
  // and as a distinctly shaped glyph. Color is never the only signal.
  function renderPartyChip(party) {
    var key = String(party).toUpperCase();
    var known = PARTY_LABELS[key];
    var label = known || party;
    var chip = el('span', 'party party-' + (known ? key.toLowerCase() : 'other'));
    var glyph = el('span', 'party-glyph', String(label).charAt(0).toUpperCase());
    glyph.setAttribute('aria-hidden', 'true');
    chip.appendChild(glyph);
    chip.appendChild(document.createTextNode(label));
    return chip;
  }

  // Stands where a party chip would go, for an office that has no party to
  // name. Deliberately takes the chip's shape but neither its color nor its
  // glyph: those encode which party, and there is no which here.
  function renderNonpartisanLabel() {
    return el('span', 'party party-nonpartisan', 'Nonpartisan');
  }

  // Collapsed to one line by default: name, party, unopposed. The row only
  // becomes expandable where there is sourced detail behind it — a disclosure
  // arrow that opens onto nothing is worse than no arrow.
  function renderCandidate(c) {
    // A nonpartisan candidate is neither highlighted nor dimmed: there is no
    // party for them to be on the wrong side of, and a dimmed name would read
    // as "not your party" rather than "no party at all". This is also what
    // keeps them on the printed slate, where .candidate-dim is display:none.
    var selecting = state.party !== 'all' && !isNonpartisan(c);
    var hit = selecting && matchesParty(c);
    var classes = 'candidate' +
      (selecting ? (hit ? ' candidate-match' : ' candidate-dim') : '');

    var sections = [
      renderDetail('Endorsements', c.endorsements, 'endorsement'),
      renderDetail('Donations', c.donations, 'donation')
    ].filter(Boolean);

    var box = el(sections.length ? 'details' : 'div', classes);
    var row = el(sections.length ? 'summary' : 'div', 'candidate-row');

    row.appendChild(el('span', 'candidate-name', c.candidate || 'Unnamed candidate'));
    row.appendChild(isNonpartisan(c)
      ? renderNonpartisanLabel()
      : renderPartyChip(c.party));
    if (c.unopposed) row.appendChild(el('span', 'marker-unopposed', 'Unopposed'));
    box.appendChild(row);

    if (sections.length) {
      var body = el('div', 'candidate-detail');
      sections.forEach(function (section) { body.appendChild(section); });
      box.appendChild(body);
      // A search can match a donor or endorser that lives behind the fold, so
      // while one is active the detail opens rather than leaving the hit
      // looking unexplained.
      if (state.search.trim()) box.open = true;
    }

    return box;
  }

  function renderRace(race) {
    // A race with nobody from the selected party still belongs on the page —
    // that absence is itself something the reader needs to see — so it stays,
    // flagged, rather than disappearing. A nonpartisan race comes back null
    // instead of 0 and is never flagged: no party contests it by law, which
    // is not the same absence and must not be reported as one.
    var partyMatches = partyMatchCount(race);

    var box = el('article', 'race' + (partyMatches === 0 ? ' race-unmatched' : ''));
    var head = el('div', 'race-head');

    // The heading is the same <h3> either way — only its contents change, so
    // the document outline does not depend on whether an explanation exists.
    var heading = el('h3', null);
    var disclosure = buildOfficeDisclosure(race);
    if (disclosure) {
      heading.appendChild(disclosure.button);
    } else {
      heading.textContent = race.race;
    }
    head.appendChild(heading);

    if (race.electionDate) {
      head.appendChild(el('span', 'election-date', 'Election: ' + formatDate(race.electionDate)));
    }
    if (partyMatches === 0) {
      head.appendChild(el('span', 'race-note',
        'No ' + partyLabel(state.party) + ' candidate in this race'));
    }
    // Last in the head, so the panel opens under the whole title line —
    // title, election date and party note — and above the candidates.
    if (disclosure) head.appendChild(disclosure.panel);
    box.appendChild(head);
    race.candidates.forEach(function (c) { box.appendChild(renderCandidate(c)); });
    return box;
  }

  function renderJurisdiction(group) {
    var section = el('section', 'jurisdiction');
    var head = el('div', 'jurisdiction-head');
    head.appendChild(el('h2', null, group.name));
    head.appendChild(el('span',
      'badge' + (group.type === 'county' ? ' badge-school' : ''),
      TYPE_LABELS[group.type] || 'Other'));
    section.appendChild(head);
    group.races.forEach(function (race) { section.appendChild(renderRace(race)); });
    return section;
  }

  // Sits under the filter bar whenever a party is selected, so the dimming is
  // read as a highlight rather than as a page that failed to load.
  function renderPartyNote(matched, unmatchedRaces) {
    if (state.party === 'all') {
      els.partyNote.hidden = true;
      els.partyNote.textContent = '';
      return;
    }
    var label = partyLabel(state.party);
    var text = 'Highlighting ' + label + ' candidates. Every race still lists its full field — ' +
      'candidates from other parties are dimmed, not removed.';
    if (unmatchedRaces) {
      text += ' ' + unmatchedRaces + ' race' + (unmatchedRaces === 1 ? ' has' : 's have') +
        ' no ' + label + ' candidate at all.';
    }
    els.partyNote.hidden = false;
    els.partyNote.textContent = text;
  }

  // The county the jurisdiction filter has narrowed to, or null if it has not
  // narrowed to exactly one. A jurisdiction qualifies only when every record
  // under it is a county record and they all name the same county, which is
  // what keeps "Texas" from reading as a county selection: the 5th Court of
  // Appeals races sit under Texas carrying Dallas among their counties, and one
  // of those alone must not be enough to call the whole selection Dallas. A
  // record naming several counties names no single one, so it fails outright.
  function selectedCounty() {
    if (state.jurisdiction === 'all') return null;
    var county = null;
    var single = true;
    state.candidates.forEach(function (c) {
      if (jurisdictionName(c) !== state.jurisdiction) return;
      if (jurisdictionType(c) !== 'county' || !c.county || Array.isArray(c.county)) {
        single = false;
        return;
      }
      if (county === null) county = c.county;
      else if (county !== c.county) single = false;
    });
    return single ? county : null;
  }

  // Which county the printed sheet is for, or null to print no county at all.
  // A lookup answers it outright. Without one, a jurisdiction filter narrowed
  // to a single county answers it. Nothing else does: a sheet spanning two
  // counties has no one county, and naming one anyway would put the wrong
  // county's name on a voter's ballot, which is worse than a heading that
  // says less. There is deliberately no fallback.
  function printCounty() {
    if (state.ballotActive && state.ballot) return state.ballot.county || null;
    return selectedCounty();
  }

  // The print sheet drops the hero, so it needs its own heading — and, when a
  // lookup is active, the precinct and matched address that explain why the
  // list on the paper is shorter than the list on the site.
  function renderPrintHeader(raceCount) {
    var header = els.printHeader;
    var county = printCounty();
    header.innerHTML = '';
    header.appendChild(el('p', 'print-title',
      'Lone Star Voter Guide' + (county ? ' \u2014 ' + county + ' County' : '')));

    // A slate sheet carries one name per race, so it has to say out loud whose
    // slate it is. Without this line the paper reads as the whole field.
    if (state.party !== 'all') {
      header.appendChild(el('p', 'print-meta print-filter',
        partyLabel(state.party) + ' candidates only.'));
    }

    if (state.ballotActive && state.ballot) {
      header.appendChild(el('p', 'print-meta',
        'Voting precinct ' + state.ballot.precinct));
      if (state.ballot.matchedAddress) {
        header.appendChild(el('p', 'print-meta',
          'Matched to ' + state.ballot.matchedAddress));
      }
    }

    header.appendChild(el('p', 'print-meta',
      raceCount + ' race' + (raceCount === 1 ? '' : 's')));
  }

  // Closes the slate sheet. A voter holding a one-name-per-race card has no way
  // to tell a race we left blank from a race that has no such candidate at all,
  // so the sheet says which it is and where the whole field lives.
  function renderPrintFooter() {
    els.printFooter.textContent = state.party === 'all' ? '' :
      'Not every race has a candidate from your selected party. ' +
      'Check the full guide at lonestarvoterguide.org.';
  }

  // The first load deliberately shows no races: the landing panel stands in
  // for the list, and this is the only thing that swaps one for the other.
  // Called when an address resolves, when the browse button is pressed, and on
  // a data-load failure — the error message lives inside the hidden list, so
  // hiding it would swallow the error.
  function revealRaces() {
    if (state.racesRevealed) return;
    state.racesRevealed = true;
    els.browse.hidden = false;
    els.landingGate.hidden = true;
    if (els.browseAll) els.browseAll.setAttribute('aria-expanded', 'true');
  }

  function render() {
    var filtered = applyFilters();
    // Ballot order is one continuous list of races; grouped mode nests the
    // same races under a jurisdiction heading. Either way the races, and the
    // candidates inside them, are the same objects in the same sequence.
    var byBallot = state.sort === 'ballot';
    var groups = byBallot ? null : groupByJurisdiction(filtered);
    var races = byBallot
      ? racesInBallotOrder(filtered)
      : groups.reduce(function (all, g) { return all.concat(g.races); }, []);

    var partyMatched = 0;
    var partyEmptyRaces = 0;
    if (state.party !== 'all') {
      races.forEach(function (r) {
        // null is a nonpartisan race: it contributes to neither tally, so the
        // note never reports it as a race the selected party sat out.
        var n = partyMatchCount(r);
        if (n === null) return;
        partyMatched += n;
        if (!n) partyEmptyRaces++;
      });
    }
    renderPartyNote(partyMatched, partyEmptyRaces);

    els.count.textContent = (state.ballotActive && state.ballot
        ? 'Your ballot — precinct ' + state.ballot.precinct + ' · '
        : '') +
      filtered.length + ' candidate' + (filtered.length === 1 ? '' : 's') +
      (state.party === 'all' ? '' :
        ' (' + partyMatched + ' ' + partyLabel(state.party) + ')') +
      ' · ' + races.length + ' race' + (races.length === 1 ? '' : 's') +
      // Only worth counting jurisdictions when they are actually on screen.
      (byBallot ? '' :
        ' · ' + groups.length + ' jurisdiction' + (groups.length === 1 ? '' : 's'));

    renderPrintHeader(races.length);
    renderPrintFooter();

    if (!filtered.length) {
      setStatus(state.ballotActive
        ? 'No races on your ballot match the current filters.'
        : 'No candidates match the current filters.');
      return;
    }

    var frag = document.createDocumentFragment();
    if (byBallot) {
      // No headings at all — the run of race cards is the ballot.
      races.forEach(function (r) { frag.appendChild(renderRace(r)); });
    } else {
      groups.forEach(function (g) { frag.appendChild(renderJurisdiction(g)); });
    }
    els.results.innerHTML = '';
    els.results.appendChild(frag);
  }

  /* ---------- jurisdiction dropdown ---------- */

  // Lists only jurisdictions valid for the selected type, keeping the current
  // selection if it survives the type change.
  function populateJurisdictions() {
    var names = [];
    state.candidates.forEach(function (c) {
      if (!matchesBallot(c)) return;
      if (state.type !== 'all' && jurisdictionType(c) !== state.type) return;
      var name = jurisdictionName(c);
      if (names.indexOf(name) === -1) names.push(name);
    });
    names.sort(function (a, b) { return a.localeCompare(b); });

    if (state.jurisdiction !== 'all' && names.indexOf(state.jurisdiction) === -1) {
      state.jurisdiction = 'all';
    }

    els.jurisdiction.innerHTML = '';
    var allOpt = el('option', null, 'All jurisdictions');
    allOpt.value = 'all';
    els.jurisdiction.appendChild(allOpt);
    names.forEach(function (name) {
      var opt = el('option', null, name);
      opt.value = name;
      els.jurisdiction.appendChild(opt);
    });
    els.jurisdiction.value = state.jurisdiction;
  }


  /* ============================================================
     Address lookup → precinct → personal ballot

     Four steps, all driven from the form at the top of the page:
       1. The typed address goes to the U.S. Census Bureau geocoder,
          which returns a lat/lon. That is the only network call that
          ever sees the address.
       2. That point is tested against the COUNTIES bounding boxes to
          decide which counties could hold it. A point in none of them
          is answered without fetching anything.
       3. Each candidate county's precinct file is fetched lazily, one
          at a time until one matches, and tested point-in-polygon on
          this device. Each county has its own file and its own cache;
          the first real precinct match wins.
       4. The matched precinct's county and district numbers filter
          candidates.json down to the races this voter is actually
          eligible to vote in.
     ============================================================ */

  var GEOCODER_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
  var GEOCODE_TIMEOUT_MS = 15000;

  // One entry per county whose precincts this guide can look up, searched in
  // this order. The box is the envelope of every ring in that county's file,
  // COMPUTED FROM THE FILE and rounded outward to six decimals (~0.1 m), so a
  // point inside any precinct is always inside the box.
  //
  // The boxes are a cheap first pass, never the answer. Two adjacent counties'
  // boxes overlap in a strip along their shared line, so a point in that strip
  // is a candidate for both, and only findPrecinct settles which. Tarrant and
  // Dallas overlap by about 0.0077 deg of longitude, roughly 680 m; Dallas and
  // Collin by about 0.0082 deg of latitude, roughly 910 m; Tarrant and Collin
  // not at all, so no point is in all three boxes.
  //
  // ---- Where these files come from, and what a re-pull costs ---------------
  //
  // Tarrant — data/precincts.geojson, 707 features. Used as published.
  //   https://mapit.tarrantcounty.com/arcgis/rest/services/Dynamic/VotingPrecinct/MapServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson
  //
  // Dallas — data/dallas-precincts.geojson, 791 features. NOT usable as
  // published: two transformations were applied and must be redone on any
  // re-pull.
  //   https://services3.arcgis.com/zqe2kwz79KUqUvxC/ArcGIS/rest/services/PRCNT_791_20260729/FeatureServer/7/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson
  //   The layer id is 7, not 0 — layer 3 has no district fields.
  //     1. Rename the district fields:
  //          FIRST_DIST02_USC -> Congress     FIRST_DIST03_STS -> Senate
  //          FIRST_DIST04_STR -> House        FIRST_DIST05_COM -> Commish
  //          FIRST_DIST21_JP  -> JP           FIRST_DIST23_STB -> Education
  //     2. Strip leading zeros from those six values. Congress, Senate and
  //        Education carried them; House, Commish and JP did not.
  //
  // Collin — data/collin-precincts.geojson, 273 features. NOT usable as
  // published: three transformations were applied and must be redone on any
  // re-pull.
  //   https://services1.arcgis.com/fdWXd5OobWR1E3er/arcgis/rest/services/Voting_Precincts/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson
  //   Do not use the county's own maps.collincountytx.gov Election_Department
  //   layer 0: precinct and geometry only, no district fields.
  //     1. Rename the fields:
  //          PRECINCT -> Precinct (keep integer)
  //          CONG     -> Congress     SEN     -> Senate
  //          SHR      -> House        SED     -> Education
  //          COMMISH  -> Commish      JPC     -> JP
  //     2. Convert those six district values to strings.
  //     3. Drop every other property. They include stale officeholder names.
  //   Congress values checked Sep 11, 2026 against the county's published
  //   Plan C2333 list of 51 precincts whose congressional district changed;
  //   all 51 carry the new district. Precinct set is the 273 effective
  //   Jan 1, 2026.
  //
  // RE-PULLING ANY FILE MEANS UPDATING THREE THINGS:
  //   - that county's bounding box above, recomputed from the new file;
  //   - for Dallas and Collin, that county's transformations above;
  //   - the 1,771 / 707 / 791 / 273 figures in about.html's precinct
  //     provenance item, which are transcribed because they cannot be derived
  //     in the browser without downloading every file.
  //
  // None of it is checked at runtime and each part fails silently, so skipping
  // a step produces wrong results rather than an error.
  // -------------------------------------------------------------------------
  var COUNTIES = [
    { name: 'Tarrant', url: 'data/precincts.geojson',
      minLon: -97.552987, minLat: 32.548662, maxLon: -97.031007, maxLat: 32.994003 },
    { name: 'Dallas', url: 'data/dallas-precincts.geojson',
      minLon: -97.038685, minLat: 32.545222, maxLon: -96.516877, maxLat: 32.989692 },
    { name: 'Collin', url: 'data/collin-precincts.geojson',
      minLon: -96.844130, minLat: 32.981495, maxLon: -96.295064, maxLat: 33.405510 }
  ];

  // The county assumed when no lookup is active — it decides which county's
  // ballotOrder sorts the list and which county the printed sheet names. It is
  // not a statement about coverage: COUNTIES above is that.
  var DEFAULT_COUNTY = 'Tarrant';

  // Stands in for a null county in a race key. Parentheses keep it out of the
  // space of real county names, so it can never collide with one.
  var NO_COUNTY = '(statewide)';

  // The county whose ballot is on screen: the looked-up one while a lookup is
  // active, the default otherwise.
  function ballotCounty() {
    return (state.ballot && state.ballot.county) || DEFAULT_COUNTY;
  }

  // The counties whose bounding box contains this point, in COUNTIES order.
  // Empty means no covered county can possibly hold it, which is worth knowing
  // before any multi-megabyte precinct file is fetched.
  function countiesAt(lon, lat) {
    return COUNTIES.filter(function (c) {
      return lon >= c.minLon && lon <= c.maxLon && lat >= c.minLat && lat <= c.maxLat;
    });
  }

  // "Tarrant County" / "Tarrant and Dallas counties" / "Tarrant, Dallas and
  // Collin counties". The noun is part of the phrase so no caller can pair a
  // two-county list with a singular "County", and no copy needs a count
  // written beside it that a third county would quietly falsify.
  function countyPhrase(counties) {
    var names = counties.map(function (c) { return c.name; });
    if (names.length === 1) return names[0] + ' County';
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] + ' counties';
  }

  // Each district race in candidates.json is tied to exactly one property on
  // the precinct feature. Anything that matches none of these is a countywide
  // or statewide race, which every voter in that county votes in. Every
  // county's precinct file uses these same six property names; Dallas's and
  // Collin's were renamed to them at import (see COUNTIES).
  var DISTRICT_FIELDS = [
    { key: 'Congress',  label: 'U.S. House',                  describe: function (v) { return 'Congressional District ' + v; } },
    { key: 'Senate',    label: 'Texas Senate',                describe: function (v) { return 'State Senate District ' + v; } },
    { key: 'House',     label: 'Texas House',                 describe: function (v) { return 'State House District ' + v; } },
    { key: 'Education', label: 'State Board of Education',    describe: function (v) { return 'SBOE District ' + v; } },
    { key: 'Commish',   label: 'County Commissioner',         describe: function (v) { return 'Commissioner Precinct ' + v; } },
    { key: 'JP',        label: 'Justice of the Peace',        describe: function (v) { return 'JP Precinct ' + v; } }
  ];

  // candidates.json district.type -> the precinct property that gates it.
  // A type absent from this map leaves the candidate ungated rather than
  // hidden, so a new district kind in the data cannot silently drop a race
  // off someone's ballot before this map learns about it.
  var DISTRICT_TYPE_FIELDS = {
    'ushouse':     'Congress',
    'statesenate': 'Senate',
    'statehouse':  'House',
    'sboe':        'Education',
    'commissioner': 'Commish',
    'jp':          'JP',
    // Dallas elects a constable per justice-of-the-peace precinct, off the
    // same precinct boundaries, so both types read the one JP property.
    'constable':   'JP'
  };

  var NO_DISTRICT = { field: null, value: null };

  // { type: 'ushouse', number: 6 } -> { field: 'Congress', value: '6' };
  // null district, or an unrecognized type -> { field: null }.
  function districtRule(district) {
    if (!district) return NO_DISTRICT;
    var field = DISTRICT_TYPE_FIELDS[district.type];
    if (!field) return NO_DISTRICT;
    return { field: field, value: normalizeDistrict(district.number) };
  }

  /* RACE_PATTERNS and raceRule below are the previous title-parsing path.
     Ballot filtering no longer calls them — it reads c.district and c.county
     instead — but they are kept deliberately as the reference for how each
     race title maps to a district, and as a cross-check on the data. */

  // Race title -> which precinct property gates it. Order matters only in that
  // each pattern is specific enough not to catch another race's title; the
  // "DISTRICT JUDGE, 141ST JUDICIAL DISTRICT" and "JUSTICE, 2ND COURT OF
  // APPEALS DISTRICT" families deliberately fall through to universal.
  var RACE_PATTERNS = [
    { field: 'Congress',  re: /^U\.\s*S\.\s*REPRESENTATIVE DISTRICT (\d+)$/ },
    { field: 'Senate',    re: /^STATE SENATOR,\s*DISTRICT (\d+)$/ },
    { field: 'House',     re: /^STATE REPRESENTATIVE DISTRICT (\d+)$/ },
    { field: 'Education', re: /^MEMBER,\s*STATE BOARD OF EDUCATION,\s*DISTRICT (\d+)$/ },
    { field: 'Commish',   re: /^COUNTY COMMISSIONER PRECINCT (\d+)$/ },
    { field: 'JP',        re: /^JUSTICE OF THE PEACE PRECINCT (\d+)$/ }
  ];

  var raceRuleCache = Object.create(null);

  // -> { field: 'Congress', value: '12' } for district races,
  //    { field: null } for countywide / statewide races.
  function raceRule(raceName) {
    var name = String(raceName === undefined || raceName === null ? '' : raceName)
      .replace(/\s+/g, ' ').trim().toUpperCase();
    if (raceRuleCache[name]) return raceRuleCache[name];

    var rule = { field: null, value: null };
    for (var i = 0; i < RACE_PATTERNS.length; i++) {
      var m = name.match(RACE_PATTERNS[i].re);
      if (m) {
        rule = { field: RACE_PATTERNS[i].field, value: normalizeDistrict(m[1]) };
        break;
      }
    }
    raceRuleCache[name] = rule;
    return rule;
  }

  // "09" and "9" are the same district; compare on a canonical form.
  function normalizeDistrict(value) {
    if (value === undefined || value === null) return null;
    var n = String(value).trim();
    if (!/^\d+$/.test(n)) return null;
    return String(parseInt(n, 10));
  }

  // Districts that have a race on this ballot at all. Texas staggers its
  // senate, SBOE, and commissioner terms, so a voter can legitimately live in
  // a district with nothing to vote on this cycle — that is worth saying out
  // loud rather than silently showing them one fewer race.
  //
  // Only this county's races count toward that. District numbers restart in
  // every county — Dallas and Tarrant each have a Commissioner Precinct 2 and
  // a JP Precinct 1 — so counting another county's races here would report a
  // district as having something on the ballot when nothing in it does. The
  // county gate is the one matchesBallot applies: a candidate naming no county
  // is statewide and counts everywhere.
  function districtsOnBallot(field) {
    var county = ballotCounty();
    var found = Object.create(null);
    state.candidates.forEach(function (c) {
      var counties = recordCounties(c);
      if (counties.length && counties.indexOf(county) === -1) return;
      var rule = districtRule(c.district);
      if (rule.field === field && rule.value) found[rule.value] = true;
    });
    return found;
  }

  /* ---------- point in polygon ---------- */

  // Ray casting / crossing number against one linear ring. Counts how often a
  // ray heading in -x from the point crosses an edge; odd means inside. Edges
  // are treated as half-open in y ((yi > y) !== (yj > y)) so a vertex shared by
  // two edges is not counted twice.
  function ringContains(lon, lat, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1];
      var xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat)) {
        if (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  // GeoJSON polygon: ring 0 is the outer boundary, any further rings are holes.
  function polygonContains(lon, lat, rings) {
    if (!rings.length || !ringContains(lon, lat, rings[0])) return false;
    for (var i = 1; i < rings.length; i++) {
      if (ringContains(lon, lat, rings[i])) return false;
    }
    return true;
  }

  /* ---------- lazy precinct index ---------- */

  // county name -> promise of that county's index. Per county, not one shared
  // promise, so each file is fetched and indexed at most once and a county
  // that fails to load does not poison another.
  var precinctIndexes = Object.create(null);

  // Precompute each feature's bounding box once so a lookup rejects nearly
  // all of a county's precincts (707 in Tarrant, 791 in Dallas, 273 in
  // Collin) with four numeric comparisons instead of walking their rings.
  // Only outer rings contribute to the box; a hole is inside its own.
  //
  // The county is stamped on at index time from the COUNTIES entry that named
  // the file. It is deliberately not read off the feature: the Tarrant file
  // carries a County property and the Dallas and Collin files have none, and
  // inventing one would mean editing published GIS data to carry a fact this
  // code already knows.
  function indexPrecincts(geo, countyName) {
    var features = (geo && geo.features) || [];
    var index = [];

    for (var i = 0; i < features.length; i++) {
      var geom = features[i].geometry;
      if (!geom) continue;

      var polys;
      if (geom.type === 'Polygon') polys = [geom.coordinates];
      else if (geom.type === 'MultiPolygon') polys = geom.coordinates;
      else continue;

      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var p = 0; p < polys.length; p++) {
        var outer = polys[p][0] || [];
        for (var k = 0; k < outer.length; k++) {
          var x = outer[k][0], y = outer[k][1];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (minX === Infinity) continue;

      index.push({
        minX: minX, minY: minY, maxX: maxX, maxY: maxY,
        polys: polys,
        county: countyName,
        props: features[i].properties || {}
      });
    }

    if (!index.length) {
      throw new Error('precinct file for ' + countyName + ' contained no usable polygons');
    }
    return index;
  }

  // Fetched on first use only — the files run 2.9 to 4.6 MB and most visitors
  // never touch the lookup. A failure clears that county's cached promise so a retry
  // re-fetches instead of replaying the same rejection forever.
  function loadPrecincts(county) {
    if (!precinctIndexes[county.name]) {
      precinctIndexes[county.name] = fetch(county.url, { cache: 'force-cache' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + county.url);
          return res.json();
        })
        .then(function (geo) { return indexPrecincts(geo, county.name); })
        .catch(function (err) {
          precinctIndexes[county.name] = null;
          throw err;
        });
    }
    return precinctIndexes[county.name];
  }

  // Walks the candidate counties in order and resolves with the first real
  // precinct hit as { props, county }, or null when none of them contains the
  // point. Each county's file is loaded only once the ones before it have
  // missed, so the common case — a point in exactly one county's box — fetches
  // exactly one file.
  //
  // A county whose file fails to load rejects the whole search rather than
  // being skipped: "we could not read Dallas" is a different answer from "you
  // are not in Dallas", and silently downgrading the first to the second would
  // tell a Dallas voter they have no ballot.
  // onCounty, when given, is called with each county's name just before its
  // file is loaded, so the status line can name the county actually being
  // fetched instead of announcing one download and then quietly doing another.
  function findPrecinctIn(counties, lon, lat, onCounty) {
    var i = 0;
    function step() {
      if (i >= counties.length) return Promise.resolve(null);
      var county = counties[i++];
      if (onCounty) onCounty(county.name);
      return loadPrecincts(county).then(function (index) {
        var props = findPrecinct(index, lon, lat);
        return props ? { props: props, county: county.name } : step();
      });
    }
    return step();
  }

  function findPrecinct(index, lon, lat) {
    for (var i = 0; i < index.length; i++) {
      var f = index[i];
      if (lon < f.minX || lon > f.maxX || lat < f.minY || lat > f.maxY) continue;
      for (var p = 0; p < f.polys.length; p++) {
        if (polygonContains(lon, lat, f.polys[p])) return f.props;
      }
    }
    return null;
  }

  /* ---------- geocoding ---------- */

  var jsonpSeq = 0;

  // The Census geocoder does not send an Access-Control-Allow-Origin header,
  // so a normal fetch() is blocked by CORS from a static site with no backend.
  // Its documented JSONP mode is the supported way in. The response is executed
  // as script, so: https only, a single-use callback name, a hard timeout, the
  // tag torn down either way, and the payload shape checked before it is read.
  function geocode(address, onSuccess, onError) {
    var callbackName = '__tcvgGeocode' + (++jsonpSeq) + '_' + Date.now().toString(36);
    var script = document.createElement('script');
    var settled = false;
    var timer;

    function cleanup() {
      clearTimeout(timer);
      try { delete window[callbackName]; } catch (e) { window[callbackName] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    function settle(fn, arg) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    }

    window[callbackName] = function (payload) { settle(onSuccess, payload); };
    script.onerror = function () { settle(onError, new Error('unreachable')); };
    timer = setTimeout(function () { settle(onError, new Error('timeout')); }, GEOCODE_TIMEOUT_MS);

    script.src = GEOCODER_URL +
      '?address=' + encodeURIComponent(address) +
      '&benchmark=Public_AR_Current' +
      '&format=jsonp' +
      '&callback=' + callbackName;
    document.head.appendChild(script);
  }

  // Pulls the first match out of the geocoder payload without trusting any of
  // its shape. Returns null when the response is well-formed but empty.
  function firstMatch(payload) {
    var matches = payload && payload.result && payload.result.addressMatches;
    if (!Array.isArray(matches) || !matches.length) return null;

    var m = matches[0];
    var coords = m && m.coordinates;
    if (!coords) return null;

    var lon = Number(coords.x);
    var lat = Number(coords.y);
    if (!isFinite(lon) || !isFinite(lat)) return null;

    return {
      lon: lon,
      lat: lat,
      matchedAddress: typeof m.matchedAddress === 'string' ? m.matchedAddress : ''
    };
  }

  /* ---------- lookup UI ---------- */

  function setLookupStatus(message, kind) {
    if (!message) {
      els.lookupStatus.hidden = true;
      els.lookupStatus.textContent = '';
      return;
    }
    els.lookupStatus.hidden = false;
    els.lookupStatus.className = 'lookup-status' + (kind ? ' lookup-status-' + kind : '');
    els.lookupStatus.textContent = message;
  }

  function setBusy(busy) {
    els.lookupSubmit.disabled = busy;
    els.lookupSubmit.textContent = busy ? 'Looking up…' : 'Find my races';
  }

  // The "why these races" panel: the precinct that matched, every district it
  // puts the voter in, and — for districts with nothing on this ballot — the
  // reason a race is missing.
  function renderBallotPanel() {
    var ballot = state.ballot;
    els.lookupResult.innerHTML = '';

    if (!ballot) {
      els.lookupResult.hidden = true;
      return;
    }
    els.lookupResult.hidden = false;

    var head = el('div', 'ballot-head');
    head.appendChild(el('p', 'ballot-precinct-label', 'Voting precinct'));
    head.appendChild(el('p', 'ballot-precinct', ballot.precinct));
    if (ballot.matchedAddress) {
      head.appendChild(el('p', 'ballot-address', 'Matched to ' + ballot.matchedAddress));
    }
    els.lookupResult.appendChild(head);

    els.lookupResult.appendChild(el('p', 'ballot-why',
      'You vote in every countywide and statewide race, plus the district races below.'));

    var list = el('ul', 'district-list');
    DISTRICT_FIELDS.forEach(function (field) {
      var value = ballot.districts[field.key];
      var li = el('li');
      li.appendChild(el('span', 'district-label', field.label));

      if (!value) {
        li.appendChild(el('span', 'district-value district-unknown', 'not recorded for this precinct'));
      } else {
        li.appendChild(el('span', 'district-value', field.describe(value)));
        if (!ballot.onBallot[field.key][value]) {
          li.appendChild(el('span', 'district-note', 'not on the 2026 ballot — this seat is not up for election this cycle'));
        }
      }
      list.appendChild(li);
    });
    els.lookupResult.appendChild(list);

    var actions = el('div', 'ballot-actions');
    var toggle = el('button', 'ballot-toggle',
      state.ballotActive ? 'Show all races' : 'Show only my races');
    toggle.type = 'button';
    toggle.addEventListener('click', function () {
      state.ballotActive = !state.ballotActive;
      renderBallotPanel();
      populateJurisdictions();
      render();
    });
    actions.appendChild(toggle);

    var clear = el('button', 'ballot-clear', 'Clear address');
    clear.type = 'button';
    clear.addEventListener('click', function () {
      state.ballot = null;
      state.ballotActive = false;
      els.lookupAddress.value = '';
      setLookupStatus('');
      renderBallotPanel();
      populateJurisdictions();
      render();
      els.lookupAddress.focus();
    });
    actions.appendChild(clear);

    els.lookupResult.appendChild(actions);
  }

  function applyPrecinct(props, matchedAddress, county) {
    var districts = {};
    var onBallot = {};

    // The ballot is published before its districts are filled in, because
    // districtsOnBallot reads the county back off it through ballotCounty()
    // and a district number is only meaningful inside one county. The two
    // objects are filled by reference below. Nothing observes state.ballot in
    // between: the loop is synchronous and no render runs until the end of
    // this function.
    //
    // The county is the one whose polygons actually contained the point, not a
    // constant: a Dallas address must not be filed under Tarrant's precinct
    // numbering, where Commissioner Precinct 2 is a different office.
    state.ballot = {
      precinct: String(props.Precinct || props.Pct_Char || 'unknown'),
      county: county,
      matchedAddress: matchedAddress,
      districts: districts,
      onBallot: onBallot
    };

    DISTRICT_FIELDS.forEach(function (field) {
      districts[field.key] = normalizeDistrict(props[field.key]);
      onBallot[field.key] = districtsOnBallot(field.key);
    });

    state.ballotActive = true;

    setLookupStatus('');
    revealRaces();
    renderBallotPanel();
    populateJurisdictions();
    render();
    els.lookupResult.scrollIntoView({ block: 'nearest' });
  }

  function runLookup(address) {
    setBusy(true);
    setLookupStatus('Sending your address to the Census geocoder…');

    // No precinct file is fetched in parallel with the geocode any more: which
    // county's file to fetch is not known until the point comes back. The cost
    // is that the download no longer overlaps the geocode; the benefit is that
    // a lookup pulls one county's file instead of every county's.
    geocode(address, function (payload) {
      var match;
      try {
        match = firstMatch(payload);
      } catch (e) {
        match = null;
      }

      if (!match) {
        setBusy(false);
        setLookupStatus(
          'The Census geocoder could not find that address. Check the spelling, and try ' +
          'including the city and ZIP — for example "100 Main St, Fort Worth, TX 76102".',
          'warn');
        return;
      }

      // Box test first, so an address in a county this guide does not carry
      // costs nothing: no file is fetched at all.
      var candidates = countiesAt(match.lon, match.lat);
      if (!candidates.length) {
        setBusy(false);
        setLookupStatus(
          (match.matchedAddress || 'That address') + ' is not in a county this guide covers. ' +
          'Address lookup covers ' + countyPhrase(COUNTIES) + '; more are being added.',
          'warn');
        revealRaces();
        return;
      }

      findPrecinctIn(candidates, match.lon, match.lat, function (name) {
        setLookupStatus('Address found. Loading the ' + name + ' County precinct map…');
      }).then(function (hit) {
        setBusy(false);
        if (!hit) {
          setLookupStatus(
            (match.matchedAddress || 'That address') + ' did not match a precinct in ' +
            countyPhrase(candidates) + '. It may sit just outside the county line, or be ' +
            'missing from the precinct map this guide uses. Every race in ' +
            countyPhrase(COUNTIES) + ' is open below.',
            'warn');
          // A lookup that cannot narrow the list must not leave the page empty:
          // open the full list rather than stranding the visitor on the landing
          // panel with nothing to read.
          revealRaces();
          return;
        }
        applyPrecinct(hit.props, match.matchedAddress, hit.county);
      }, function (err) {
        setBusy(false);
        setLookupStatus(
          'Your address was found, but the precinct map could not be loaded (' + err.message +
          '). Check your connection and try again — the full list of races is ' +
          'open below in the meantime.',
          'error');
        revealRaces();
      });

    }, function (err) {
      setBusy(false);
      setLookupStatus(
        err.message === 'timeout'
          ? 'The Census geocoder did not respond within 15 seconds. It may be down or blocked ' +
            'by your network — try again in a moment. The full list of races is ' +
            'open below in the meantime.'
          : 'Could not reach the Census geocoder. It may be down or blocked by your network — ' +
            'try again in a moment. The full list of races is open below in the ' +
            'meantime.',
        'error');
      revealRaces();
    });
  }

  function wireLookup() {
    // The focus warm-up is gone. It prefetched the one precinct file on the
    // theory that there was only one to want; with a county per file, focus
    // cannot know which. The two ways to keep it are both worse than dropping
    // it: warming every county pulls 11.7 MB for a field the visitor may only
    // have tabbed through, and warming DEFAULT_COUNTY alone is a guess that
    // costs a Dallas or Collin voter a wasted 4.6 MB before their real file
    // starts.
    //
    // The cost is real — the download no longer overlaps the geocode, so a
    // first lookup is slower by roughly one file fetch. Worth revisiting if
    // the files get smaller or a coarse county lookup lands that could pick
    // the right file from the typed ZIP before the geocoder answers.
    els.lookupForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var address = els.lookupAddress.value.trim();
      if (!address) {
        setLookupStatus('Type a street address first.', 'warn');
        els.lookupAddress.focus();
        return;
      }
      runLookup(address);
    });
  }

  /* ---------- events ---------- */

  function wireEvents() {
    // The landing panel's escape hatch, for anyone who wants the county list
    // without handing over an address. Focus follows the content it opens.
    els.browseAll.addEventListener('click', function () {
      revealRaces();
      els.browse.focus();
      els.browse.scrollIntoView({ block: 'start' });
    });

    els.type.addEventListener('change', function () {
      state.type = els.type.value;
      populateJurisdictions();
      render();
    });

    els.jurisdiction.addEventListener('change', function () {
      state.jurisdiction = els.jurisdiction.value;
      render();
    });

    // Party only changes how the list is drawn, so no dropdown needs
    // repopulating — the set of visible races is identical either way.
    els.party.addEventListener('change', function () {
      state.party = els.party.value;
      render();
    });

    els.search.addEventListener('input', function () {
      state.search = els.search.value;
      render();
    });

    // Sort only re-shapes the list that is already on screen: same races,
    // same candidates, same filters.
    els.sort.addEventListener('change', function () {
      state.sort = els.sort.value;
      render();
    });

    // Nothing to prepare: the print stylesheet works off the DOM that is
    // already on screen, so whatever is filtered and sorted here is what
    // lands on paper.
    els.print.addEventListener('click', function () {
      window.print();
    });

    // Resets the dropdowns and returns to the full race list, but keeps any
    // matched precinct on screen so it can be re-applied with one click.
    els.reset.addEventListener('click', function () {
      state.type = 'all';
      state.jurisdiction = 'all';
      state.party = 'all';
      state.search = '';
      state.sort = 'ballot';
      state.ballotActive = false;
      els.type.value = 'all';
      els.party.value = 'all';
      els.search.value = '';
      els.sort.value = 'ballot';
      renderBallotPanel();
      populateJurisdictions();
      render();
    });
  }

  /* ---------- boot ---------- */

  function start(data) {
    var list = (data && Array.isArray(data.candidates)) ? data.candidates
             : (Array.isArray(data) ? data : []);

    if (!list.length) {
      setStatus('candidates.json loaded but contains no candidate entries.', true);
      revealRaces();
      return;
    }

    state.candidates = list;

    if (data && data.meta && data.meta.lastUpdated) {
      els.lastUpdated.textContent = 'Data last updated: ' + data.meta.lastUpdated;
    }

    fillCounts();

    els.sort.value = state.sort;
    populateJurisdictions();
    wireEvents();
    render();
  }

  // Wired before the fetch, not inside start(): the address form talks to the
  // geocoder and the precinct map, neither of which needs candidates.json. Left
  // inside start() it was never wired at all when that fetch failed, so the
  // submit button fell through to a native form submit and reloaded the page.
  wireLookup();

  setStatus('Loading candidates…');

  // Offices ride alongside the candidates rather than after them: the two are
  // independent files and the list is rendered once, with explanations
  // already in hand, instead of being built plain and then re-rendered.
  //
  // Its failure is not the ballot's failure. A missing or broken offices.json
  // resolves to null here, every title renders as plain text, and the guide
  // is exactly the guide it was before this file existed.
  var officesReady = fetch(OFFICES_URL, { cache: 'no-cache' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .catch(function () { return null; });

  Promise.all([
    fetch(DATA_URL, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + DATA_URL);
      return res.json();
    }),
    officesReady
  ])
    .then(function (both) {
      var compiled = compileOffices(both[1]);
      state.offices = compiled.offices;
      state.officeNotes = compiled.notes;
      start(both[0]);
    })
    .catch(function (err) {
      var hint = location.protocol === 'file:'
        ? ' Opening this page directly from disk blocks the fetch. Serve the folder over HTTP instead, e.g. "python3 -m http.server".'
        : '';
      setStatus('Could not load candidates.json: ' + err.message + '.' + hint, true);
      revealRaces();
    });
})();
