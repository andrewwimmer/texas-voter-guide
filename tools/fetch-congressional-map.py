"""Downloads the ENACTED Texas congressional map (PLANC2333) and writes it as
GeoJSON over data/tx-congressional-districts.geojson.

Why this exists
---------------
Texas redrew its congressional districts mid-decade in 2025. The Supreme Court
allowed the new map for the 2026 midterms. State senate and state house were
NOT redrawn.

The statewide service at feature.geographic.texas.gov (Legislative_Bnd) carries
sitting-member names and is therefore drawn on the boundaries those members were
ELECTED under - the 2021 map. Validating it against Tarrant produced 57% match
on congressional while senate and house scored 99.5%. That layer is wrong for
this ballot. Its senate and house layers are fine.

The state publishes no REST service for the enacted plan, only a shapefile, so
this script parses one. Standard library only - no pyshp, no GDAL, nothing to
install.

Run from the repo root, in a regular terminal (needs network):
    python3 tools/fetch-congressional-map.py

Source: Texas Legislative Council, Capitol Data Portal
  https://data.capitol.texas.gov/dataset/planc2333
"""

import io
import json
import math
import os
import re
import struct
import sys
import urllib.request
import zipfile

URL = ("https://data.capitol.texas.gov/dataset/748c952b-e926-4f44-8d01-a738884b3ec8"
       "/resource/5712ebe1-d777-4d4a-b836-0534e17bca01/download/planc2333.zip")
OUT = "data/tx-congressional-districts.geojson"

# Texas, generously bounded. Coordinates outside this mean the shapefile was in
# a projected system and the output would be silently wrong.
TX = (-107.5, -93.0, 25.0, 37.0)


# ---------- Lambert Conformal Conic, inverse ----------
# The TLC plan shapefiles are projected, not lon/lat, so the coordinates have to
# be converted before they can be tested against the precinct files. Parameters
# are read from the .prj rather than assumed. Snyder, Map Projections - A
# Working Manual, USGS PP 1395, pp. 104-110.
#
# NAD83 and WGS84 are treated as equivalent here. They differ by roughly a
# metre, which cannot move a point across a district boundary in any way that
# matters for assigning a ballot.

def parse_wkt(prj):
    def param(name, default=None):
        m = re.search(r'PARAMETER\s*\[\s*"%s"\s*,\s*(-?[\d.eE+]+)' % name, prj, re.I)
        return float(m.group(1)) if m else default
    sph = re.search(r'SPHEROID\s*\[\s*"[^"]*"\s*,\s*([\d.eE+]+)\s*,\s*([\d.eE+]+)', prj, re.I)
    if not sph:
        sys.exit('Could not read the spheroid from the .prj:\n' + prj[:300])
    a, invf = float(sph.group(1)), float(sph.group(2))
    units = re.findall(r'UNIT\s*\[\s*"([^"]*)"\s*,\s*([\d.eE+]+)', prj, re.I)
    uname, ufac = units[-1]          # the PROJCS unit is the last one in the WKT
    cfg = dict(a=a, f=(1.0 / invf if invf else 0.0),
               lat1=param('Standard_Parallel_1'), lat2=param('Standard_Parallel_2'),
               lat0=param('Latitude_Of_Origin'), lon0=param('Central_Meridian'),
               fe=param('False_Easting', 0.0), fn=param('False_Northing', 0.0),
               unit=uname, ufac=float(ufac))
    missing = [k for k in ('lat1', 'lat2', 'lat0', 'lon0') if cfg[k] is None]
    if missing:
        sys.exit('.prj is missing %s - cannot reproject.\n%s' % (missing, prj[:300]))
    return cfg


def lcc_inverse(cfg):
    """Returns a function mapping projected (x, y) to (lon, lat) in degrees."""
    a, f = cfg['a'], cfg['f']
    e = math.sqrt(2 * f - f * f)

    def m(lat):
        return math.cos(lat) / math.sqrt(1 - e * e * math.sin(lat) ** 2)

    def t(lat):
        s = e * math.sin(lat)
        return math.tan(math.pi / 4 - lat / 2) / (((1 - s) / (1 + s)) ** (e / 2))

    l1, l2, l0 = (math.radians(cfg[k]) for k in ('lat1', 'lat2', 'lat0'))
    n = (math.log(m(l1)) - math.log(m(l2))) / (math.log(t(l1)) - math.log(t(l2)))
    F = m(l1) / (n * t(l1) ** n)
    rho0 = a * F * t(l0) ** n
    fe, fn, ufac, lon0 = cfg['fe'], cfg['fn'], cfg['ufac'], math.radians(cfg['lon0'])

    def inv(x, y):
        if ufac != 1.0:
            x, y = x * ufac, y * ufac
        xp, yp = x - fe, y - fn
        rho = math.copysign(math.hypot(xp, rho0 - yp), n)
        tp = (rho / (a * F)) ** (1.0 / n)
        lon = math.degrees(math.atan2(xp, rho0 - yp) / n + lon0)
        lat = math.pi / 2 - 2 * math.atan(tp)
        for _ in range(30):
            s = e * math.sin(lat)
            new = math.pi / 2 - 2 * math.atan(tp * ((1 - s) / (1 + s)) ** (e / 2))
            if abs(new - lat) < 1e-12:
                lat = new
                break
            lat = new
        return [lon, math.degrees(lat)]
    return inv


def reproject(geom, inv):
    polys = [geom['coordinates']] if geom['type'] == 'Polygon' else geom['coordinates']
    out = [[[inv(c[0], c[1]) for c in ring] for ring in poly] for poly in polys]
    return {'type': geom['type'],
            'coordinates': out[0] if geom['type'] == 'Polygon' else out}


# ---------- dBase III (.dbf) ----------

def read_dbf(buf):
    """Returns a list of dicts, one per record. Only the field types the TLC
    plan files actually use (C, N, F, L, D) are handled."""
    n_records, header_len, record_len = struct.unpack('<I2H', buf[4:12])
    fields, pos = [], 32
    while buf[pos] != 0x0D:
        raw = buf[pos:pos + 32]
        name = raw[0:11].split(b'\x00')[0].decode('latin-1').strip()
        ftype = chr(raw[11])
        flen = raw[16]
        fields.append((name, ftype, flen))
        pos += 32

    rows = []
    for i in range(n_records):
        start = header_len + i * record_len
        rec = buf[start:start + record_len]
        if not rec or rec[0:1] == b'*':      # deleted
            continue
        off, row = 1, {}
        for name, ftype, flen in fields:
            val = rec[off:off + flen].decode('latin-1').strip()
            off += flen
            if ftype in 'NF':
                try:
                    val = float(val) if '.' in val else int(val)
                except ValueError:
                    val = None
            elif ftype == 'L':
                val = val.upper() in ('Y', 'T')
            row[name] = val
        rows.append(row)
    return rows


# ---------- ESRI shapefile (.shp), polygons only ----------

def signed_area(ring):
    """Shoelace. Negative means clockwise, which the shapefile spec uses for
    outer rings; counter-clockwise parts are holes in the preceding outer ring."""
    s = 0.0
    for i in range(len(ring) - 1):
        s += (ring[i][0] * ring[i + 1][1]) - (ring[i + 1][0] * ring[i][1])
    return s / 2.0


def read_shp(buf):
    """Returns one GeoJSON geometry per record, in file order."""
    file_type = struct.unpack('<i', buf[32:36])[0]
    if file_type != 5:
        sys.exit('Expected polygon shapefile (type 5), got type %d' % file_type)

    geoms, pos, end = [], 100, len(buf)
    while pos < end:
        _, content_len = struct.unpack('>2i', buf[pos:pos + 8])
        pos += 8
        rec_end = pos + content_len * 2
        shape_type = struct.unpack('<i', buf[pos:pos + 4])[0]

        if shape_type == 0:                      # null shape
            geoms.append(None)
            pos = rec_end
            continue

        n_parts, n_points = struct.unpack('<2i', buf[pos + 36:pos + 44])
        p = pos + 44
        parts = list(struct.unpack('<%di' % n_parts, buf[p:p + 4 * n_parts]))
        p += 4 * n_parts
        coords = struct.unpack('<%dd' % (2 * n_points), buf[p:p + 16 * n_points])

        rings = []
        parts.append(n_points)
        for k in range(n_parts):
            a, b = parts[k], parts[k + 1]
            ring = [[coords[2 * i], coords[2 * i + 1]] for i in range(a, b)]
            if ring and ring[0] != ring[-1]:
                ring.append(ring[0])             # GeoJSON requires closure
            rings.append(ring)

        # Split into polygons: a clockwise ring opens a new polygon, a
        # counter-clockwise ring is a hole on the current one.
        polys = []
        for ring in rings:
            if signed_area(ring) < 0 or not polys:
                polys.append([ring])
            else:
                polys[-1].append(ring)

        geoms.append({'type': 'Polygon', 'coordinates': polys[0]} if len(polys) == 1
                     else {'type': 'MultiPolygon', 'coordinates': polys})
        pos = rec_end
    return geoms


# ---------- run ----------

# Either download it, or read a copy already on disk:
#     python3 tools/fetch-congressional-map.py ~/Downloads/planc2333.zip
local = sys.argv[1] if len(sys.argv) > 1 else None

if local:
    local = os.path.expanduser(local)
    if not os.path.exists(local):
        sys.exit('No such file: %s' % local)
    print('Reading PLANC2333 from %s' % local)
    with open(local, 'rb') as fh:
        blob = fh.read()
else:
    print('Downloading PLANC2333 from the Texas Legislative Council...')
    # The portal rejects the default Python user agent with a 403, so send a
    # browser-shaped one. This is a public government data file; the header is
    # only here because the CDN filters on it.
    req = urllib.request.Request(URL, headers={
        'User-Agent': ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                       'AppleWebKit/537.36 (KHTML, like Gecko) '
                       'Chrome/140.0.0.0 Safari/537.36'),
        'Accept': '*/*',
    })
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            blob = r.read()
    except Exception as e:
        sys.exit(
            'Download failed: %s\n\n'
            'Fallback - download it in a browser, then point this script at the file:\n'
            '  1. Open https://data.capitol.texas.gov/dataset/planc2333\n'
            '  2. Download PLANC2333.zip (about 4.7 MB)\n'
            '  3. python3 tools/fetch-congressional-map.py ~/Downloads/planc2333.zip\n'
            % e)
print('  %.1f MB' % (len(blob) / 1048576.0))

if not blob.startswith(b'PK'):
    sys.exit('That file is not a zip archive (starts with %r). If you downloaded it\n'
             'in a browser, check you saved the .zip and not an HTML error page.'
             % blob[:8])

zf = zipfile.ZipFile(io.BytesIO(blob))
names = zf.namelist()


def member(ext):
    hits = [n for n in names if n.lower().endswith(ext)]
    if not hits:
        sys.exit('No %s in the archive. Contents: %s' % (ext, names))
    return hits[0]


prj = zf.read(member('.prj')).decode('latin-1', 'replace')
print('  projection: %s' % prj[:70].split(',')[0].replace('PROJCS["', '').replace('GEOGCS["', ''))

inv = None
if 'PROJCS' in prj.upper():
    if not re.search(r'PROJECTION\s*\[\s*"Lambert_Conformal_Conic"', prj, re.I):
        sys.exit('Projected, but not Lambert Conformal Conic. Only LCC is implemented.\n'
                 'PRJ: ' + prj[:300])
    cfg = parse_wkt(prj)
    print('    LCC: standard parallels %g/%g, origin %g, central meridian %g, '
          'false E/N %g/%g, unit %s'
          % (cfg['lat1'], cfg['lat2'], cfg['lat0'], cfg['lon0'],
             cfg['fe'], cfg['fn'], cfg['unit']))
    inv = lcc_inverse(cfg)

geoms = read_shp(zf.read(member('.shp')))
if inv:
    print('  reprojecting to lon/lat...')
    geoms = [reproject(g, inv) if g else None for g in geoms]
rows = read_dbf(zf.read(member('.dbf')))
print('  %d shapes, %d attribute rows' % (len(geoms), len(rows)))
if len(geoms) != len(rows):
    sys.exit('Shape count and attribute count disagree - refusing to write.')

# The district number column is whichever field holds distinct small integers.
key = None
for name in (rows[0].keys() if rows else []):
    vals = [r.get(name) for r in rows]
    if len(set(map(str, vals))) == len(vals) and all(
            str(v).strip().isdigit() and 0 < int(v) < 100 for v in vals if v is not None):
        key = name
        if 'dist' in name.lower():
            break
if not key:
    sys.exit('Could not identify the district-number column. Fields: %s' % list(rows[0].keys()))
print('  district column: "%s"' % key)

features = []
for g, r in zip(geoms, rows):
    if g is None:
        continue
    features.append({'type': 'Feature',
                     'properties': {'district': str(r[key]).strip()},
                     'geometry': g})

# Verify before writing. A silently wrong congressional map is exactly the
# failure this whole exercise exists to prevent.
districts = sorted(int(f['properties']['district']) for f in features)
print('  districts: %d..%d (%d total)' % (districts[0], districts[-1], len(districts)))
if len(set(districts)) != len(districts):
    sys.exit('Duplicate district numbers - refusing to write.')

xs, ys = [], []
for f in features:
    polys = [f['geometry']['coordinates']] if f['geometry']['type'] == 'Polygon' \
            else f['geometry']['coordinates']
    for poly in polys:
        for c in poly[0]:
            xs.append(c[0])
            ys.append(c[1])
print('  extent: %.2f..%.2f lon, %.2f..%.2f lat' % (min(xs), max(xs), min(ys), max(ys)))
if not (TX[0] <= min(xs) and max(xs) <= TX[1] and TX[2] <= min(ys) and max(ys) <= TX[3]):
    sys.exit('Coordinates fall outside Texas - the file is not lon/lat. Refusing to write.')

os.makedirs('data', exist_ok=True)
with open(OUT, 'w') as fh:
    json.dump({'type': 'FeatureCollection', 'features': features}, fh)
print('\nWrote %s (%.1f MB)' % (OUT, os.path.getsize(OUT) / 1048576.0))
print('Now run:  python3 tools/validate-district-join.py')
