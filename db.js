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

  // ── Productos / inventario (antes vivía solo en localStorage) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS productos (
      id SERIAL PRIMARY KEY,
      negocio_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      nombre TEXT NOT NULL,
      codigo TEXT,
      categoria TEXT DEFAULT 'General',
      precio_costo NUMERIC(12,2) DEFAULT 0,
      precio_venta NUMERIC(12,2) DEFAULT 0,
      stock INTEGER DEFAULT 0,
      foto TEXT,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_productos_negocio ON productos(negocio_id)`);

  // ── Clientes DEL NEGOCIO (compradores) — distinto de la tabla "clientes",
  //    que son los dueños de cuenta de Rubrex ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes_negocio (
      id SERIAL PRIMARY KEY,
      negocio_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      nombre TEXT NOT NULL,
      tipo_doc TEXT,
      doc_nro TEXT,
      condicion_iva TEXT DEFAULT 'Consumidor Final',
      telefono TEXT,
      email TEXT,
      domicilio TEXT,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clientesneg_negocio ON clientes_negocio(negocio_id)`);

  // ── Ventas. "origen" queda listo para cuando conectemos e-commerce
  //    (pos | tiendanube | woocommerce | shopify | mercadolibre, etc.) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ventas (
      id SERIAL PRIMARY KEY,
      negocio_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      items JSONB NOT NULL,
      total NUMERIC(12,2) NOT NULL,
      metodo_pago TEXT,
      cliente_id INTEGER REFERENCES clientes_negocio(id) ON DELETE SET NULL,
      cliente_nombre TEXT,
      cliente_condicion_iva TEXT,
      factura JSONB,
      sin_cae BOOLEAN DEFAULT FALSE,
      origen TEXT DEFAULT 'pos',
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ventas_negocio ON ventas(negocio_id)`);
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
