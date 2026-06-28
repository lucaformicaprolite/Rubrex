// ══════════════════════════════════════════════════════════
//  db.js — Base de datos SQLite (un archivo: rubrex.db)
//  Guarda un cliente por fila, con sus propias credenciales AFIP
// ══════════════════════════════════════════════════════════
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'rubrex.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    nombre TEXT,
    afip_cuit TEXT,
    afip_cert TEXT,             -- guardado ENCRIPTADO (ver crypto-utils.js)
    afip_key TEXT,              -- guardado ENCRIPTADO
    afip_punto_venta INTEGER DEFAULT 1,
    afip_production INTEGER DEFAULT 0,
    creado_en TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

module.exports = db;
