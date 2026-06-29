// ══════════════════════════════════════════════════════════
//  db.js — Base de datos Postgres (antes era SQLite)
//  Guarda un cliente por fila, con sus propias credenciales AFIP
//
//  Necesita DATABASE_URL en las variables de entorno de Render
//  (Render te la da automáticamente si creás un servicio Postgres
//  y lo conectás a este servicio web).
//
//  Este archivo expone una interfaz "compatible" con better-sqlite3
//  (db.prepare(sql).get(...) / .run(...)) para no tener que reescribir
//  todas las queries de server.js. La diferencia es que get/run/all
//  ahora devuelven una Promise, así que en server.js hay que ponerles
//  "await" delante (las rutas ya son async, así que es un cambio chico).
// ══════════════════════════════════════════════════════════
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'Falta DATABASE_URL en las variables de entorno. ' +
    'Creá una base Postgres en Render y conectala a este servicio.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // necesario para conectar a Render Postgres
});

// Crea la tabla si no existe (se ejecuta una sola vez al arrancar el server)
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nombre TEXT,
      afip_cuit TEXT,
      afip_cert TEXT,             -- guardado ENCRIPTADO (ver crypto-utils.js)
      afip_key TEXT,              -- guardado ENCRIPTADO
      afip_punto_venta INTEGER DEFAULT 1,
      afip_production BOOLEAN DEFAULT FALSE,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Convierte "?" (estilo SQLite) a "$1, $2, ..." (estilo Postgres)
function convertirPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function prepare(sql) {
  const sqlConvertido = convertirPlaceholders(sql);

  return {
    // Devuelve UNA fila (o undefined si no hay resultados). Usar con await.
    async get(...params) {
      const r = await pool.query(sqlConvertido, params);
      return r.rows[0];
    },
    // Para INSERT/UPDATE/DELETE. Devuelve algo parecido a lo que
    // devolvía better-sqlite3: { lastInsertRowid, changes }. Usar con await.
    async run(...params) {
      // Si es un INSERT, agregamos RETURNING id para poder simular
      // lastInsertRowid (better-sqlite3 lo devolvía automático).
      let sqlFinal = sqlConvertido;
      const esInsert = /^\s*INSERT/i.test(sqlFinal);
      if (esInsert && !/RETURNING/i.test(sqlFinal)) {
        sqlFinal += ' RETURNING id';
      }
      const r = await pool.query(sqlFinal, params);
      return {
        lastInsertRowid: r.rows[0] ? r.rows[0].id : undefined,
        changes: r.rowCount
      };
    },
    // Para SELECT que devuelven varias filas. Usar con await.
    async all(...params) {
      const r = await pool.query(sqlConvertido, params);
      return r.rows;
    }
  };
}

module.exports = { prepare, init, pool };
