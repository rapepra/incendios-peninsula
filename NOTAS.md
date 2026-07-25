# IncendiosES — Documentación de arquitectura (v2 — producción)

> Actualizado: julio de 2026. Esta es la versión de producción completa.
> El archivo anterior describía el prototipo demo. Ahora documenta la arquitectura real.

---

## Estructura de archivos

```
/
├── index.html                  ← Página principal (mapa general)
├── package.json                ← Deps Node.js (@vercel/postgres)
├── vercel.json                 ← Config Vercel: rutas, headers, function timeout
├── .env.example                ← Variables de entorno requeridas
├── robots.txt
├── sitemap.xml                 ← Actualizado con todas las URLs
├── ads.txt                     ← Plantilla AdSense (rellenar pub-id cuando aprueben)
│
├── api/
│   ├── focos.js                ← Serverless Function: GET /api/focos
│   └── _db.js                  ← Módulo DB: Vercel Postgres (Neon)
│
├── assets/
│   ├── shared.css              ← CSS compartido (páginas CCA + legales)
│   └── region-map.js           ← JS compartido (mapa de región, lee window.REGION_CONFIG)
│
├── incendios/
│   ├── galicia/index.html
│   ├── asturias/index.html
│   ├── castilla-y-leon/index.html
│   ├── andalucia/index.html
│   ├── extremadura/index.html
│   ├── cataluna/index.html
│   ├── comunidad-valenciana/index.html
│   ├── portugal-centro/index.html     ← en pt
│   └── portugal-norte/index.html      ← en pt
│
├── aviso-legal/index.html
├── privacidad/index.html
└── cookies/index.html
```

---

## API — `GET /api/focos`

### Parámetros de query

| Parámetro | Valores | Default | Descripción |
|-----------|---------|---------|-------------|
| `dias`    | 1, 2, 7 | 1 | Días de historia de FIRMS a pedir |
| `bbox`    | `lon1,lat1,lon2,lat2` | null | Filtro espacial (para páginas de CCA) |

### Respuesta (éxito)

```json
{
  "error": false,
  "ts": "2026-07-25T01:00:00.000Z",
  "dias": 1,
  "total": 42,
  "nuevosIds": ["42.1234_-7.5678_2026-07-25_1430"],
  "focos": [
    {
      "id": "42.1234_-7.5678_2026-07-25_1430",
      "lat": 42.1234,
      "lon": -7.5678,
      "sat": "VIIRS NOAA-20",
      "conf": "Alta",
      "bright": 340.2,
      "frp": 15.3,
      "ts": "2026-07-25T14:30:00Z",
      "daynight": "D"
    }
  ],
  "cached": false
}
```

### Respuesta (error)

```json
{
  "error": true,
  "code": "NO_API_KEY | FIRMS_UNAVAILABLE | FIRMS_TIMEOUT | FIRMS_PARSE_ERROR",
  "message": "Descripción legible del error"
}
```

**Principio fundamental**: si algo falla, siempre se devuelve un error claro. Nunca se sirven datos falsos silenciosos.

---

## Variables de entorno requeridas

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `FIRMS_MAP_KEY` | **Sí** | API key de NASA FIRMS. Sin ella, `/api/focos` devuelve 503. Registro gratuito: https://firms.modaps.eosdis.nasa.gov/api/map_key/ |
| `POSTGRES_URL` | No (degradado) | Connection string de Vercel Postgres/Neon. Sin ella, la detección de focos nuevos se desactiva (no falla, simplemente nuevosIds = []). |
| `CACHE_TTL_MINUTES` | No | Caché en memoria de la Function. Default: 15 min. |

---

## Despliegue en Vercel

### Pasos

1. **Importar repositorio** en https://vercel.com/new
2. **Crear la DB**: Vercel Dashboard → Storage → Create → Postgres (Neon) → copiar `POSTGRES_URL`
3. **Añadir variables de entorno** en Settings → Environment Variables:
   - `FIRMS_MAP_KEY` = tu key de FIRMS
   - `POSTGRES_URL` = la URL de Neon (Vercel la sugiere automáticamente si la DB está en el mismo proyecto)
4. **Dominio propio**: Settings → Domains → añadir `incendiosenespana.es` → configurar DNS en tu registrador
5. **Desplegar**: el `push` a `main` dispara el deploy automáticamente

### Desarrollo local

```bash
npm install          # instala @vercel/postgres
npx vercel dev       # lee .env automáticamente y emula Functions + estáticos
```

### Probar el endpoint localmente

```bash
# Sin API key configurada (esperado: 503)
curl http://localhost:3000/api/focos

# Con API key en .env (esperado: JSON con focos)
curl "http://localhost:3000/api/focos?dias=1"

# Filtrado por bbox (Galicia)
curl "http://localhost:3000/api/focos?bbox=-9.3,41.8,-6.7,43.8"
```

---

## Páginas de comunidades autónomas

Cada página en `/incendios/[slug]/index.html` usa el mismo JS (`/assets/region-map.js`) y CSS (`/assets/shared.css`) mediante la configuración de `window.REGION_CONFIG`:

```javascript
window.REGION_CONFIG = {
  name:   'Galicia',      // nombre de la región (para logs/debug)
  slug:   'galicia',      // slug URL
  center: [42.8, -7.8],  // centro del mapa [lat, lon]
  zoom:   7,              // zoom inicial de Leaflet
  bbox:   '-9.3,41.8,-6.7,43.8'  // lon_min,lat_min,lon_max,lat_max
                                   // se pasa como ?bbox= a /api/focos
};
```

El `bbox` filtra los focos al territorio de la CCA, reduciendo la cantidad de marcadores y mejorando el rendimiento.

### Bboxes de referencia

| CCA | bbox (lon_min,lat_min,lon_max,lat_max) | centro | zoom |
|-----|---------------------------------------|--------|------|
| Galicia | -9.3,41.8,-6.7,43.8 | [42.8,-7.8] | 7 |
| Asturias | -7.1,43.0,-4.5,43.8 | [43.35,-5.8] | 8 |
| Castilla y León | -7.0,40.1,-2.1,43.0 | [41.6,-4.5] | 7 |
| Andalucía | -7.5,36.0,-1.6,38.8 | [37.5,-4.7] | 7 |
| Extremadura | -7.5,37.9,-4.7,40.2 | [39.0,-6.2] | 7 |
| Cataluña | 0.1,40.5,3.3,42.9 | [41.7,1.7] | 8 |
| C. Valenciana | -1.5,37.8,0.5,40.8 | [39.3,-0.8] | 8 |
| Portugal Centro | -9.3,38.4,-7.0,40.2 | [39.3,-8.1] | 8 |
| Portugal Norte | -8.7,40.8,-6.2,41.9 | [41.4,-7.5] | 8 |

---

## Detección de "focos nuevos"

La lógica está en `api/focos.js → detectarNuevos()`:

1. Cada vez que `/api/focos` responde con datos frescos (fuera de caché), guarda el barrido en Postgres.
2. Recupera el barrido inmediatamente anterior (`OFFSET 1`).
3. Compara cada foco actual contra el barrido anterior por proximidad geográfica: si ningún punto anterior está a menos de 0.05° (~5 km), el foco se marca como "nuevo".
4. El array `nuevosIds` de la respuesta contiene los IDs de focos nuevos.
5. En el frontend, `pintarFocos()` colorea esos puntos de amarillo (en lugar de rojo) y muestra el badge "NUEVO" en el panel de detalle.

**Nota**: el primer barrido nunca produce `nuevosIds` (no hay anterior con qué comparar). Esto evita spamear alertas en el arranque inicial del servicio.

---

## Páginas legales — qué falta rellenar

Las tres páginas legales (`aviso-legal`, `privacidad`, `cookies`) tienen contenido real conforme al RGPD y la LSSI-CE, pero tienen **placeholders** marcados con `<span class="placeholder">[TITULAR]</span>` que debes sustituir:

- **`[TITULAR]`**: nombre completo o razón social del propietario del sitio
- **`[NIF/CIF]`**: número de identificación fiscal
- **`[dirección postal]`**: domicilio del titular
- **`[email]`** / **`[email de contacto]`**: email de contacto para ejercicio de derechos RGPD

---

## AdSense — pasos pendientes

1. Esperar a tener tráfico real y algo de tiempo online
2. Solicitar cuenta en https://www.google.com/adsense/
3. Una vez aprobada:
   - Sustituir `pub-XXXXXXXXXXXXXXXX` en `ads.txt` con tu Publisher ID real
   - Descomentar el bloque `activarAdsense()` en `index.html` y las páginas CCA (en `/assets/region-map.js`) con el script real
   - Activar los `<ins class="adsbygoogle">` en las posiciones ya marcadas con `<div class="ad-slot">`

---

## SEO — tareas manuales

1. **Google Search Console**: dar de alta el dominio y enviar `https://www.incendiosenespana.es/sitemap.xml`
2. **Bing Webmaster Tools**: mismo proceso (mercado Portugal especialmente)
3. **Velocidad (Core Web Vitals)**: el mayor riesgo es el LCP de las tiles de Leaflet en móvil. Considera:
   - `<link rel="preconnect" href="https://gibs.earthdata.nasa.gov">` en el `<head>`
   - Lazy-load del mapa si no está en el viewport inicial (especialmente en las páginas de CCA con contenido SEO arriba)
4. **Imagen OG**: crear `og-cover.jpg` real (1200×630) y subirla a la raíz del dominio

---

## Flujo de datos completo (diagrama)

```
Satélite NASA (VIIRS/MODIS)
     ↓  (cada pasada, ~2-12h)
NASA FIRMS Area API
     ↓  (cada 15 min si hay peticiones)
/api/focos (Vercel Function)
     ↓  parsea CSV, detecta nuevos, cachea
Vercel Postgres (Neon)     ← guarda barrido histórico
     ↓
JSON { focos, nuevosIds }
     ↓
index.html / incendios/[cca]/
  ├─ L.marker() por cada foco
  ├─ Panel de detalle al hacer click
  ├─ Open-Meteo (viento real, sin key)
  └─ Brújula SVG + cono de humo Leaflet polygon
```
