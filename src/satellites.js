const EARTH_R_KM = 6371;
const DEG = Math.PI / 180;

// ── TLE fetch ────────────────────────────────────────────────

export async function fetchGroup(url, group, color, filterFn = null) {
  try {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(resp.status);
    const text = await resp.text();
    if (!text.trim()) throw new Error('empty');
    const parsed = parseTLE(text, group, color);
    return filterFn ? parsed.filter(s => filterFn(s.name)) : parsed;
  } catch (err) {
    console.warn(`[argos] ${group} fetch failed:`, err.message);
    return getFallback(group, color);
  }
}

// ── TLE parser ───────────────────────────────────────────────

function parseTLE(text, group, color) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const sats  = [];

  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name  = lines[i].replace(/^0\s+/, '').trim();
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];

    if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) { i -= 2; continue; }

    try {
      const satrec  = window.satellite.twoline2satrec(line1, line2);
      const noradId = line1.slice(2, 7).trim();
      const intlDes = line1.slice(9, 17).trim();

      const epochYr = parseInt(line1.slice(18, 20), 10);
      const epochDy = parseFloat(line1.slice(20, 32));
      const fullYr  = epochYr < 57 ? 2000 + epochYr : 1900 + epochYr;
      const epochDate = new Date(Date.UTC(fullYr, 0, 1));
      epochDate.setUTCDate(epochDate.getUTCDate() + Math.floor(epochDy) - 1);

      const inc        = parseFloat(line2.slice(8, 16));
      const ecc        = parseFloat('0.' + line2.slice(26, 33));
      const meanMotion = parseFloat(line2.slice(52, 63));
      const period     = meanMotion > 0 ? 1440 / meanMotion : null;

      sats.push({ name, noradId, intlDes, satrec, group, color, inc, ecc, period,
                  epoch: epochDate.toISOString().slice(0, 10) });
    } catch { /* skip bad TLE */ }
  }
  return sats;
}

// ── SGP4 propagation ─────────────────────────────────────────

export function propagate(satellites, now) {
  return satellites.map(sat => {
    try {
      const pv   = window.satellite.propagate(sat.satrec, now);
      if (!pv || !pv.position || typeof pv.position !== 'object') return invalid(sat);

      const gmst = window.satellite.gstime(now);
      const gd   = window.satellite.eciToGeodetic(pv.position, gmst);

      const lat = window.satellite.degreesLat(gd.latitude);
      const lon = window.satellite.degreesLong(gd.longitude);
      const alt = gd.height;

      if (!isFinite(lat) || !isFinite(lon) || !isFinite(alt) || alt < -100) return invalid(sat);

      const r = 1.0 + alt / EARTH_R_KM;
      const { x, y, z } = toXYZ(lat, lon, r);

      const v = pv.velocity;
      const speed = v ? Math.sqrt(v.x**2 + v.y**2 + v.z**2) : 0;

      return { ...sat, valid: true, lat, lon, alt, x, y, z, speed };
    } catch {
      return invalid(sat);
    }
  });
}

function invalid(sat) { return { ...sat, valid: false }; }

export function toXYZ(lat, lon, r) {
  const phi   = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return {
    x: -r * Math.sin(phi) * Math.cos(theta),
    y:  r * Math.cos(phi),
    z:  r * Math.sin(phi) * Math.sin(theta),
  };
}

// ── India visibility check ───────────────────────────────────
// Returns true if the satellite's 0° elevation footprint covers
// any part of the Indian subcontinent.

const INDIA_CENTER_LAT = 22;
const INDIA_CENTER_LON = 80;
const INDIA_HALF_EXTENT = 18; // degrees — covers the subcontinent from Lakshadweep to Ladakh

function greatCircleDeg(lat1, lon1, lat2, lon2) {
  const a = Math.sin((lat2 - lat1) * DEG / 2) ** 2
    + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG)
    * Math.sin((lon2 - lon1) * DEG / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) / DEG;
}

export function isVisibleFromIndia(lat, lon, altKm) {
  const alt = Math.max(altKm ?? 0, 100);
  const coverageHalfAngle = Math.acos(EARTH_R_KM / (EARTH_R_KM + alt)) / DEG;
  const dist = greatCircleDeg(lat, lon, INDIA_CENTER_LAT, INDIA_CENTER_LON);
  return dist < coverageHalfAngle + INDIA_HALF_EXTENT;
}

// ── Fallback TLEs ────────────────────────────────────────────

function getFallback(group, color) {
  if (group !== 'tiangong') return [];
  return parseTLE(`CSS (TIANHE)
1 48274U 21035A   24096.50000000  .00016717  00000-0  10270-3 0  9000
2 48274  41.4748 208.9163 0003219  86.9745 273.2099 15.60000000430000`, group, color);
}
