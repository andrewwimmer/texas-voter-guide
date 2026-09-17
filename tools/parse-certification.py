"""Turns a Texas SOS Ballot Certification Report PDF into candidate records.

    python3 tools/parse-certification.py sources/ballot-certification-2026-11-03.pdf
    python3 tools/parse-certification.py sources/...pdf --diff          # compare to candidates.json
    python3 tools/parse-certification.py sources/...pdf -o out.json     # write records

The report format is rigidly regular, which is what makes this tractable:

    Texas Secretary of State          <- page header, 4 lines, repeats
    Ballot Certification Report
    2026 NOVEMBER GENERAL ELECTION
    County: TARRANT
    U. S. SENATOR Party               <- first race on a page carries "Party"
    KEN PAXTON REPUBLICAN             <- candidate: name then party
    JAMES TALARICO DEMOCRATIC
    U. S. REPRESENTATIVE DISTRICT 6   <- race: never ends in a party name
    ...
    Page 1 of 10 9/7/2026, 9:59:18 AM <- page footer

So the whole discriminator is: a line ending in one of the four party names is a
candidate, anything else is a race heading. Names containing quotes, commas,
suffixes and hyphens (RAMON ROMERO, JR / ANGELA "HELI" RODRIGUEZ PRILLIMAN /
PAIGE PAYNE - NEAL) all fall out correctly because only the trailing token is
inspected.

Classification rules were derived from the 330 records already in
candidates.json, not invented - see classify() below.

PDF text extraction needs a library; everything after it is standard library.
Tries pypdf, PyPDF2, fitz (PyMuPDF), then pdfminer.six. If none is installed:
    pip3 install pypdf
Or extract the text yourself and pass it in:
    python3 tools/parse-certification.py extracted.txt --county Tarrant
"""

import argparse
import datetime
import json
import os
import re
import sys

import idgen

PARTIES = ('REPUBLICAN', 'DEMOCRATIC', 'LIBERTARIAN', 'GREEN')

HEADER_LINES = ('Texas Secretary of State', 'Ballot Certification Report')
HEADER_RE = re.compile(r'^(\d{4}\s+\w+\s+GENERAL ELECTION|County:\s*(.+))$', re.I)
FOOTER_RE = re.compile(r'^Page\s+\d+\s+of\s+\d+\b')

# Race title -> district. The type strings match what app.js already expects.
DISTRICT_PATTERNS = [
    (re.compile(r'^U\.?\s*S\.?\s+REPRESENTATIVE\s+DISTRICT\s+(\d+)', re.I), 'ushouse'),
    (re.compile(r'STATE BOARD OF EDUCATION,?\s+DISTRICT\s+(\d+)', re.I), 'sboe'),
    (re.compile(r'^STATE SENATOR,?\s+DISTRICT\s+(\d+)', re.I), 'statesenate'),
    (re.compile(r'^STATE REPRESENTATIVE,?\s+DISTRICT\s+(\d+)', re.I), 'statehouse'),
    # Counties word these differently: Tarrant writes "JUSTICE OF THE PEACE
    # PRECINCT 1", Dallas writes "COUNTY CONSTABLE PRECINCT 1" and splits JP
    # precincts into places ("... PRECINCT 1, PLACE 2" - the place is not a
    # district and is deliberately ignored). Optional COUNTY prefix and optional
    # comma absorb the variants seen so far.
    (re.compile(r'^(?:COUNTY\s+)?COMMISSIONER,?\s+PRECINCT\s+(\d+)', re.I), 'commissioner'),
    (re.compile(r'^JUSTICE OF THE PEACE,?\s+PRECINCT\s+(\d+)', re.I), 'jp'),
    (re.compile(r'^(?:COUNTY\s+)?CONSTABLE,?\s+PRECINCT\s+(\d+)', re.I), 'constable'),
]

FEDERAL_RE = re.compile(r'^U\.?\s*S\.?\s+(SENATOR|REPRESENTATIVE)', re.I)

# Statewide offices and courts. Everything here is Texas/state with county null.
STATEWIDE_RE = re.compile(
    r'^(GOVERNOR|LIEUTENANT GOVERNOR|ATTORNEY GENERAL|COMPTROLLER|'
    r'COMMISSIONER OF|RAILROAD COMMISSIONER|'
    r'(CHIEF )?JUSTICE,\s*SUPREME COURT|JUDGE,\s*COURT OF CRIMINAL APPEALS|'
    r'MEMBER,\s*STATE BOARD OF EDUCATION|STATE SENATOR|STATE REPRESENTATIVE)', re.I)

COA_RE = re.compile(r'(\d+)(ST|ND|RD|TH)\s+COURT OF APPEALS', re.I)

# The 15th Court of Appeals is statewide by statute (it hears state-agency and
# business cases from anywhere in Texas). Every other numbered court of appeals
# is regional, so it is gated on the county that certified it - which is how the
# existing data treats the 2nd (Tarrant) and the 5th (Dallas + Collin).
STATEWIDE_COA = {15}


# ---------- text extraction ----------

def pdf_text(path):
    tried = []
    try:
        import pypdf
        r = pypdf.PdfReader(path)
        return '\n'.join((p.extract_text() or '') for p in r.pages)
    except ImportError:
        tried.append('pypdf')
    try:
        import PyPDF2
        r = PyPDF2.PdfReader(path)
        return '\n'.join((p.extract_text() or '') for p in r.pages)
    except ImportError:
        tried.append('PyPDF2')
    try:
        import fitz
        doc = fitz.open(path)
        return '\n'.join(pg.get_text() for pg in doc)
    except ImportError:
        tried.append('PyMuPDF')
    try:
        from pdfminer.high_level import extract_text
        return extract_text(path)
    except ImportError:
        tried.append('pdfminer.six')
    sys.exit('No PDF library found (tried %s).\n\n  pip3 install pypdf\n\n'
             'Or extract the text yourself and pass the .txt file instead, with '
             '--county NAME.' % ', '.join(tried))


# ---------- parsing ----------

def squash(s):
    """Collapse whitespace runs. pypdf emits doubled spaces inside names
    ("PHIL  SORRELLS"), which would otherwise not match the same name written
    once. Non-breaking spaces get folded in too."""
    return re.sub(r'\s+', ' ', s.replace('\u00a0', ' ')).strip()


def parse(text):
    """Returns (county_name, [(race, candidate, party), ...]) in ballot order."""
    county, rows, race = None, [], None
    warnings = []

    for raw in text.replace('\r\n', '\n').replace('\r', '\n').split('\n'):
        line = raw.strip()
        if not line or line in HEADER_LINES or FOOTER_RE.match(line):
            continue
        m = HEADER_RE.match(line)
        if m:
            if m.group(2):
                county = m.group(2).strip().title()
            continue

        # A candidate line ends in a party name; a race heading never does.
        party = next((p for p in PARTIES
                      if line.upper().endswith(' ' + p) or line.upper() == p), None)
        if party and race:
            name = squash(line[:len(line) - len(party)])
            if name:
                rows.append((race, name, party))
            else:
                warnings.append('bare party with no name: %r' % line)
            continue

        # The first race on each page carries the "Party" column header. Where it
        # lands depends on the extractor: pdfminer puts it after the race name
        # with a space, pypdf glues it to the front with none ("PartyU. S.
        # SENATOR"). Strip it either way - a leading "Party" run together with an
        # upper-case letter is never part of a real race title.
        race = squash(re.sub(r'^Party(?=[A-Z])', '', re.sub(r'\s+Party$', '', line)))

    return county, rows, warnings


def compute_election_date(text):
    """General elections are the Tuesday after the first Monday in November."""
    m = re.search(r'(\d{4})\s+NOVEMBER\s+GENERAL ELECTION', text, re.I)
    if not m:
        return None
    year = int(m.group(1))
    d = datetime.date(year, 11, 1)
    while d.weekday() != 0:                       # first Monday
        d += datetime.timedelta(days=1)
    return (d + datetime.timedelta(days=1)).isoformat()


def classify(race, county):
    """-> (jurisdiction, county_value, district). Rules read off the existing data."""
    district = None
    for pat, kind in DISTRICT_PATTERNS:
        m = pat.search(race)
        if m:
            district = {'type': kind, 'number': int(m.group(1))}
            break

    if FEDERAL_RE.match(race):
        return {'name': 'United States', 'type': 'federal'}, None, district

    coa = COA_RE.search(race)
    if coa:
        n = int(coa.group(1))
        # Statewide court -> no county gate. Regional court -> gated on this county.
        return {'name': 'Texas', 'type': 'state'}, (None if n in STATEWIDE_COA else county), district

    if STATEWIDE_RE.match(race):
        return {'name': 'Texas', 'type': 'state'}, None, district

    # Everything left is local: district and county courts, county offices,
    # commissioner and JP precincts.
    return {'name': '%s County' % county, 'type': 'county'}, county, district


def build(rows, county, election_date, source):
    per_race = {}
    for r, _, _ in rows:
        per_race[r] = per_race.get(r, 0) + 1

    out = []
    for i, (race, name, party) in enumerate(rows, start=1):
        jur, cty, dist = classify(race, county)
        out.append({
            'id': None,                    # filled in by idgen.assign_ids below
            'ballotOrder': {county: i},
            'race': race,
            'jurisdiction': jur,
            'county': cty,
            'district': dist,
            'electionDate': election_date,
            'candidate': name,
            'party': party,
            'unopposed': per_race[race] == 1,
            'sources': [source],
            'endorsements': [],
            'donations': [],
        })

    # Ids come from the record's own content, so they do not depend on which
    # county was parsed first. See tools/idgen.py.
    for base, race, cand in idgen.assign_ids(out):
        print('WARNING: duplicate id %s (%s / %s)' % (base, race, cand))
    return out


# ---------- diff against what is already in candidates.json ----------

def diff(records, county):
    if not os.path.exists('candidates.json'):
        sys.exit('candidates.json not found - run from the repo root.')
    existing = [c for c in json.load(open('candidates.json'))['candidates']
                if isinstance(c.get('ballotOrder'), dict) and county in c['ballotOrder']]
    existing.sort(key=lambda c: c['ballotOrder'][county])

    print('\n=== diff: parsed vs candidates.json (%s) ===' % county)
    print('  parsed   %d records' % len(records))
    print('  existing %d records' % len(existing))

    def key(c):
        return (c['race'], c['candidate'], c['party'])

    pk = [key(c) for c in records]
    ek = [key(c) for c in existing]
    if pk == ek:
        print('  race/candidate/party: IDENTICAL in the same order')
    else:
        ps, es = set(pk), set(ek)
        only_p, only_e = ps - es, es - ps
        print('  only in parsed   : %d' % len(only_p))
        for k in list(only_p)[:15]:
            print('      %s | %s | %s' % k)
        print('  only in existing : %d' % len(only_e))
        for k in list(only_e)[:15]:
            print('      %s | %s | %s' % k)
        if not only_p and not only_e:
            print('  same set, DIFFERENT ORDER')

    # Field-level comparison where both sides have the same slot.
    fields = ('race', 'candidate', 'party', 'unopposed', 'county', 'district', 'jurisdiction')
    mism = []
    for a, b in zip(records, existing):
        for f in fields:
            if json.dumps(a.get(f), sort_keys=True) != json.dumps(b.get(f), sort_keys=True):
                mism.append((b['ballotOrder'][county], b['id'], f, a.get(f), b.get(f)))
    print('  field mismatches in aligned slots: %d' % len(mism))
    for bo, cid, f, got, want in mism[:25]:
        print('    #%-4s %-15s %-13s parsed=%s  existing=%s'
              % (bo, cid, f, json.dumps(got), json.dumps(want)))
    if len(mism) > 25:
        print('    ... and %d more' % (len(mism) - 25))
    return not mism and pk == ek


# ---------- run ----------

ap = argparse.ArgumentParser()
ap.add_argument('path', help='certification PDF, or a .txt of its extracted text')
ap.add_argument('--county', help='override the county name (required for .txt input '
                                 'if the header line is missing)')
ap.add_argument('--date', help='election date YYYY-MM-DD (default: computed)')
ap.add_argument('-o', '--out', help='write records to this JSON file')
ap.add_argument('--diff', action='store_true', help='compare against candidates.json')
args = ap.parse_args()

text = (open(args.path, encoding='utf-8', errors='replace').read()
        if args.path.lower().endswith('.txt') else pdf_text(args.path))

county, rows, warnings = parse(text)
county = args.county or county
if not county:
    sys.exit('Could not find the "County:" line. Pass --county NAME.')

election_date = args.date or compute_election_date(text)
if not election_date:
    sys.exit('Could not determine the election date. Pass --date YYYY-MM-DD.')

source = args.path if args.path.startswith('sources/') else os.path.basename(args.path)

records = build(rows, county, election_date, source)

races = []
for r, _, _ in rows:
    if r not in races:
        races.append(r)

print('county        : %s' % county)
print('election date : %s' % election_date)
print('races         : %d' % len(races))
print('candidates    : %d' % len(records))
print('unopposed     : %d' % sum(1 for c in records if c['unopposed']))
by_party = {}
for c in records:
    by_party[c['party']] = by_party.get(c['party'], 0) + 1
print('by party      : %s' % ', '.join('%s %d' % (k, v) for k, v in sorted(by_party.items())))

for w in warnings:
    print('WARNING: %s' % w)

# A race heading that captured no candidates almost always means a candidate
# line was misread as a heading, so surface it rather than writing quietly.
empty = [r for r in races if not any(x[0] == r for x in rows)]
if empty:
    print('WARNING: races with no candidates: %s' % empty)

# A title naming a DISTRICT or PRECINCT that produced no district field almost
# always means a pattern above does not cover that county's wording. Judicial
# districts and courts of appeals legitimately carry no district, so they are
# excluded rather than reported every run.
undetected = sorted({
    r for r in races
    if re.search(r'\b(DISTRICT|PRECINCT)\b', r, re.I)
    and not any(pat.search(r) for pat, _ in DISTRICT_PATTERNS)
    and not re.search(r'JUDICIAL DISTRICT|COURT OF APPEALS|DISTRICT CLERK|'
                      r'DISTRICT ATTORNEY|CRIMINAL DISTRICT', r, re.I)})
if undetected:
    print('WARNING: district/precinct in the title but no district extracted:')
    for r in undetected:
        print('    %s' % r)

ok = True
if args.diff:
    ok = diff(records, county)

if args.out:
    with open(args.out, 'w') as fh:
        json.dump(records, fh, indent=2)
    print('\nwrote %s (%d records)' % (args.out, len(records)))

sys.exit(0 if ok else 1)
