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
// Válido mientras la Function esté caliente. En instancias frías
// se repite la llamada a FIRMS (lo cual está bien).
const cache = {}; // { '1': { data, time }, '2': {...}, '7': {...} }
const CACHE_TTL = (parseInt(process.env.CACHE_TTL_MINUTES) || 15) * 60 * 1000;

// ─── Parseo del CSV de FIRMS ──────────────────────────────────
/**
 * Convierte el CSV de la FIRMS Area API en un array de objetos foco.
 *
 * Formato esperado (VIIRS_SNPP_NRT):
 *   latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,
 *   satellite,instrument,confidence,version,bright_ti5,frp,daynight
 *
 * @param {string} csv - Contenido crudo del CSV
 * @returns {Array}
 */
function parsearFirmsCSV(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim());

  // Verificar que parece un CSV válido de FIRMS
  if (!headers.includes('latitude') || !headers.includes('longitude')) {
    throw new Error(`CSV de FIRMS inválido. Cabeceras recibidas: ${lines[0].slice(0, 120)}`);
  }

  return lines.slice(1)
    .filter(l => l.trim().length > 0)
    .map(line => {
      const vals = line.split(',');
      const row = {};
      headers.forEach((h, i) => { row[h] = (vals[i] || '').trim(); });

      // ── Normalizar nivel de confianza ──
      // VIIRS NRT: l (baja) / n (nominal) / h (alta)
      // MODIS: valor numérico 0-100
      let conf = row.confidence || '';
      if (conf === 'l') conf = 'Baja';
      else if (conf === 'n') conf = 'Nominal';
      else if (conf === 'h') conf = 'Alta';
      else {
        const n = parseInt(conf, 10);
        conf = isNaN(n) ? conf : n < 30 ? 'Baja' : n > 80 ? 'Alta' : 'Nominal';
      }

      // ── Normalizar nombre del satélite ──
      // Verificado con API real: VIIRS_SNPP_NRT devuelve satellite='N' (NOAA-20).
      // Se mantienen los otros códigos para compatibilidad con MODIS y productos adicionales.
      let sat = row.satellite || '';
      if (sat === 'N')        sat = 'VIIRS NOAA-20';
      else if (sat === 'NPP') sat = 'VIIRS S-NPP';
      else if (sat === 'N21') sat = 'VIIRS NOAA-21';
      else if (sat === 'Terra') sat = 'MODIS Terra';
      else if (sat === 'Aqua')  sat = 'MODIS Aqua';

      // ── Timestamp ISO ──
      const fecha = row.acq_date || '';
      const horaRaw = (row.acq_time || '').padStart(4, '0');
      const ts = `${fecha}T${horaRaw.slice(0, 2)}:${horaRaw.slice(2)}:00Z`;

      const lat = parseFloat(row.latitude);
      const lon = parseFloat(row.longitude);

      if (isNaN(lat) || isNaN(lon)) return null;

      return {
        // ID estable dentro de un barrido: lat+lon+fecha+hora
        id: `${lat.toFixed(4)}_${lon.toFixed(4)}_${fecha}_${horaRaw}`,
        lat,
        lon,
        sat,
        conf,
        bright: parseFloat(row.bright_ti4) || null,
        frp:    parseFloat(row.frp) || null,
        ts,
        daynight: row.daynight || '?'
      };
    })
    .filter(Boolean); // eliminar filas null
}

// ─── Detección de focos nuevos ────────────────────────────────
/**
 * Compara el barrido actual contra el anterior.
 * Un foco es "nuevo" si no hay ningún punto en el barrido previo
 * dentro de 0.05° (~5 km) de distancia.
 *
 * No existe un ID estable entre pasadas del satélite, así que la
 * comparación es por proximidad geográfica.
 *
 * @param {Array} focos    - Barrido actual
 * @param {Array} anterior - Barrido anterior (puede ser [])
 * @returns {string[]} IDs de focos nuevos
 */
function detectarNuevos(focos, anterior) {
  if (!anterior || anterior.length === 0) {
    // Sin barrido anterior: no marcamos nada como nuevo para no spamear
    // alertas en el primer arranque del servicio.
    return [];
  }

  const nuevosIds = [];
  for (const f of focos) {
    const hayVecino = anterior.some(
      prev => Math.abs(prev.lat - f.lat) < 0.05 && Math.abs(prev.lon - f.lon) < 0.05
    );
    if (!hayVecino) nuevosIds.push(f.id);
  }
  return nuevosIds;
}

// ─── Filtro espacial por bbox ─────────────────────────────────
/**
 * @param {Array} focos
 * @param {string|null} bbox - "lon1,lat1,lon2,lat2"
 * @returns {Array}
 */
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
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const MAP_KEY = process.env.FIRMS_MAP_KEY;

  // ── Sin API key → error claro, nunca datos falsos ──
  if (!MAP_KEY || MAP_KEY === 'tu_map_key_aqui') {
    return res.status(503).json({
      error: true,
      code: 'NO_API_KEY',
      message:
        'FIRMS_MAP_KEY no configurada. Añade la variable de entorno en el panel de Vercel ' +
        '(Settings › Environment Variables). Regístrate gratis en ' +
        'https://firms.modaps.eosdis.nasa.gov/api/map_key/'
    });
  }

  // ── Validar parámetro "dias" (1, 2 o 7) ──
  const diasRaw = parseInt(req.query?.dias, 10);
  const dias = [1, 2, 7].includes(diasRaw) ? diasRaw : 1;

  const bbox = req.query?.bbox || null;
  const ahora = Date.now();

  // ── Caché en memoria vigente ──
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

  // ── Llamada a FIRMS Area API ──
  // Bbox España + Portugal: lon_min=-9.5, lat_min=36, lon_max=3.5, lat_max=44
  const firmsUrl =
    `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${MAP_KEY}` +
    `/VIIRS_SNPP_NRT/-9.5,36,3.5,44/${dias}`;

  let csv;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s timeout
    const response = await fetch(firmsUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`FIRMS devolvió HTTP ${response.status}. Respuesta: ${body.slice(0, 200)}`);
    }
    csv = await response.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({
        error: true,
        code: 'FIRMS_TIMEOUT',
        message: 'La API de NASA FIRMS no respondió a tiempo (>20 s). Inténtalo de nuevo.'
      });
    }
    return res.status(502).json({
      error: true,
      code: 'FIRMS_UNAVAILABLE',
      message: `No se pudieron obtener datos de NASA FIRMS: ${err.message}`
    });
  }

  // ── Parseo ──
  let focos;
  try {
    focos = parsearFirmsCSV(csv);
  } catch (parseErr) {
    return res.status(502).json({
      error: true,
      code: 'FIRMS_PARSE_ERROR',
      message: parseErr.message
    });
  }

  // ── Detección de focos nuevos (requiere DB) ──
  let nuevosIds = [];
  try {
    const anterior = await obtenerBarridoAnterior(dias);
    nuevosIds = detectarNuevos(focos, anterior);
    await guardarBarrido(focos, dias);
  } catch (dbErr) {
    // DB no disponible → sin detección de nuevos, pero la API sigue funcionando
    console.warn('[focos] DB no disponible, omitiendo detección de nuevos:', dbErr.message);
    nuevosIds = [];
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

  // Guardar en caché en memoria
  cache[dias] = { data: resultado, time: ahora };

  // ── Responder con filtro bbox si se pidió ──
  const focosFiltrados = filtrarPorBbox(focos, bbox);
  return res.status(200).json({
    ...resultado,
    focos: focosFiltrados,
    total: focosFiltrados.length
  });
};
