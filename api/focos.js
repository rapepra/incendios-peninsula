// api/focos.js — Vercel Serverless Function · GET /api/focos
// ─────────────────────────────────────────────────────────────
// Consume la FIRMS Area API de NASA, parsea el CSV, detecta focos
// nuevos comparando con el barrido anterior (via _db.js) y devuelve
// JSON al frontend de IncendiosES.
//
// Query params aceptados:
//   ?dias=1|2|7   — rango histórico (default: 1)
//   ?bbox=lon1,lat1,lon2,lat2 — filtro espacial (opcional, para páginas de CCA)
//
// La API key de FIRMS NUNCA se expone al frontend: vive solo en
// la variable de entorno FIRMS_MAP_KEY en el panel de Vercel.
// ─────────────────────────────────────────────────────────────

'use strict';

const { guardarBarrido, obtenerBarridoAnterior } = require('./_db');

// ─── Caché en memoria por "dias" ──────────────────────────────
const cache = {}; // { '1': { data, time }, '2': {...}, '7': {...} }
const CACHE_TTL = (parseInt(process.env.CACHE_TTL_MINUTES) || 15) * 60 * 1000;

// ─── Parseo del CSV de FIRMS ──────────────────────────────────
/**
 * Convierte el CSV de la FIRMS Area API en un array de objetos foco.
 *
 * Formato esperado (VIIRS / MODIS):
 *   latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,
 *   satellite,instrument,confidence,version,bright_ti5,frp,daynight
 *
 * @param {string} csv - Contenido crudo del CSV
 * @returns {Array}
 */
function parsearFirmsCSV(csv) {
  if (!csv || typeof csv !== 'string') return [];
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim());

  if (!headers.includes('latitude') || !headers.includes('longitude')) {
    return [];
  }

  return lines.slice(1)
    .filter(l => l.trim().length > 0)
    .map(line => {
      const vals = line.split(',');
      const row = {};
      headers.forEach((h, i) => { row[h] = (vals[i] || '').trim(); });

      // ── Normalizar nivel de confianza ──
      let conf = row.confidence || '';
      if (conf === 'l') conf = 'Baja';
      else if (conf === 'n') conf = 'Nominal';
      else if (conf === 'h') conf = 'Alta';
      else {
        const n = parseInt(conf, 10);
        conf = isNaN(n) ? conf : n < 30 ? 'Baja' : n > 80 ? 'Alta' : 'Nominal';
      }

      // ── Normalizar nombre del satélite ──
      let sat = row.satellite || '';
      if (sat === 'N' || sat === '1' || sat === 'J1') sat = 'VIIRS NOAA-20';
      else if (sat === 'NPP') sat = 'VIIRS S-NPP';
      else if (sat === 'N21' || sat === '2' || sat === 'J2') sat = 'VIIRS NOAA-21';
      else if (sat === 'T' || sat === 'Terra') sat = 'MODIS Terra';
      else if (sat === 'A' || sat === 'Aqua')  sat = 'MODIS Aqua';
      else sat = sat ? `Satélite ${sat}` : 'VIIRS';

      // ── Timestamp ISO ──
      const fecha = row.acq_date || '';
      const horaRaw = (row.acq_time || '').padStart(4, '0');
      const ts = `${fecha}T${horaRaw.slice(0, 2)}:${horaRaw.slice(2)}:00Z`;

      const lat = parseFloat(row.latitude);
      const lon = parseFloat(row.longitude);

      if (isNaN(lat) || isNaN(lon)) return null;

      return {
        id: `${lat.toFixed(4)}_${lon.toFixed(4)}_${fecha}_${horaRaw}`,
        lat,
        lon,
        sat,
        conf,
        bright: parseFloat(row.bright_ti4) || parseFloat(row.brightness) || null,
        frp:    parseFloat(row.frp) || null,
        ts,
        daynight: row.daynight || '?'
      };
    })
    .filter(Boolean);
}

// ─── Deduplicar focos de múltiples satélites ──────────────────
function deduplicarFocos(focos) {
  const map = new Map();
  for (const f of focos) {
    // Si dos sensores leen el mismo punto dentro de 0.01° (~1km) y misma hora/fecha
    const key = `${f.lat.toFixed(2)}_${f.lon.toFixed(2)}_${f.ts.slice(0, 13)}`;
    if (!map.has(key)) {
      map.set(key, f);
    }
  }
  return Array.from(map.values());
}

// ─── Detección de focos nuevos ────────────────────────────────
function detectarNuevos(focos, anterior) {
  if (!anterior || anterior.length === 0) return [];
  const nuevosIds = [];
  for (const f of focos) {
    const hayVecino = anterior.some(
      prev => Math.abs(prev.lat - f.lat) < 0.03 && Math.abs(prev.lon - f.lon) < 0.03
    );
    if (!hayVecino) nuevosIds.push(f.id);
  }
  return nuevosIds;
}

// ─── Filtro espacial por bbox ─────────────────────────────────
function filtrarPorBbox(focos, bbox) {
  if (!bbox) return focos;
  const parts = bbox.split(',').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return focos;
  const [lon1, lat1, lon2, lat2] = parts;
  return focos.filter(
    f => f.lat >= lat1 && f.lat <= lat2 && f.lon >= lon1 && f.lon <= lon2
  );
}

// ─── Handler principal ─────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const MAP_KEY = process.env.FIRMS_MAP_KEY;

  if (!MAP_KEY || MAP_KEY === 'tu_map_key_aqui') {
    return res.status(503).json({
      error: true,
      code: 'NO_API_KEY',
      message:
        'FIRMS_MAP_KEY no configurada. Añade la variable de entorno en el panel de Vercel.'
    });
  }

  const diasRaw = parseInt(req.query?.dias, 10);
  const dias = [1, 2, 7].includes(diasRaw) ? diasRaw : 1;
  const bbox = req.query?.bbox || null;
  const ahora = Date.now();

  // Caché en memoria
  const entrada = cache[dias];
  if (entrada && (ahora - entrada.time) < CACHE_TTL) {
    const focosFiltrados = filtrarPorBbox(entrada.data.focos, bbox);
    return res.status(200).json({
      ...entrada.data,
      focos: focosFiltrados,
      total: focosFiltrados.length,
      cached: true
    });
  }

  // ── Coordenadas totales: Península + Baleares + Canarias + Portugal
  const areaBbox = '-18.5,27.5,4.5,44.0';

  // Consultar VIIRS S-NPP y NOAA-20 simultáneamente para duplicar la frecuencia de detección
  const productos = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT'];
  const promises = productos.map(prod => {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${MAP_KEY}/${prod}/${areaBbox}/${dias}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    return fetch(url, { signal: controller.signal })
      .then(r => r.ok ? r.text() : '')
      .catch(() => '')
      .finally(() => clearTimeout(timeoutId));
  });

  const csvResults = await Promise.all(promises);
  let todosLosFocos = csvResults.flatMap(csv => parsearFirmsCSV(csv));

  // Fallback si dias===1 y no hay focos (madrugada UTC) -> ampliar a 2 días
  if (dias === 1 && todosLosFocos.length === 0) {
    const fbPromises = productos.map(prod => {
      const fbUrl = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${MAP_KEY}/${prod}/${areaBbox}/2`;
      return fetch(fbUrl).then(r => r.ok ? r.text() : '').catch(() => '');
    });
    const fbCsvs = await Promise.all(fbPromises);
    todosLosFocos = fbCsvs.flatMap(csv => parsearFirmsCSV(csv));
  }

  const focos = deduplicarFocos(todosLosFocos);

  // Detección de focos nuevos
  let nuevosIds = [];
  try {
    const anterior = await obtenerBarridoAnterior(dias);
    nuevosIds = detectarNuevos(focos, anterior);
    await guardarBarrido(focos, dias);
  } catch (dbErr) {
    console.warn('[focos] DB no disponible, omitiendo detección de nuevos:', dbErr.message);
  }

  const resultado = {
    error: false,
    ts: new Date().toISOString(),
    dias,
    total: focos.length,
    nuevosIds,
    focos,
    cached: false
  };

  cache[dias] = { data: resultado, time: ahora };

  const focosFiltrados = filtrarPorBbox(focos, bbox);
  return res.status(200).json({
    ...resultado,
    focos: focosFiltrados,
    total: focosFiltrados.length
  });
};
