/**
 * /api/noticias — Devuelve noticias recientes sobre incendios forestales
 * en España y Portugal desde Google News RSS (gratuito, sin API key).
 *
 * Cachea en memoria durante 30 minutos para evitar peticiones excesivas.
 */

let cache = { data: null, ts: 0 };
const CACHE_TTL = 30 * 60 * 1000; // 30 min

/**
 * Parsea un feed RSS/XML simple sin dependencias externas.
 * Extrae los campos <title>, <link>, <pubDate> y <source> de cada <item>.
 */
function parsearRSS(xml) {
  const items = [];
  const regex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const bloque = match[1];
    const get = (tag) => {
      const m = bloque.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'))
        || bloque.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };
    // Fuente: <source url="...">Nombre</source>
    const sourceMatch = bloque.match(/<source[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/i);

    items.push({
      titulo: get('title').replace(/<[^>]+>/g, ''), // limpiar posible HTML
      enlace: get('link'),
      fecha: get('pubDate'),
      fuente: sourceMatch ? sourceMatch[2].replace(/<[^>]+>/g, '').trim() : '',
      fuenteUrl: sourceMatch ? sourceMatch[1] : '',
    });
  }
  return items;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Devolver caché si aún es válido
  if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
    return res.status(200).json(cache.data);
  }

  const queries = [
    'incendios+forestales+España',
    'incêndios+florestais+Portugal',
    'incendio+forestal+hoy',
  ];

  try {
    // Pedir varias búsquedas en paralelo y unificar resultados
    const promises = queries.map(q =>
      fetch(`https://news.google.com/rss/search?q=${q}&hl=es&gl=ES&ceid=ES:es`)
        .then(r => r.text())
        .catch(() => '')
    );
    const xmls = await Promise.all(promises);

    // Unificar, deduplicar por enlace, y ordenar por fecha
    const allItems = xmls.flatMap(xml => parsearRSS(xml));
    const seen = new Set();
    const unicos = [];
    for (const item of allItems) {
      const key = item.enlace || item.titulo;
      if (!seen.has(key)) {
        seen.add(key);
        unicos.push(item);
      }
    }
    // Ordenar más reciente primero
    unicos.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    // Limitar a 12 noticias
    const noticias = unicos.slice(0, 12);

    const payload = {
      noticias,
      total: noticias.length,
      ts: new Date().toISOString(),
    };

    cache = { data: payload, ts: Date.now() };
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: 'No se pudieron cargar las noticias',
      detail: err.message,
    });
  }
}
