import { initGlobe, renderSatellites, renderFootprint, renderGroundTrack, resumeAutoRotate } from './globe.js';
import { fetchGroup, propagate, isVisibleFromIndia } from './satellites.js';
import {
  tickClock, initSearch, initFilters, updateFilterCounts,
  showSelected, updateSelectedPos, showPopup, updatePopupPos,
  initPopupClose, setLoadingStatus, hideLoading, initMapCredit,
  updateIndiaCount,
} from './ui.js';

// ── Chinese satellite groups ─────────────────────────────────
// Sources: CelesTrak GP catalog (Dr. T.S. Kelso)

const GROUPS = {
  'chinese-leo': {
    url:   'https://celestrak.org/NORAD/elements/gp.php?GROUP=chinese&FORMAT=tle',
    color: 0xff4444,
  },
  'beidou': {
    url:   'https://celestrak.org/NORAD/elements/gp.php?GROUP=beidou&FORMAT=tle',
    color: 0xffb300,
  },
  'tiangong': {
    // Filter Tiangong CSS modules from the stations feed
    url:      'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
    color:    0x00d4ff,
    filterFn: name => {
      const n = name.toUpperCase();
      return n.includes('TIANHE') || n.includes('TIANGONG') ||
             n.includes('WENTIAN') || n.includes('MENGTIAN') || n.includes('CSS');
    },
  },
};

// ── State ────────────────────────────────────────────────────

let allSats       = [];
let activeGroups  = new Set(Object.keys(GROUPS));
let selectedSat   = null;
let lastPositions = [];

// ── Boot ─────────────────────────────────────────────────────

async function boot() {
  const canvas = document.getElementById('globe-canvas');

  setLoadingStatus('Loading Earth model…');
  await initGlobe(canvas, onSatelliteClick);

  initPopupClose(() => {
    selectedSat = null;
    renderFootprint(null);
    renderGroundTrack(null);
    resumeAutoRotate();
  });
  initMapCredit();
  initFilters((group, active) => {
    if (active) activeGroups.add(group);
    else        activeGroups.delete(group);
  });
  initSearch(() => allSats, onSatelliteClick);

  setLoadingStatus('Fetching Chinese satellite TLE data…');
  const results = await Promise.allSettled(
    Object.entries(GROUPS).map(([grp, cfg]) =>
      fetchGroup(cfg.url, grp, cfg.color, cfg.filterFn)
    )
  );

  results.forEach(r => { if (r.status === 'fulfilled') allSats.push(...r.value); });

  const counts = {};
  Object.keys(GROUPS).forEach(grp => {
    counts[grp] = allSats.filter(s => s.group === grp).length;
  });
  updateFilterCounts(counts);
  document.getElementById('tracked-count').textContent =
    allSats.length.toLocaleString();

  hideLoading();
  tick();
}

// ── Animation tick ───────────────────────────────────────────

function tick() {
  requestAnimationFrame(tick);
  tickClock();

  const now     = new Date();
  const visible = allSats.filter(s => activeGroups.has(s.group));
  lastPositions = propagate(visible, now);

  renderSatellites(lastPositions);

  // Count satellites whose footprint covers the Indian subcontinent
  const indiaCount = lastPositions.filter(
    p => p.valid && isVisibleFromIndia(p.lat, p.lon, p.alt)
  ).length;
  updateIndiaCount(indiaCount);

  if (selectedSat) {
    const pos = lastPositions.find(p => p.noradId === selectedSat.noradId);
    if (pos?.valid) {
      updateSelectedPos(pos);
      updatePopupPos(pos);
      renderFootprint(pos);
    }
  }
}

// ── Satellite click handler ──────────────────────────────────

function onSatelliteClick(sat) {
  selectedSat = sat;
  const now = new Date();
  const pos = propagate([sat], now)[0];
  showSelected(sat);
  showPopup(sat, pos);
  renderFootprint(pos?.valid ? pos : null);
  renderGroundTrack(sat);
}

boot();
