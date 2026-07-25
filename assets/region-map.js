/* ============================================================
   region-map.js — Lógica de mapa compartida para páginas de CCA
   ============================================================
   Requiere que window.REGION_CONFIG esté definido ANTES de cargar
   este script. Ejemplo mínimo:

     window.REGION_CONFIG = {
       name:   'Galicia',
       slug:   'galicia',
       center: [42.8, -7.8],
       zoom:   7,
       bbox:   '-9.3,41.8,-6.7,43.8'   // lon_min,lat_min,lon_max,lat_max
     };

   Dependencias (deben cargarse antes):
     - Leaflet 1.9.x (CDN)
     - Leaflet.markercluster 1.5.x (CDN)
============================================================ */

'use strict';

const CFG = window.REGION_CONFIG || {
  name: 'España y Portugal',
  slug: '',
  center: [40.2, -4.5],
  zoom: 6,
  bbox: null
};

/* ─── MAPA BASE ───────────────────────────────────────────── */
const map = L.map('map', { zoomControl: true, attributionControl: true })
  .setView(CFG.center, CFG.zoom);

const capaCarto = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO',
  subdomains: 'abcd',
  maxZoom: 18
}).addTo(map);

/* Capa satélite: Esri World Imagery */
const capaSatelite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '&copy; Esri, Maxar, Earthstar Geographics',
  maxZoom: 18
});

/* Toggle vista satélite */
document.getElementById('cap-satelite')?.addEventListener('change', e => {
  if (e.target.checked) {
    map.removeLayer(capaCarto);
    map.addLayer(capaSatelite);
  } else {
    map.removeLayer(capaSatelite);
    map.addLayer(capaCarto);
  }
});

/* ─── CAPAS NASA GIBS ─────────────────────────────────────── */
const fechaAyer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

const capaViirs = L.tileLayer(
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_Thermal_Anomalies_375m_Day/default/${fechaAyer}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.mvt`,
  { maxZoom: 8, maxNativeZoom: 8, opacity: 0.85, attribution: 'NASA GIBS / VIIRS' }
);

const capaModis = L.tileLayer(
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Combined_Thermal_Anomalies_All/default/${fechaAyer}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.mvt`,
  { maxZoom: 7, maxNativeZoom: 7, opacity: 0.85, attribution: 'NASA GIBS / MODIS' }
);

document.getElementById('cap-viirs')?.addEventListener('change', e =>
  e.target.checked ? map.addLayer(capaViirs) : map.removeLayer(capaViirs));
document.getElementById('cap-modis')?.addEventListener('change', e =>
  e.target.checked ? map.addLayer(capaModis) : map.removeLayer(capaModis));

/* ─── PUNTOS INTERACTIVOS — DATOS REALES CON CLUSTERING ───── */
const clusterGroup = L.markerClusterGroup({
  maxClusterRadius: 40,
  spiderfyOnMaxZoom: true,
  showCoverageOnHover: false,
  zoomToBoundsOnClick: true,
  iconCreateFunction: function(cluster) {
    const count = cluster.getChildCount();
    let size = 'small';
    if (count >= 10) size = 'medium';
    if (count >= 50) size = 'large';
    return L.divIcon({
      html: '<div>' + count + '</div>',
      className: 'marker-cluster marker-cluster-' + size,
      iconSize: L.point(40, 40)
    });
  }
});
map.addLayer(clusterGroup);

const marcadores = {};
let focosActuales = [];
let diasActual = 1;

/** Tiempo relativo legible a partir de un ISO timestamp */
function tiempoRelativo(tsISO) {
  const diff = Date.now() - new Date(tsISO).getTime();
  const min = Math.round(diff / 60000);
  if (isNaN(min) || min < 0) return '—';
  if (min < 1) return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} días`;
}

function crearIcono(esNuevo) {
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:50%;
      background:${esNuevo ? 'var(--alert)' : 'var(--fire)'};
      box-shadow:0 0 0 5px ${esNuevo ? 'rgba(255,210,60,.25)' : 'rgba(255,90,54,.25)'};
    "></div>`,
    iconSize: [14, 14]
  });
}

function pintarFocos(focos, nuevosIds = []) {
  clusterGroup.clearLayers();
  const nuevosSet = new Set(nuevosIds);
  const markers = [];
  focos.forEach(f => {
    const esNuevo = nuevosSet.has(f.id);
    const marker = L.marker([f.lat, f.lon], { icon: crearIcono(esNuevo) });
    marker.on('click', () => mostrarDetalle(f, esNuevo));
    marcadores[f.id] = marker;
    markers.push(marker);
  });
  clusterGroup.addLayers(markers);
}

function actualizarTicker(total, ts) {
  const tkCount = document.getElementById('tk-count');
  const tkUpdate = document.getElementById('tk-update');
  if (tkCount) tkCount.innerHTML = `<b>${total}</b> focos activos`;
  if (tkUpdate) tkUpdate.textContent = `act. ${tiempoRelativo(ts)}`;
}

function mostrarErrorFocos(msg) {
  const el = document.getElementById('error-focos');
  if (el) {
    const span = el.querySelector('span');
    if (span) span.textContent = '⚠ ' + msg;
    el.style.display = 'flex';
  }
  const tkCount = document.getElementById('tk-count');
  if (tkCount) tkCount.innerHTML = '<b>⚠</b> error de datos';
}

async function cargarFocosReales(dias) {
  dias = dias || diasActual;
  diasActual = dias;

  const errEl = document.getElementById('error-focos');
  if (errEl) errEl.style.display = 'none';

  try {
    let url = `/api/focos?dias=${dias}`;
    if (CFG.bbox) url += `&bbox=${encodeURIComponent(CFG.bbox)}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.error) {
      mostrarErrorFocos(data.message || 'Error al obtener datos de incendios');
      return;
    }

    focosActuales = data.focos;
    pintarFocos(data.focos, data.nuevosIds || []);
    actualizarTicker(data.total, data.ts);

    if (!data.cached && data.nuevosIds && data.nuevosIds.length > 0) {
      const n = data.nuevosIds.length;
      mostrarToast(`🔥 ${n} nuevo${n > 1 ? 's focos detectados' : ' foco detectado'} por satélite`);
    }
  } catch (err) {
    mostrarErrorFocos('No se pudo conectar con el servidor de datos.');
  }
}

document.getElementById('cap-demo')?.addEventListener('change', e =>
  e.target.checked ? map.addLayer(clusterGroup) : map.removeLayer(clusterGroup));

document.getElementById('rango')?.addEventListener('change', e => {
  const h = parseInt(e.target.value, 10);
  const dias = h <= 24 ? 1 : h <= 48 ? 2 : 7;
  cargarFocosReales(dias);
});

/* ─── DETALLE DE FOCO + VIENTO REAL ─────────────────────────── */
async function mostrarDetalle(f, esNuevo) {
  const panel = document.getElementById('panel-detalle');
  if (!panel) return;
  panel.classList.add('show');

  document.getElementById('pd-title').innerHTML =
    (f.sat || 'Foco activo') +
    (esNuevo ? '<span class="badge-nuevo">NUEVO</span>' : '');
  document.getElementById('pd-sat').textContent  = f.sat  || '—';
  document.getElementById('pd-conf').textContent = f.conf || '—';
  document.getElementById('pd-time').textContent = tiempoRelativo(f.ts);
  document.getElementById('pd-coords').textContent =
    `${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}`;
  document.getElementById('wind-info').textContent = 'cargando viento…';
  document.getElementById('compass-svg').innerHTML = '';

  map.flyTo([f.lat, f.lon], 8, { duration: 0.6 });

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${f.lat}&longitude=${f.lon}` +
      `&current=wind_speed_10m,wind_direction_10m`;
    const res  = await fetch(url);
    const data = await res.json();
    const vel  = data.current.wind_speed_10m;
    const dir  = data.current.wind_direction_10m;
    dibujarBrujula(dir, vel);
    dibujarConoHumo(f, dir, vel);
    document.getElementById('wind-info').textContent =
      `viento real: ${vel} km/h desde ${Math.round(dir)}°`;
  } catch (err) {
    document.getElementById('wind-info').textContent =
      'no se pudo obtener el viento ahora mismo';
  }
}

function dibujarBrujula(dirDesde, vel) {
  const dirHacia = (dirDesde + 180) % 360;
  document.getElementById('compass-svg').innerHTML = `
  <svg width="90" height="90" viewBox="0 0 90 90">
    <circle cx="45" cy="45" r="38" fill="none" stroke="#262c3a" stroke-width="1.5"/>
    <circle cx="45" cy="45" r="26" fill="none" stroke="#262c3a" stroke-width="1"/>
    <text x="45" y="12" fill="#8892a6" font-size="8" text-anchor="middle" font-family="IBM Plex Mono">N</text>
    <g transform="rotate(${dirHacia} 45 45)">
      <line x1="45" y1="45" x2="45" y2="12" stroke="var(--smoke)" stroke-width="3" stroke-linecap="round"/>
      <polygon points="45,6 40,16 50,16" fill="var(--smoke)"/>
    </g>
    <circle cx="45" cy="45" r="4" fill="var(--fire)"/>
  </svg>`;
}

let capaCono = null;
function dibujarConoHumo(f, dirDesde, vel) {
  if (capaCono) map.removeLayer(capaCono);
  const dirHacia = (dirDesde + 180) % 360;
  const distKm   = Math.min(2 + vel * 0.9, 60);
  const anchoGrados = 22;

  const destino = (brngDeg, distKm) => {
    const R    = 6371;
    const lat1 = f.lat * Math.PI / 180;
    const lon1 = f.lon * Math.PI / 180;
    const brng = brngDeg * Math.PI / 180;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(distKm / R) +
      Math.cos(lat1) * Math.sin(distKm / R) * Math.cos(brng)
    );
    const lon2 = lon1 + Math.atan2(
      Math.sin(brng) * Math.sin(distKm / R) * Math.cos(lat1),
      Math.cos(distKm / R) - Math.sin(lat1) * Math.sin(lat2)
    );
    return [lat2 * 180 / Math.PI, lon2 * 180 / Math.PI];
  };

  const p1 = destino(dirHacia - anchoGrados, distKm);
  const p2 = destino(dirHacia + anchoGrados, distKm);

  capaCono = L.polygon([[f.lat, f.lon], p1, p2], {
    color: 'var(--smoke)', weight: 1,
    fillColor: '#7c93aa', fillOpacity: 0.18, dashArray: '4 4'
  }).addTo(map);
}

/* ─── TOAST ───────────────────────────────────────────────── */
function mostrarToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 6000);
}

/* ─── FABs: Mi ubicación + Toggle capas (mobile) ─────────── */
document.getElementById('fab-location')?.addEventListener('click', () => {
  if (!navigator.geolocation) {
    mostrarToast('Tu navegador no soporta geolocalización');
    return;
  }
  const btn = document.getElementById('fab-location');
  btn.textContent = '⏳';
  navigator.geolocation.getCurrentPosition(
    pos => {
      map.flyTo([pos.coords.latitude, pos.coords.longitude], 10, { duration: 0.8 });
      L.circleMarker([pos.coords.latitude, pos.coords.longitude], {
        radius: 8, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.4, weight: 2
      }).addTo(map).bindPopup('Tu ubicación').openPopup();
      btn.textContent = '📍';
    },
    () => {
      mostrarToast('No se pudo obtener tu ubicación');
      btn.textContent = '📍';
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
});

let filtrosVisible = true;
document.getElementById('fab-layers')?.addEventListener('click', () => {
  const panel = document.getElementById('panel-filtros');
  if (!panel) return;
  filtrosVisible = !filtrosVisible;
  panel.classList.toggle('collapsed', !filtrosVisible);
});

/* ─── BUSCADOR DE LOCALIDAD ───────────────────────────────── */
document.getElementById('geo-search-btn')?.addEventListener('click', buscar);
document.getElementById('geo-search')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') buscar();
});

async function buscar() {
  const q = document.getElementById('geo-search')?.value.trim();
  if (!q) return;
  try {
    const res  = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=es,pt&q=${encodeURIComponent(q)}`
    );
    const data = await res.json();
    if (data[0]) map.flyTo([+data[0].lat, +data[0].lon], 9, { duration: 0.8 });
    else mostrarToast('No se ha encontrado esa localidad');
  } catch (e) {
    mostrarToast('Buscador no disponible ahora mismo');
  }
}

/* ─── COOKIE CONSENT + Google Consent Mode v2 ────────────── */
function gestionarConsentimiento() {
  const consent    = localStorage.getItem('consent_ads');
  const ts         = localStorage.getItem('consent_ts');
  const seisMeses  = 6 * 30 * 24 * 60 * 60 * 1000;

  if (consent !== null && ts && (Date.now() - parseInt(ts, 10) < seisMeses)) {
    if (consent === '1') aceptarConsentimiento();
    return;
  }
  const banner = document.getElementById('cookie-banner');
  if (banner) banner.style.display = 'flex';
}

function aceptarConsentimiento() {
  if (typeof gtag === 'function') {
    gtag('consent', 'update', {
      'ad_storage': 'granted',
      'ad_user_data': 'granted',
      'ad_personalization': 'granted',
      'analytics_storage': 'granted'
    });
  }
  activarAdsense();
}

function rechazarConsentimiento() {
  if (typeof gtag === 'function') {
    gtag('consent', 'update', {
      'ad_storage': 'denied',
      'ad_user_data': 'denied',
      'ad_personalization': 'denied',
      'analytics_storage': 'denied'
    });
  }
}

function activarAdsense() {
  if (!document.querySelector('script[src*="adsbygoogle"]')) {
    const s = document.createElement('script');
    s.async = true;
    s.src   = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6371000120185242';
    s.crossOrigin = 'anonymous';
    document.head.appendChild(s);
  }
  renderRegionAdBlocks();
}

function renderRegionAdBlocks() {
  const slots = document.querySelectorAll('.ad-slot');
  slots.forEach(slot => {
    if (!slot.querySelector('ins')) {
      slot.innerHTML = `<ins class="adsbygoogle"
        style="display:block; text-align:center;"
        data-ad-layout="in-article"
        data-ad-format="fluid"
        data-ad-client="ca-pub-6371000120185242"></ins>`;
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}
    }
  });
}

document.getElementById('cookie-accept')?.addEventListener('click', () => {
  localStorage.setItem('consent_ads', '1');
  localStorage.setItem('consent_ts', String(Date.now()));
  const b = document.getElementById('cookie-banner');
  if (b) b.style.display = 'none';
  aceptarConsentimiento();
});

document.getElementById('cookie-reject')?.addEventListener('click', () => {
  localStorage.setItem('consent_ads', '0');
  localStorage.setItem('consent_ts', String(Date.now()));
  const b = document.getElementById('cookie-banner');
  if (b) b.style.display = 'none';
  rechazarConsentimiento();
});

gestionarConsentimiento();

/* ─── INICIO ─────────────────────────────────────────────── */
cargarFocosReales(1);
// Sondeo automático cada 20 minutos
setInterval(() => cargarFocosReales(diasActual), 20 * 60 * 1000);
