"""Rewrites the ids in candidates.json to the content-derived scheme.

    python3 tools/migrate-ids.py            # dry run - shows what would change
    python3 tools/migrate-ids.py --write    # apply

Only the id field is touched. Every other field, and the order of records in the
file, is left exactly as it was, so `git diff` after a --write should show one
changed line per record and nothing else.

Why: see tools/idgen.py. Short version - the old per-county sequence collides
across 254 counties and depends on which county was parsed first.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import idgen

ap = argparse.ArgumentParser()
ap.add_argument('--write', action='store_true', help='apply the change')
ap.add_argument('--file', default='candidates.json')
args = ap.parse_args()

if not os.path.exists(args.file):
    sys.exit('%s not found - run from the repo root.' % args.file)

with open(args.file) as fh:
    doc = json.load(fh)
records = doc['candidates']
old_ids = [c.get('id') for c in records]

collisions = idgen.assign_ids(records)
new_ids = [c['id'] for c in records]

print('records        : %d' % len(records))
print('unique old ids : %d' % len(set(old_ids)))
print('unique new ids : %d' % len(set(new_ids)))
print('changed        : %d' % sum(1 for a, b in zip(old_ids, new_ids) if a != b))
print('longest new id : %d chars' % max(len(i) for i in new_ids))

if len(set(new_ids)) != len(records):
    print('\nERROR: new ids are not unique. Refusing to write.')
    for base, race, cand in collisions:
        print('  %s  (%s / %s)' % (base, race, cand))
    sys.exit(1)
if collisions:
    print('\nWARNING: %d collisions were suffixed:' % len(collisions))
    for base, race, cand in collisions:
        print('  %s  (%s / %s)' % (base, race, cand))

print('\nsample (old -> new):')
for a, b in list(zip(old_ids, new_ids))[:6]:
    print('  %-16s -> %s' % (a, b))
print('  ...')
longest = max(new_ids, key=len)
print('  longest: %s' % longest)

if not args.write:
    print('\nDry run. Nothing written. Re-run with --write to apply.')
    sys.exit(0)

# Preserve the file's existing formatting conventions as closely as possible.
with open(args.file, 'w') as fh:
    json.dump(doc, fh, indent=2, ensure_ascii=False)
    fh.write('\n')
print('\nWrote %s' % args.file)
print('Check with: git diff --stat %s' % args.file)
