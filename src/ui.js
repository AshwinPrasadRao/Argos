// ── Clock ────────────────────────────────────────────────────

export function tickClock() {
  const now    = new Date();
  const pad    = n => String(n).padStart(2, '0');
  const time   = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
  const days   = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const date   = `${days[now.getUTCDay()]} ${pad(now.getUTCDate())} ${months[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  setText('utc-clock', time);
  setText('utc-date',  date);
}

// ── India coverage count ──────────────────────────────────────

export function updateIndiaCount(n) {
  const val = n.toLocaleString();
  setText('india-count', val);
  setText('india-count-sidebar', val);
  const badge = document.getElementById('india-badge');
  if (badge) badge.classList.toggle('india-badge-alert', n > 0);
}

// ── Search ───────────────────────────────────────────────────

export function initSearch(getSatellites, onSelect) {
  const input   = document.getElementById('search-input');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.innerHTML = ''; results.classList.remove('open'); return; }

    const matches = getSatellites()
      .filter(s => s.name.toLowerCase().includes(q) || s.noradId.includes(q))
      .slice(0, 24);

    if (!matches.length) { results.innerHTML = ''; results.classList.remove('open'); return; }

    results.innerHTML = matches.map(s => `
      <div class="sr-item" data-norad="${s.noradId}">
        <span class="sr-dot" style="background:${colorHex(s.color)}"></span>
        <span class="sr-name">${s.name}</span>
        <span class="sr-norad">${s.noradId}</span>
      </div>`).join('');
    results.classList.add('open');

    results.querySelectorAll('.sr-item').forEach(el => {
      el.addEventListener('click', () => {
        const sat = getSatellites().find(s => s.noradId === el.dataset.norad);
        if (sat) { onSelect(sat); input.value = sat.name; results.innerHTML = ''; results.classList.remove('open'); }
      });
    });
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#search-container')) {
      results.innerHTML = '';
      results.classList.remove('open');
    }
  });
}

// ── Filters ──────────────────────────────────────────────────

export function initFilters(onChange) {
  document.getElementById('filter-list').addEventListener('click', e => {
    const row = e.target.closest('.filter-row');
    if (!row) return;
    row.classList.toggle('active');
    onChange(row.dataset.group, row.classList.contains('active'));
  });
}

export function updateFilterCounts(counts) {
  Object.entries(counts).forEach(([grp, n]) => {
    const el = document.getElementById(`count-${grp}`);
    if (el) el.textContent = n.toLocaleString();
  });
}

// ── Selected satellite panel ──────────────────────────────────

export function showSelected(sat) {
  const panel = document.getElementById('sel-panel');
  panel.style.display = 'block';
  setText('sel-name',  sat.name);
  setText('sel-norad', `NORAD ${sat.noradId}`);
  setText('header-selected', sat.name.length > 16 ? sat.name.slice(0, 16) + '…' : sat.name);
  updateSelectedPos(sat);
}

export function updateSelectedPos(pos) {
  if (pos.valid !== false) {
    setText('sel-alt',   pos.alt   != null ? `${pos.alt.toFixed(0)} km`    : '—');
    setText('sel-speed', pos.speed != null ? `${pos.speed.toFixed(2)} km/s` : '—');
    setText('sel-lat',   pos.lat   != null ? `${pos.lat.toFixed(4)}°`      : '—');
    setText('sel-lon',   pos.lon   != null ? `${pos.lon.toFixed(4)}°`      : '—');
  }
  setText('sel-inc',    pos.inc    != null ? `${pos.inc.toFixed(2)}°`    : '—');
  setText('sel-period', pos.period != null ? `${pos.period.toFixed(2)} min` : '—');
}

// ── Popup ────────────────────────────────────────────────────

const GROUP_LABELS = {
  'chinese-leo': 'CHINESE LEO',
  'beidou':      'BEIDOU GNSS',
  'tiangong':    'CHINESE SPACE STATION',
};

export function showPopup(sat, pos) {
  document.getElementById('popup-name').textContent       = sat.name;
  document.getElementById('popup-group-badge').textContent = GROUP_LABELS[sat.group] || sat.group.toUpperCase();
  setText('popup-norad',  sat.noradId || '—');
  setText('popup-intl',   sat.intlDes || '—');
  setText('popup-epoch',  sat.epoch   || '—');
  setText('popup-inc',    sat.inc    != null ? `${sat.inc.toFixed(4)}°`  : '—');
  setText('popup-ecc',    sat.ecc    != null ? sat.ecc.toFixed(7)        : '—');
  setText('popup-period', sat.period != null ? `${sat.period.toFixed(2)} min` : '—');
  updatePopupPos(pos);
  document.getElementById('popup').classList.remove('hidden');
}

export function updatePopupPos(pos) {
  if (!pos || pos.valid === false) return;
  setText('popup-alt',   pos.alt   != null ? `${pos.alt.toFixed(0)} km`    : '—');
  setText('popup-speed', pos.speed != null ? `${pos.speed.toFixed(2)} km/s` : '—');
  setText('popup-lat',   pos.lat   != null ? `${pos.lat.toFixed(4)}°`      : '—');
  setText('popup-lon',   pos.lon   != null ? `${pos.lon.toFixed(4)}°`      : '—');
}

export function initPopupClose(cb) {
  document.getElementById('popup-close').addEventListener('click', () => {
    document.getElementById('popup').classList.add('hidden');
    setText('header-selected', '—');
    if (cb) cb();
  });
}

// ── Map credit collapse ───────────────────────────────────────

export function initMapCredit() {
  const btn  = document.getElementById('mc-toggle');
  const body = document.getElementById('mc-body');
  if (!btn || !body) return;
  btn.addEventListener('click', () => {
    const collapsed = body.classList.toggle('collapsed');
    btn.classList.toggle('collapsed', collapsed);
    btn.textContent = collapsed ? '▼' : '▲';
  });
}

// ── Loading ──────────────────────────────────────────────────

export function setLoadingStatus(msg) {
  const el = document.getElementById('loading-status');
  if (el) el.textContent = msg;
}

export function hideLoading() {
  const el = document.getElementById('loading');
  if (!el) return;
  el.classList.add('fade-out');
  setTimeout(() => el.remove(), 700);
}

// ── Helpers ──────────────────────────────────────────────────

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function colorHex(n) {
  return '#' + (n >>> 0).toString(16).padStart(6, '0');
}
