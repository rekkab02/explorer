import { Capacitor, registerPlugin } from '@capacitor/core';

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

// ── Grid constants ────────────────────────────────────────────────────────────
const CELL = 100;     // metres per side
const ER   = 6378137; // Web Mercator earth radius (metres)

// ── Web Mercator conversion ───────────────────────────────────────────────────
function toMerc(lat, lon) {
  return {
    x: ER * lon * Math.PI / 180,
    y: ER * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))
  };
}

function fromMerc(x, y) {
  return {
    lat: (2 * Math.atan(Math.exp(y / ER)) - Math.PI / 2) * 180 / Math.PI,
    lon: x / ER * 180 / Math.PI
  };
}

// ── Storage (IndexedDB) ───────────────────────────────────────────────────────
const DB_NAME = 'nlverk';
const DB_VER  = 2;
const IDB_STORE = 'cells';
const LS_KEY  = 'nlverk_v2';

let db    = null;
let cells = new Map();

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (d.objectStoreNames.contains(IDB_STORE)) d.deleteObjectStore(IDB_STORE);
      d.createObjectStore(IDB_STORE, { keyPath: 'k' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function migrateFromLS(idb) {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return;
  try {
    const entries = Object.entries(JSON.parse(raw));
    if (!entries.length) return;
    const tx    = idb.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    for (const [k, n] of entries) store.put({ k, n: +n });
    await new Promise((ok, err) => { tx.oncomplete = ok; tx.onerror = err; });
    localStorage.removeItem(LS_KEY);
    console.log(`${entries.length} vakjes gemigreerd van localStorage → IndexedDB`);
  } catch (e) { console.warn('Migratie mislukt:', e); }
}

function loadAllCells(idb) {
  return new Promise((resolve, reject) => {
    const req = idb.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
    req.onsuccess = e => { cells = new Map(e.target.result.map(r => [r.k, r.n])); resolve(); };
    req.onerror   = e => reject(e.target.error);
  });
}

function saveCell(key, count) {
  if (!db) return;
  try { db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put({ k: key, n: count }); }
  catch (e) { console.warn('IDB schrijffout:', e); }
}

// ── Cell fill color (light → dark orange with visits) ────────────────────────
function cellColor(n) {
  const t = Math.min(1, Math.log1p(n) / Math.log1p(30));
  const r = Math.round(255 - 55 * t);
  const g = Math.round(180 - 120 * t);
  return `rgba(${r},${g},8,${(0.38 + 0.52 * t).toFixed(2)})`;
}

// ── Map initialisation ────────────────────────────────────────────────────────
const map = L.map('map', {
  center: [52.20, 5.38], zoom: 13,
  zoomControl: false, attributionControl: false
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
L.control.attribution({
  prefix: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  position: 'bottomleft'
}).addTo(map);

// ── Canvas grid overlay ───────────────────────────────────────────────────────
const GridLayer = L.Layer.extend({
  onAdd(m) {
    this._map = m;
    const cv = this._cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;pointer-events:none;';
    m.getPane('overlayPane').appendChild(cv);
    m.on('moveend zoomend viewreset', this.draw, this);
    this.draw();
  },

  onRemove(m) {
    m.off('moveend zoomend viewreset', this.draw, this);
    this._cv.remove();
  },

  draw() {
    const m = this._map, cv = this._cv;
    const size = m.getSize();
    cv.width  = size.x;
    cv.height = size.y;
    L.DomUtil.setPosition(cv, m.containerPointToLayerPoint([0, 0]));
    const ctx = cv.getContext('2d');

    const bounds = m.getBounds();
    const ctr    = bounds.getCenter();
    const swM    = toMerc(bounds.getSouth(), bounds.getWest());
    const neM    = toMerc(bounds.getNorth(), bounds.getEast());

    const gx0 = Math.floor(swM.x / CELL) - 1, gx1 = Math.ceil(neM.x / CELL) + 1;
    const gy0 = Math.floor(swM.y / CELL) - 1, gy1 = Math.ceil(neM.y / CELL) + 1;

    const refLon0 = gx0 * CELL / ER * 180 / Math.PI;
    const refLon1 = (gx0 + 1) * CELL / ER * 180 / Math.PI;
    const cellPxW = Math.abs(
      m.latLngToContainerPoint([ctr.lat, refLon1]).x -
      m.latLngToContainerPoint([ctr.lat, refLon0]).x
    );

    // ── Step 1: grid lines ───────────────────────────────────────────────────
    const zoomHint = document.getElementById('zoom-hint');
    if (cellPxW >= 2) {
      zoomHint && zoomHint.classList.remove('show');

      const opacity = Math.min(0.45, cellPxW * 0.055);
      const lw      = Math.min(1.2,  cellPxW * 0.12);

      ctx.beginPath();
      ctx.strokeStyle = `rgba(251, 146, 60, ${opacity.toFixed(2)})`;
      ctx.lineWidth   = lw;

      for (let gx = gx0; gx <= gx1 + 1; gx++) {
        const lon = gx * CELL / ER * 180 / Math.PI;
        const px  = m.latLngToContainerPoint([ctr.lat, lon]).x;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, cv.height);
      }

      for (let gy = gy0; gy <= gy1 + 1; gy++) {
        const lat = (2 * Math.atan(Math.exp(gy * CELL / ER)) - Math.PI / 2) * 180 / Math.PI;
        const py  = m.latLngToContainerPoint([lat, ctr.lng]).y;
        ctx.moveTo(0,        py);
        ctx.lineTo(cv.width, py);
      }

      ctx.stroke();
    } else {
      zoomHint && zoomHint.classList.add('show');
    }

    // ── Step 2: visited cells ────────────────────────────────────────────────
    for (const [key, n] of cells) {
      const ci = key.indexOf(',');
      const gx = +key.slice(0, ci), gy = +key.slice(ci + 1);
      if (gx < gx0 || gx > gx1 || gy < gy0 || gy > gy1) continue;

      const sw = fromMerc(gx * CELL,       gy * CELL);
      const ne = fromMerc((gx + 1) * CELL, (gy + 1) * CELL);
      const a  = m.latLngToContainerPoint([sw.lat, sw.lon]);
      const b  = m.latLngToContainerPoint([ne.lat, ne.lon]);

      const px = a.x, py = b.y, pw = b.x - a.x, ph = a.y - b.y;
      if (pw < 0.8 || ph < 0.8) continue;

      ctx.fillStyle = cellColor(n);
      ctx.fillRect(px, py, pw, ph);

      if (pw > 24 && ph > 16) {
        const fs = Math.min(11, Math.floor(pw * 0.38));
        ctx.fillStyle = 'rgba(255,255,255,0.80)';
        ctx.font = `${fs}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(n, px + pw / 2, py + ph / 2);
      }
    }
  }
});

const grid = new GridLayer().addTo(map);

// ── UI helpers ────────────────────────────────────────────────────────────────
const elN    = document.getElementById('stat-n');
const elArea = document.getElementById('stat-area');
const elDot  = document.getElementById('gps-dot');
const elTxt  = document.getElementById('gps-txt');
const btnLoc = document.getElementById('btn-loc');

function fmtArea(n) {
  return `≈ ${(n * CELL * CELL / 1e6).toFixed(3)} km²`;
}

function updateUI() {
  elN.textContent    = cells.size.toLocaleString('nl-NL');
  elArea.textContent = fmtArea(cells.size);
}

// ── Follow / zoom buttons ─────────────────────────────────────────────────────
let followMode = true;
let gpsMarker  = null;

btnLoc.addEventListener('click', () => {
  followMode = !followMode;
  btnLoc.classList.toggle('active', followMode);
  if (followMode && gpsMarker) map.setView(gpsMarker.getLatLng(), Math.max(map.getZoom(), 15), { animate: false });
});

document.getElementById('btn-p').addEventListener('click', () => map.zoomIn());
document.getElementById('btn-m').addEventListener('click', () => map.zoomOut());

document.getElementById('btn-reset').addEventListener('click', () => {
  if (!confirm('Alle bezochte vakjes wissen?')) return;
  cells.clear();
  lx = null; ly = null;
  prevKeys = new Set();
  if (db) db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).clear();
  updateUI();
  grid.draw();
});

map.on('dragstart', () => { followMode = false; btnLoc.classList.remove('active'); });

// ── GPS visit registration ────────────────────────────────────────────────────
let lx = null, ly = null;
let prevKeys = new Set();

function registerVisit(lat, lon) {
  const { x, y } = toMerc(lat, lon);

  const currKeys = new Set();

  if (lx !== null) {
    const dx = x - lx, dy = y - ly;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 400) {
      const steps = Math.max(1, Math.ceil(dist / 5));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        currKeys.add(
          `${Math.floor((lx + dx * t) / CELL)},${Math.floor((ly + dy * t) / CELL)}`
        );
      }
    }
  }

  currKeys.add(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`);

  lx = x; ly = y;

  let changed = false;
  for (const k of currKeys) {
    if (!prevKeys.has(k)) {
      const n = (cells.get(k) || 0) + 1;
      cells.set(k, n);
      saveCell(k, n);
      changed = true;
    }
  }
  prevKeys = currKeys;

  if (changed) { updateUI(); grid.draw(); }
}

// ── Geolocation callbacks ─────────────────────────────────────────────────────
function onPosition(pos) {
  const { latitude: lat, longitude: lon, accuracy: acc } = pos.coords;

  elDot.classList.add('on');
  elTxt.textContent = `±${Math.round(acc)} m nauwkeurig`;

  if (!gpsMarker) {
    gpsMarker = L.circleMarker([lat, lon], {
      radius: 9, color: '#fff', weight: 2.5,
      fillColor: '#60a5fa', fillOpacity: 1
    }).addTo(map);
    if (followMode) map.setView([lat, lon], 15, { animate: false });
  } else {
    gpsMarker.setLatLng([lat, lon]);
    if (followMode) map.panTo([lat, lon], { animate: false });
  }

  if (acc <= 15) registerVisit(lat, lon);
}

function onError(e) {
  elDot.classList.remove('on');
  const msgs = { 1: 'Geen GPS-toestemming', 2: 'GPS niet beschikbaar', 3: 'GPS time-out' };
  elTxt.textContent = msgs[e.code] ?? 'GPS fout';
}

// ── Wake Lock (web only) ──────────────────────────────────────────────────────
async function keepAwake() {
  if (!Capacitor.isNativePlatform() && 'wakeLock' in navigator) {
    try { await navigator.wakeLock.request('screen'); } catch { /* not available */ }
  }
}
keepAwake();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    db = await openDB();
    await migrateFromLS(db);
    await loadAllCells(db);
  } catch (e) {
    console.warn('IndexedDB niet beschikbaar, data wordt niet opgeslagen:', e);
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) cells = new Map(Object.entries(JSON.parse(raw)).map(([k, v]) => [k, +v]));
    } catch { /* ignore */ }
  }

  updateUI();
  grid.draw();

  if (Capacitor.isNativePlatform()) {
    try {
      await BackgroundGeolocation.addWatcher(
        {
          backgroundMessage: 'NL Verkenner volgt je GPS-positie op de achtergrond',
          backgroundTitle: 'GPS Tracker actief',
          requestPermissions: true,
          stale: false,
          distanceFilter: 0
        },
        (location, error) => {
          if (error) {
            onError({ code: error.code === 'NOT_AUTHORIZED' ? 1 : 2 });
            return;
          }
          onPosition({ coords: location });
        }
      );
    } catch (e) {
      elTxt.textContent = 'Achtergrond-GPS niet beschikbaar';
    }
  } else if (navigator.geolocation) {
    navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000
    });
  } else {
    elTxt.textContent = 'Geen geolocatie beschikbaar';
  }
}

boot();
