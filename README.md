# Tarrant County Voter Guide

A static voter guide for Tarrant County, Texas. Races are listed in certified
ballot order by default — one continuous list, in the sequence a voter meets at
the polls — and can be regrouped by jurisdiction (federal, state, or county)
with the Order control. Every endorsement and donation shows a clickable link to
its source. An address lookup narrows the page to the races a given address
actually votes in.

Candidate data is extracted from the Texas Secretary of State's certified ballot
reports for the November 3, 2026 general election in Tarrant, Dallas, and Collin
counties, plus Tarrant Appraisal District sources for the TAD board races, which
appear on no certification report. Every source is listed, with a link to the
record it came from, on the site's Sources page (`sources.html`).

> **⚠️ Endorsement and donation data is not populated yet.** Race names,
> candidate names, and party labels in `candidates.json` are real, but the
> `endorsements` and `donations` arrays are empty for every candidate.

## Stack

Plain HTML, CSS, and vanilla JavaScript. No framework, no build step, no
dependencies.

| File | Purpose |
| --- | --- |
| `index.html` | Page shell, filter controls |
| `styles.css` | All styling |
| `app.js` | Loads the JSON, filters, groups, renders, and runs the address lookup |
| `candidates.json` | The entire dataset |
| `data/precincts.geojson` | 707 Tarrant County voting precincts with their district assignments |

## Running locally

`app.js` fetches `candidates.json`, and browsers block `fetch` over `file://`,
so serve the folder over HTTP:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Address lookup

The "Find the races on your ballot" form turns a street address into a filtered
ballot in three steps:

1. **Geocode.** The address goes to the U.S. Census Bureau's free public
   geocoder (`geocoding.geo.census.gov`, `onelineaddress` endpoint,
   `benchmark=Public_AR_Current`, no API key), which returns a lat/lon.
2. **Locate.** `data/precincts.geojson` is tested point-in-polygon in the
   browser to find the containing precinct. The ray-casting test is hand-written
   in `app.js` — no mapping library. Each feature's bounding box is precomputed
   on load so a lookup rejects almost every precinct with four numeric
   comparisons; a lookup runs in well under a millisecond.
3. **Filter.** The precinct's `Congress`, `Senate`, `House`, `Education`,
   `Commish`, and `JP` values select the district races, which are shown
   alongside every countywide and statewide race.

The matched precinct number and all six districts are displayed, so a voter can
see exactly why they were given those races. "Show all races" returns to the
full county-wide list at any time.

### Privacy

The address is sent to the Census geocoder and nowhere else. This site is static
files with no server, so it cannot receive, store, or log an address; the
precinct match happens entirely on the visitor's device. The page states this
next to the input.

The Census geocoder does not send an `Access-Control-Allow-Origin` header, so a
plain `fetch` is blocked by CORS from a static origin. The lookup therefore uses
the geocoder's documented JSONP mode, which is why the response arrives via a
`<script>` tag. It is constrained to a single-use callback name and a 15-second
timeout, the tag is removed either way, and the payload's shape is validated
before anything is read out of it.

### Lazy loading

`data/precincts.geojson` is 4.7 MB and is **not** fetched on page load. It is
requested the first time a visitor focuses the address field, so it is usually
cached by the time the geocode returns. A visitor who never uses the lookup
never downloads it. A failed load is not cached, so retrying re-fetches.

### Staggered terms

Texas staggers its state senate, State Board of Education, and county
commissioner terms, so an address can sit in a district with no race this cycle
— in 2026 that is Senate districts 10, 12, and 23, SBOE district 11, and
commissioner precincts 1 and 3. Those are labelled "not on the 2026 ballot"
rather than silently omitted.

### Failure handling

Geocoder unreachable, geocoder timeout, address not found, address outside
Tarrant County, and precinct file unavailable each produce a distinct message,
and the full race list stays browsable in every case.

## Data format

`candidates.json` is a single object with `meta` and a `candidates` array. Each
candidate entry is one candidate in one race:

```json
{
  "id": "tc-2026-11-001",
  "ballotOrder": { "Tarrant": 1 },
  "race": "U. S. SENATOR",
  "jurisdiction": { "name": "United States", "type": "federal" },
  "electionDate": "2026-11-03",
  "candidate": "KEN PAXTON",
  "party": "REPUBLICAN",
  "unopposed": false,
  "sources": ["sources/ballot-certification-2026-11-03.pdf"],
  "endorsements": [],
  "donations": []
}
```

Field notes:

- `ballotOrder` is an object keyed by county name, whose value is the entry's
  1-based position in that county's certification report, numbered straight
  through the whole ballot. It is keyed by county because the same statewide
  candidate sits at a different position on each county's ballot. It orders
  races against each other and candidates within a race, and it is the only
  ordering the default view uses — candidates are never re-sorted by name,
  because on a ballot name order is not the order. A candidate with no entry
  for the county in view sorts last, after every candidate that has one.
- `jurisdiction.type` must be `"federal"`, `"state"`, or `"county"` — the type
  filter and the jurisdiction badge both key off it.
- `county` says which county's voters see the race:
  - A county name for county-level races, and for commissioner, justice of
    the peace, and constable races, because those district numbers restart in
    every county.
  - `null` for statewide races and for state and federal district races
    (U.S. House, state senate, state house, SBOE), because those numbers mean
    the same thing statewide.
  - A county name on regional court of appeals races, which are stored with
    jurisdiction `Texas` / `"state"`, because county is the only gate
    available for them.
  - A list of county names when a regional court spans more than one loaded
    county (the 5th Court of Appeals covers Dallas and Collin). Order doesn't
    matter; the code sorts it.
- `party` is the party name exactly as printed on the certification report:
  `REPUBLICAN`, `DEMOCRATIC`, `LIBERTARIAN`, or `GREEN` — or `null` for an
  office that is nonpartisan by law, where no source prints a party because
  there is none to print. Appraisal district board seats are the only such
  races today. `null` is not "party unknown": a nonpartisan candidate is
  never dimmed by a party selection, never makes their race count as one the
  selected party left uncontested, and is never dropped from the printed
  slate. The site labels them "Nonpartisan" where a party chip would go.
- `unopposed` is `true` when the race has only one certified candidate.
- `sources` is an array of the records the candidate entry was extracted from,
  one entry per record. It is an array so an entry assembled from more than one
  certification report can name all of them; today every record carries exactly
  one. Nothing in the site renders it yet.
- Candidates are grouped into a race by `race` + `electionDate` + `county`, so
  those three values must match exactly across every candidate in the same
  contest. Two counties' identically titled offices stay separate races.
- Dates are `YYYY-MM-DD` and are formatted for display; anything else is printed
  as-is.
- `sourceUrl` is required on every endorsement and donation. Only `http://` and
  `https://` URLs are rendered as links; anything else is shown as plain text
  noting the source URL is missing or invalid.
- `sourceLabel` is the link text. `note` and `amount` are optional.
- Empty `endorsements` / `donations` arrays render as "No endorsements recorded."

### District race names

The address filter maps a race to a precinct property by its title, so these
patterns must stay exact or the race will be treated as countywide:

| Precinct property | Race title pattern |
| --- | --- |
| `Congress` | `U. S. REPRESENTATIVE DISTRICT <n>` |
| `Senate` | `STATE SENATOR, DISTRICT <n>` |
| `House` | `STATE REPRESENTATIVE DISTRICT <n>` |
| `Education` | `MEMBER, STATE BOARD OF EDUCATION, DISTRICT <n>` |
| `Commish` | `COUNTY COMMISSIONER PRECINCT <n>` |
| `JP` | `JUSTICE OF THE PEACE PRECINCT <n>` |

Every other race is treated as countywide or statewide and shown to everyone.
That deliberately includes the judicial races, whose titles also contain the
word "district" (`DISTRICT JUDGE, 141ST JUDICIAL DISTRICT`, `JUSTICE, 2ND COURT
OF APPEALS DISTRICT, PLACE 7`): those are elected countywide, not by precinct.

## Adding data

Edit `candidates.json` and reload. There is nothing to rebuild.

## Deployment

Served by GitHub Pages from the `main` branch, repo root.
