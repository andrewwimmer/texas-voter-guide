"""Record ids derived from the record itself, so they never depend on the order
counties were loaded in.

The old scheme was a per-county sequence with a two-letter prefix
(tc-2026-11-001). Two problems with it:

  * Two letters collide across 254 counties. Harris, Houston, Hays and Hidalgo
    all want "hc"; Dallas and Denton both want "dc"; Collin, Cameron and Comal
    all want "cc".
  * Worse, the id depended on processing order. A statewide race belongs to
    whichever county happened to be parsed first, so KEN PAXTON for U. S.
    SENATOR was "tc-..." only because Tarrant went first. Reprocess in another
    order and every shared record's id changes - which breaks the moment
    endorsements or finance records point at them.

The natural key is what actually identifies a record: election date, race,
candidate, and - only for county-local offices - the county.

    2026-11-03-u-s-senator-ken-paxton
    2026-11-03-tarrant-county-judge-tim-ohare

County is deliberately left out of state and federal ids, INCLUDING regional
courts of appeals. The 5th Court of Appeals covers Dallas and Collin today and
more counties as they load; if its county list were in the id, adding a county
would rewrite it. jurisdiction.type == 'county' is the test, because that is
exactly the set of offices whose meaning is county-scoped.
"""

import re
import unicodedata


def slugify(value):
    """Lower-case, punctuation removed, words joined by hyphens.

    Apostrophes and quotes are dropped rather than replaced, so O'HARE becomes
    "ohare" and not "o-hare", and ANGELA "HELI" RODRIGUEZ becomes
    "angela-heli-rodriguez". Everything else non-alphanumeric becomes a
    separator, which handles "U. S. SENATOR", "RAMON ROMERO, JR" and
    "PAIGE PAYNE - NEAL" without special cases.
    """
    s = unicodedata.normalize('NFKD', str(value))
    s = s.encode('ascii', 'ignore').decode('ascii')
    s = re.sub(r"['‘’\"“”]", '', s)
    s = re.sub(r'[^A-Za-z0-9]+', '-', s)
    return re.sub(r'-{2,}', '-', s).strip('-').lower()


def make_id(record):
    """Stable id for one candidate record."""
    parts = [record['electionDate']]

    jur = record.get('jurisdiction') or {}
    if jur.get('type') == 'county':
        county = record.get('county')
        if isinstance(county, list):
            # Should not happen - a county-local office belongs to one county -
            # but sort so the result is at least deterministic if it ever does.
            county = sorted(county)[0] if county else None
        if county:
            parts.append(slugify(county))

    parts.append(slugify(record['race']))
    parts.append(slugify(record['candidate']))
    return '-'.join(p for p in parts if p)


def assign_ids(records):
    """Sets .id on every record. Returns the list of collisions found.

    A collision means two records share an election date, race, county and
    candidate name, which should be impossible. They get a numeric suffix so the
    file stays usable, and are reported so the cause can be looked at.
    """
    seen, collisions = {}, []
    for rec in records:
        base = make_id(rec)
        if base in seen:
            seen[base] += 1
            collisions.append((base, rec.get('race'), rec.get('candidate')))
            rec['id'] = '%s-%d' % (base, seen[base])
        else:
            seen[base] = 1
            rec['id'] = base
    return collisions
