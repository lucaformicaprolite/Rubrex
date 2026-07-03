// ══════════════════════════════════════════════════════════
//  ecommerce-sync.js — El "motor" que conecta Rubrex con las
//  integraciones. Dos responsabilidades:
//
//  1) propagarStock()  → Rubrex cambió el stock de un producto
//     (venta, compra, edición manual) → se lo avisamos a TODAS
//     las tiendas online conectadas que tengan ese producto mapeado.
//
//  2) procesarOrdenEntrante() → llegó un webhook de "venta nueva"
//     desde una tienda → creamos la venta en Rubrex y descontamos
//     stock, usando el MISMO endpoint/lógica que ya usa el POS
//     (para no duplicar reglas de negocio en dos lugares).
// ══════════════════════════════════════════════════════════
const db = require('./db');
const { decrypt, encrypt } = require('./crypto-utils');
const { getAdapter } = require('./adapters/factory');

async function log(integracionId, tipo, resultado, detalle) {
  try {
    await db.prepare(
      'INSERT INTO ecommerce_sync_log (integracion_id, tipo, resultado, detalle) VALUES (?, ?, ?, ?)'
    ).run(integracionId, tipo, resultado, typeof detalle === 'string' ? detalle : JSON.stringify(detalle));
  } catch (e) { console.error('No se pudo escribir en ecommerce_sync_log:', e); }
}

function integracionConCredenciales(row) {
  return { ...row, credenciales: JSON.parse(decrypt(row.credenciales_enc)) };
}

// ── 1) Rubrex → tienda(s) online ──
async function propagarStock(negocioId, productoId, nuevoStock) {
  const mapeos = await db.prepare(`
    SELECT m.*, i.* FROM productos_ecommerce_map m
    JOIN integraciones_ecommerce i ON i.id = m.integracion_id
    WHERE m.producto_id = ? AND i.negocio_id = ? AND i.activo = true
  `).all(productoId, negocioId);

  for (const m of mapeos) {
    try {
      const integracion = integracionConCredenciales(m);
      const adapter = getAdapter(integracion);
      await adapter.actualizarStock(m.external_id, nuevoStock, m.external_variant_id);
      await db.prepare('UPDATE integraciones_ecommerce SET ultima_sync = now(), estado_sync = ? WHERE id = ?')
        .run('ok', m.integracion_id);
      await log(m.integracion_id, 'stock_saliente', 'ok', `Producto ${productoId} → stock ${nuevoStock}`);
    } catch (err) {
      await db.prepare('UPDATE integraciones_ecommerce SET estado_sync = ? WHERE id = ?').run('error', m.integracion_id);
      await log(m.integracion_id, 'stock_saliente', 'error', err.message);
      console.error(`Error propagando stock a integración ${m.integracion_id}:`, err.message);
    }
  }
}

// ── 2) Tienda online → Rubrex (webhook de orden nueva) ──
// Reutiliza la MISMA transacción que /api/ventas: descuenta stock y
// crea la venta juntos. Si un producto de la orden no está mapeado
// a ningún producto de Rubrex, esa línea se ignora (no rompe la venta,
// pero queda en el log para que el dueño lo revise y mapee).
async function procesarOrdenEntrante(integracionRow, ordenNormalizada) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const itemsRubrex = [];
    for (const item of ordenNormalizada.items) {
      const mapeo = await client.query(
        `SELECT producto_id FROM productos_ecommerce_map
         WHERE integracion_id = $1 AND external_id = $2
         AND (external_variant_id = $3 OR ($3 IS NULL AND external_variant_id IS NULL))`,
        [integracionRow.id, item.external_id, item.external_variant_id]
      );
      if (!mapeo.rows[0]) {
        await log(integracionRow.id, 'venta_entrante', 'error',
          `Producto externo ${item.external_id} (${item.nombre}) no está mapeado — se ignoró en la orden ${ordenNormalizada.external_order_id}`);
        continue;
      }
      const productoId = mapeo.rows[0].producto_id;
      const r = await client.query(
        `UPDATE productos SET stock = stock - $1 WHERE id = $2 AND negocio_id = $3 RETURNING id`,
        [item.cantidad, productoId, integracionRow.negocio_id]
      );
      if (r.rows[0]) {
        itemsRubrex.push({ id: productoId, nombre: item.nombre, precio: item.precio_unitario, qty: item.cantidad });
      }
    }

    if (!itemsRubrex.length) {
      await client.query('ROLLBACK');
      await log(integracionRow.id, 'venta_entrante', 'error',
        `Orden ${ordenNormalizada.external_order_id} sin productos mapeados — no se registró ninguna venta`);
      return null;
    }

    const ventaRes = await client.query(
      `INSERT INTO ventas (negocio_id, items, total, metodo_pago, cliente_nombre, factura, sin_cae, origen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        integracionRow.negocio_id, JSON.stringify(itemsRubrex), ordenNormalizada.total,
        ordenNormalizada.metodo_pago, ordenNormalizada.cliente?.nombre || null,
        null, true, integracionRow.plataforma
      ]
    );

    await client.query('COMMIT');
    await db.prepare('UPDATE integraciones_ecommerce SET ultima_sync = now() WHERE id = ?').run(integracionRow.id);
    await log(integracionRow.id, 'venta_entrante', 'ok', `Orden ${ordenNormalizada.external_order_id} → venta #${ventaRes.rows[0].id}`);
    return ventaRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    await log(integracionRow.id, 'venta_entrante', 'error', err.message);
    console.error('Error procesando orden entrante:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { propagarStock, procesarOrdenEntrante, integracionConCredenciales, log };
