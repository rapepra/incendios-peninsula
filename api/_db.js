// api/_db.js — Capa de base de datos para IncendiosES
// ─────────────────────────────────────────────────────────────
// Usa Vercel Postgres (Neon) para guardar barridos históricos de FIRMS
// y detectar focos nuevos entre pasadas del satélite.
//
// Si POSTGRES_URL no está configurado, las funciones devuelven
// valores vacíos/no-op de forma silenciosa (sin romper la API).
// ─────────────────────────────────────────────────────────────

'use strict';

let _sql = null;
let _tableReady = false;

/**
 * Obtiene el cliente SQL de Vercel Postgres.
 * Lanza un error si POSTGRES_URL no está configurada.
 */
async function getSql() {
  if (_sql) return _sql;
  if (!process.env.POSTGRES_URL) {
    throw new Error('POSTGRES_URL no configurada — sin persistencia de barridos');
  }
  // @vercel/postgres es compatible con CommonJS
  const { sql } = require('@vercel/postgres');
  _sql = sql;
  return _sql;
}

/**
 * Asegura que la tabla `barridos` existe.
 * Solo se ejecuta una vez por instancia caliente.
 *
 * Esquema:
 *   id      SERIAL PRIMARY KEY
 *   ts      TIMESTAMPTZ  — cuándo se guardó el barrido
 *   dias    INTEGER      — días de historia que se pidió a FIRMS (1/2/7)
 *   focos   JSONB        — array de focos [{id,lat,lon,sat,conf,ts,...}]
 */
async function ensureTable() {
  if (_tableReady) return;
  const sql = await getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS barridos (
      id    SERIAL PRIMARY KEY,
      ts    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      dias  INTEGER     NOT NULL DEFAULT 1,
      focos JSONB       NOT NULL
    )
  `;
  _tableReady = true;
}

/**
 * Guarda un barrido en la base de datos y limpia los más antiguos.
 * Se conservan los últimos 20 barridos para no acumular datos indefinidamente.
 *
 * @param {Array} focos   - Array de objetos foco parseados de FIRMS
 * @param {number} dias   - Días de historia solicitados (1/2/7)
 */
async function guardarBarrido(focos, dias = 1) {
  await ensureTable();
  const sql = await getSql();

  await sql`
    INSERT INTO barridos (focos, dias)
    VALUES (${JSON.stringify(focos)}::jsonb, ${dias})
  `;

  // Limpieza: conservar solo los últimos 20 barridos por valor de `dias`
  await sql`
    DELETE FROM barridos
    WHERE dias = ${dias}
      AND id NOT IN (
        SELECT id FROM barridos
        WHERE dias = ${dias}
        ORDER BY ts DESC
        LIMIT 20
      )
  `;
}

/**
 * Obtiene el penúltimo barrido registrado para ese número de días.
 * El "penúltimo" (OFFSET 1) permite comparar el barrido actual
 * (que ya se acaba de guardar) contra el anterior.
 *
 * @param {number} dias
 * @returns {Array} Array de focos del barrido anterior, o [] si no hay.
 */
async function obtenerBarridoAnterior(dias = 1) {
  await ensureTable();
  const sql = await getSql();

  const result = await sql`
    SELECT focos
    FROM barridos
    WHERE dias = ${dias}
    ORDER BY ts DESC
    LIMIT 1 OFFSET 1
  `;

  if (result.rows.length === 0) return [];
  return result.rows[0].focos;
}

module.exports = { guardarBarrido, obtenerBarridoAnterior };
