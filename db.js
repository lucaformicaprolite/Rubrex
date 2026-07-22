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

  // ── Suscripción / pago (MercadoPago) ──
  // "sin_plan" = todavía no eligió/pagó nada. "pendiente" = creó la
  // suscripción en MP pero no terminó de cargar la tarjeta. "trial_activo"
  // = tarjeta cargada, probando gratis. "activo" = ya se le cobró alguna
  // vez. "vencida"/"cancelada" = dejó de pagar o canceló.
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'sin_plan'`);
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS estado_suscripcion TEXT DEFAULT 'sin_plan'`);
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS trial_fin TIMESTAMP`);
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS mp_preapproval_id TEXT`);
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS mp_ultimo_pago TIMESTAMP`);
  // Si falla un cobro mensual, no cortamos al toque: damos un margen y
  // guardamos hasta cuándo dura ese margen acá.
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS gracia_fin TIMESTAMP`);
  // Cuentas que nunca deben pedir pago (la tuya, soporte, pruebas internas).
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS exento_pago BOOLEAN DEFAULT FALSE`);

  // ── Perfil (pantalla "Editar perfil" del frontend) ──
  // nombre_display: cómo quiere que lo saluden dentro de la app (puede ser
  // distinto de "nombre", que es el nombre con el que se registró y que
  // además se usa como nombre del negocio en el topbar/facturas).
  // avatar: foto de perfil en base64 (data URL). Puede ser NULL.
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS nombre_display TEXT`);
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS avatar TEXT`);
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS telefono TEXT`);
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS ubicacion TEXT`);

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
      precio_mayorista NUMERIC(12,2),
      cantidad_mayorista INTEGER,
      stock INTEGER DEFAULT 0,
      foto TEXT,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_productos_negocio ON productos(negocio_id)`);
  // Migración para bases que ya tenían la tabla "productos" creada antes
  // de que existiera el precio mayorista (CREATE TABLE IF NOT EXISTS no
  // agrega columnas a una tabla que ya existe).
  await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS precio_mayorista NUMERIC(12,2)`);
  await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS cantidad_mayorista INTEGER`);

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
  // Para pagos en efectivo: cuánto puso el cliente y cuánto vuelto se le dio.
  // Quedan en null para ventas con otro método de pago (no aplica).
  await pool.query(`ALTER TABLE ventas ADD COLUMN IF NOT EXISTS monto_recibido NUMERIC(12,2)`);
  await pool.query(`ALTER TABLE ventas ADD COLUMN IF NOT EXISTS vuelto NUMERIC(12,2)`);

  // ── E-COMMERCE: integraciones conectadas por cada negocio ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS integraciones_ecommerce (
      id SERIAL PRIMARY KEY,
      negocio_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      plataforma TEXT NOT NULL,              -- 'tiendanube' | 'woocommerce' | ...
      nombre_tienda TEXT,
      store_identifier TEXT,                 -- store_id (TN) o URL de la tienda (Woo)
      credenciales_enc TEXT NOT NULL,        -- JSON encriptado (tokens/API keys)
      webhook_secret TEXT,                   -- para validar que el webhook viene de la plataforma
      activo BOOLEAN DEFAULT TRUE,
      ultima_sync TIMESTAMP,
      estado_sync TEXT DEFAULT 'ok',
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(negocio_id, plataforma)
    )
  `);

  // ── Mapeo: qué producto de Rubrex corresponde a qué producto externo ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS productos_ecommerce_map (
      id SERIAL PRIMARY KEY,
      integracion_id INTEGER NOT NULL REFERENCES integraciones_ecommerce(id) ON DELETE CASCADE,
      producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      external_variant_id TEXT,
      external_nombre TEXT,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(integracion_id, producto_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_map_integracion ON productos_ecommerce_map(integracion_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_map_producto ON productos_ecommerce_map(producto_id)`);

  // ── Log de sincronización (para poder debuggear webhooks fallidos) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ecommerce_sync_log (
      id SERIAL PRIMARY KEY,
      integracion_id INTEGER REFERENCES integraciones_ecommerce(id) ON DELETE CASCADE,
      tipo TEXT,                   -- 'venta_entrante' | 'stock_saliente' | 'error'
      detalle TEXT,
      resultado TEXT,              -- 'ok' | 'error'
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ══════════════ FINANZAS (cuenta corriente, gastos, caja, cheques) ══════════════

  // Movimientos de cuenta corriente de clientes (fiado): cada vez que un
  // cliente compra "a cuenta" se genera un 'cargo', y cada vez que paga
  // algo de esa deuda se genera un 'pago'. El saldo es la suma de todo.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS movimientos_cc (
      id SERIAL PRIMARY KEY,
      negocio_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      cliente_id INTEGER NOT NULL REFERENCES clientes_negocio(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL,                 -- 'cargo' | 'pago'
      monto NUMERIC(12,2) NOT NULL,
      concepto TEXT,
      venta_id INTEGER REFERENCES ventas(id) ON DELETE SET NULL,
      fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_movcc_negocio ON movimientos_cc(negocio_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_movcc_cliente ON movimientos_cc(cliente_id)`);

  // Gastos generales del negocio (alquiler, luz, sueldos, etc — todo lo
  // que NO es comprar mercadería, eso ya se registra en "compras").
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gastos (
      id SERIAL PRIMARY KEY,
      negocio_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      concepto TEXT NOT NULL,
      categoria TEXT DEFAULT 'General',
      monto NUMERIC(12,2) NOT NULL,
      metodo_pago TEXT DEFAULT 'efectivo',
      fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gastos_negocio ON gastos(negocio_id)`);

  // Apertura y cierre de caja (arqueo). Es OPCIONAL: cada negocio decide
  // si lo usa o no (ver columna clientes.usar_caja más abajo).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS caja_turnos (
      id SERIAL PRIMARY KEY,
      negocio_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      abierto_por TEXT,
      monto_inicial NUMERIC(12,2) NOT NULL DEFAULT 0,
      monto_final_declarado NUMERIC(12,2),
      monto_final_sistema NUMERIC(12,2),
      diferencia NUMERIC(12,2),
      estado TEXT DEFAULT 'abierto',      -- 'abierto' | 'cerrado'
      fecha_apertura TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      fecha_cierre TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_caja_negocio ON caja_turnos(negocio_id)`);
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS usar_caja BOOLEAN DEFAULT FALSE`);

  // Cheques recibidos (de clientes) o emitidos (a proveedores).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cheques (
      id SERIAL PRIMARY KEY,
      negocio_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL,                 -- 'recibido' | 'emitido'
      numero TEXT,
      banco TEXT,
      monto NUMERIC(12,2) NOT NULL,
      fecha_emision DATE,
      fecha_vencimiento DATE,
      estado TEXT DEFAULT 'cartera',      -- cartera | depositado | cobrado | rechazado | entregado
      origen TEXT,                        -- nombre del cliente o proveedor
      notas TEXT,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cheques_negocio ON cheques(negocio_id)`);

  // Notas de crédito/débito, para corregir facturas ya emitidas.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notas_cd (
      id SERIAL PRIMARY KEY,
      negocio_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL,                 -- 'credito' | 'debito'
      venta_id INTEGER REFERENCES ventas(id) ON DELETE SET NULL,
      motivo TEXT,
      monto NUMERIC(12,2) NOT NULL,
      fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notascd_negocio ON notas_cd(negocio_id)`);

  // ── COMPRAS (antes vivía solo en localStorage, igual que productos
  //    antes de migrarse). Se agrega ahora para que el Copiloto IA
  //    pueda registrar compras del lado del servidor. ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS compras (
      id SERIAL PRIMARY KEY,
      negocio_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      proveedor_nombre TEXT,
      factura TEXT,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_compras_negocio ON compras(negocio_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS compra_items (
      id SERIAL PRIMARY KEY,
      compra_id INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
      producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
      nombre TEXT NOT NULL,
      cantidad INTEGER NOT NULL,
      costo_unitario NUMERIC(12,2) NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_compraitems_compra ON compra_items(compra_id)`);

  // ── Proveedores (antes vivía solo en localStorage) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proveedores (
      id SERIAL PRIMARY KEY,
      negocio_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      nombre TEXT NOT NULL,
      contacto TEXT,
      telefono TEXT,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_proveedores_negocio ON proveedores(negocio_id)`);
  // compras necesita poder apuntar a un proveedor real, no solo a un nombre suelto.
  await pool.query(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS proveedor_id INTEGER REFERENCES proveedores(id) ON DELETE SET NULL`);

  // ── Recuperación de contraseña ("¿Olvidaste tu contraseña?") ──
  // El código de 6 dígitos lo genera el SERVIDOR (nunca el navegador) y se
  // guarda acá HASHEADO (bcrypt), con expiración de 15 minutos. "tipo" dice
  // si el email pertenece a la tabla clientes (dueño) o equipo (empleado),
  // para saber qué fila actualizar cuando se confirma el código.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      tipo TEXT NOT NULL,             -- 'dueno' | 'equipo'
      intentos INTEGER DEFAULT 0,
      expira TIMESTAMP NOT NULL,
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
