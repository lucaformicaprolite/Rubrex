// ══════════════════════════════════════════════════════════
//  negocio-routes.js — Productos, Clientes del negocio y Ventas
//
//  Antes esto vivía en el localStorage del navegador. Se movió a
//  Postgres para que exista una "fuente de verdad" del lado del
//  servidor — necesario para poder sincronizar con e-commerce
//  (Tienda Nube, WooCommerce, Shopify, etc.) más adelante, porque
//  un webhook le llega al SERVIDOR, no al navegador del dueño.
//
//  Todas las rutas usan req.clienteId (puesto por "autenticar" en
//  auth.js), que es el id del NEGOCIO tanto si loguea el dueño
//  como si loguea un empleado — así los datos quedan compartidos
//  entre todo el equipo, igual que ya pasa con /api/facturar.
// ══════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();

const db = require('./db');
const { autenticar, requireRol } = require('./auth');
const { propagarStock } = require('./ecommerce-sync');

// Convierte lo que devuelve Postgres (NUMERIC llega como string) a
// number, para no romper la matemática que ya hace el front-end.
function normalizarProducto(p) {
  return {
    ...p,
    precio_costo: parseFloat(p.precio_costo) || 0,
    precio_venta: parseFloat(p.precio_venta) || 0,
    precio_mayorista: p.precio_mayorista!=null ? parseFloat(p.precio_mayorista) : null,
    cantidad_mayorista: p.cantidad_mayorista!=null ? parseInt(p.cantidad_mayorista) : null,
    stock: parseInt(p.stock) || 0,
    stock_minimo: p.stock_minimo!=null ? parseInt(p.stock_minimo) : 5
  };
}
function normalizarVenta(v) {
  return {
    id: v.id,
    fecha: v.fecha,
    items: v.items,
    total: parseFloat(v.total) || 0,
    metodoPago: v.metodo_pago,
    cliente: v.cliente_id || v.cliente_nombre
      ? { id: v.cliente_id, nombre: v.cliente_nombre, condicion_iva: v.cliente_condicion_iva }
      : null,
    factura: v.factura || null,
    sinCAE: !!v.sin_cae,
    origen: v.origen,
    externalOrderId: v.external_order_id || null,
    comprador: v.comprador || null,
    montoRecibido: v.monto_recibido!=null ? parseFloat(v.monto_recibido) : null,
    vuelto: v.vuelto!=null ? parseFloat(v.vuelto) : null
  };
}

// ══════════════════ PRODUCTOS ══════════════════

router.get('/api/productos', autenticar, async (req, res) => {
  try {
    const rows = await db.prepare(
      'SELECT * FROM productos WHERE negocio_id = ? ORDER BY nombre ASC'
    ).all(req.clienteId);
    res.json({ ok: true, productos: rows.map(normalizarProducto) });
  } catch (err) {
    console.error('Error en GET /api/productos:', err);
    res.status(500).json({ ok: false, error: 'No se pudieron cargar los productos.' });
  }
});

router.post('/api/productos', autenticar, requireRol('dueno', 'deposito', 'general'), async (req, res) => {
  try {
    const { nombre, codigo, categoria, precio_costo, precio_venta, stock, precio_mayorista, cantidad_mayorista, foto, stock_minimo } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio.' });
    }
    const r = await db.prepare(`
      INSERT INTO productos (negocio_id, nombre, codigo, categoria, precio_costo, precio_venta, stock, precio_mayorista, cantidad_mayorista, foto, stock_minimo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).get(
      req.clienteId, nombre.trim(), codigo || null, categoria || 'General',
      precio_costo || 0, precio_venta || 0, stock || 0,
      precio_mayorista || null, cantidad_mayorista || null, foto || null,
      stock_minimo != null ? stock_minimo : 5
    );
    res.json({ ok: true, producto: normalizarProducto(r) });
  } catch (err) {
    console.error('Error en POST /api/productos:', err);
    res.status(500).json({ ok: false, error: 'No se pudo crear el producto.' });
  }
});

router.put('/api/productos/:id', autenticar, requireRol('dueno', 'deposito', 'general'), async (req, res) => {
  try {
    const { nombre, codigo, categoria, precio_costo, precio_venta, stock, precio_mayorista, cantidad_mayorista, foto, stock_minimo } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio.' });
    }
    const r = await db.prepare(`
      UPDATE productos SET nombre=?, codigo=?, categoria=?, precio_costo=?, precio_venta=?, stock=?, precio_mayorista=?, cantidad_mayorista=?, foto=?, stock_minimo=?
      WHERE id=? AND negocio_id=? RETURNING *
    `).get(
      nombre.trim(), codigo || null, categoria || 'General',
      precio_costo || 0, precio_venta || 0, stock || 0,
      precio_mayorista || null, cantidad_mayorista || null, foto || null,
      stock_minimo != null ? stock_minimo : 5,
      req.params.id, req.clienteId
    );
    if (!r) return res.status(404).json({ ok: false, error: 'Producto no encontrado.' });
    res.json({ ok: true, producto: normalizarProducto(r) });
    propagarStock(req.clienteId, r.id, parseInt(r.stock) || 0).catch(() => {}); // no bloquea la respuesta
  } catch (err) {
    console.error('Error en PUT /api/productos/:id:', err);
    res.status(500).json({ ok: false, error: 'No se pudo actualizar el producto.' });
  }
});

router.delete('/api/productos/:id', autenticar, requireRol('dueno', 'deposito', 'general'), async (req, res) => {
  try {
    const r = await db.prepare('DELETE FROM productos WHERE id=? AND negocio_id=?')
      .run(req.params.id, req.clienteId);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'Producto no encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error en DELETE /api/productos/:id:', err);
    res.status(500).json({ ok: false, error: 'No se pudo eliminar el producto.' });
  }
});

// ══════════════════ CLIENTES DEL NEGOCIO ══════════════════

router.get('/api/clientes-negocio', autenticar, async (req, res) => {
  try {
    const rows = await db.prepare(
      'SELECT * FROM clientes_negocio WHERE negocio_id = ? ORDER BY nombre ASC'
    ).all(req.clienteId);
    res.json({ ok: true, clientes: rows });
  } catch (err) {
    console.error('Error en GET /api/clientes-negocio:', err);
    res.status(500).json({ ok: false, error: 'No se pudieron cargar los clientes.' });
  }
});

router.post('/api/clientes-negocio', autenticar, async (req, res) => {
  try {
    const { nombre, tipo_doc, doc_nro, condicion_iva, telefono, email, domicilio } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio.' });
    }
    const r = await db.prepare(`
      INSERT INTO clientes_negocio (negocio_id, nombre, tipo_doc, doc_nro, condicion_iva, telefono, email, domicilio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).get(
      req.clienteId, nombre.trim(), tipo_doc || 'DNI', doc_nro || '',
      condicion_iva || 'Consumidor Final', telefono || '', email || '', domicilio || ''
    );
    res.json({ ok: true, cliente: r });
  } catch (err) {
    console.error('Error en POST /api/clientes-negocio:', err);
    res.status(500).json({ ok: false, error: 'No se pudo crear el cliente.' });
  }
});

router.put('/api/clientes-negocio/:id', autenticar, async (req, res) => {
  try {
    const { nombre, tipo_doc, doc_nro, condicion_iva, telefono, email, domicilio } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio.' });
    }
    const r = await db.prepare(`
      UPDATE clientes_negocio SET nombre=?, tipo_doc=?, doc_nro=?, condicion_iva=?, telefono=?, email=?, domicilio=?
      WHERE id=? AND negocio_id=? RETURNING *
    `).get(
      nombre.trim(), tipo_doc || 'DNI', doc_nro || '', condicion_iva || 'Consumidor Final',
      telefono || '', email || '', domicilio || '', req.params.id, req.clienteId
    );
    if (!r) return res.status(404).json({ ok: false, error: 'Cliente no encontrado.' });
    res.json({ ok: true, cliente: r });
  } catch (err) {
    console.error('Error en PUT /api/clientes-negocio/:id:', err);
    res.status(500).json({ ok: false, error: 'No se pudo actualizar el cliente.' });
  }
});

router.delete('/api/clientes-negocio/:id', autenticar, requireRol('dueno', 'cajero', 'deposito', 'general'), async (req, res) => {
  try {
    const r = await db.prepare('DELETE FROM clientes_negocio WHERE id=? AND negocio_id=?')
      .run(req.params.id, req.clienteId);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'Cliente no encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error en DELETE /api/clientes-negocio/:id:', err);
    res.status(500).json({ ok: false, error: 'No se pudo eliminar el cliente.' });
  }
});

// ══════════════════ VENTAS ══════════════════

router.get('/api/ventas', autenticar, async (req, res) => {
  try {
    const rows = await db.prepare(
      'SELECT * FROM ventas WHERE negocio_id = ? ORDER BY fecha DESC'
    ).all(req.clienteId);
    res.json({ ok: true, ventas: rows.map(normalizarVenta) });
  } catch (err) {
    console.error('Error en GET /api/ventas:', err);
    res.status(500).json({ ok: false, error: 'No se pudieron cargar las ventas.' });
  }
});

// POST /api/ventas — crea la venta Y descuenta stock, todo en una
// transacción (si algo falla, no queda stock descontado a medias).
router.post('/api/ventas', autenticar, requireRol('dueno', 'cajero', 'general'), async (req, res) => {
  const { items, total, metodoPago, cliente, factura, sinCAE, origen, montoRecibido, vuelto } = req.body;

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ ok: false, error: 'La venta no tiene productos.' });
  }
  if (!total || total <= 0) {
    return res.status(400).json({ ok: false, error: 'Total inválido.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const productosActualizados = [];
    for (const item of items) {
      const r = await client.query(
        `UPDATE productos SET stock = stock - $1
         WHERE id = $2 AND negocio_id = $3
         RETURNING id, stock`,
        [item.qty, item.id, req.clienteId]
      );
      if (r.rows[0]) {
        productosActualizados.push({ id: r.rows[0].id, stock: parseInt(r.rows[0].stock) });
      }
      // Si el producto no existe más (fue borrado), seguimos igual —
      // la venta se registra de todas formas, solo no hay stock que tocar.
    }

    const ventaRes = await client.query(
      `INSERT INTO ventas (negocio_id, items, total, metodo_pago, cliente_id, cliente_nombre, cliente_condicion_iva, factura, sin_cae, origen, monto_recibido, vuelto)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        req.clienteId, JSON.stringify(items), total, metodoPago || 'efectivo',
        cliente?.id || null, cliente?.nombre || null, cliente?.condicion_iva || null,
        factura ? JSON.stringify(factura) : null, !!sinCAE, origen || 'pos',
        montoRecibido!=null ? montoRecibido : null, vuelto!=null ? vuelto : null
      ]
    );

    await client.query('COMMIT');
    res.json({
      ok: true,
      venta: normalizarVenta(ventaRes.rows[0]),
      productosActualizados
    });
    // Se dispara después de responder — si una tienda externa está lenta
    // o caída, no le hacemos esperar al cajero para cerrar la venta.
    productosActualizados.forEach(pu => propagarStock(req.clienteId, pu.id, pu.stock).catch(() => {}));

    // Si se vendió "a cuenta", generamos el cargo en la cuenta corriente
    // del cliente automáticamente (no bloquea la respuesta de la venta).
    if ((metodoPago === 'cuenta_corriente') && cliente && cliente.id) {
      db.prepare(`
        INSERT INTO movimientos_cc (negocio_id, cliente_id, tipo, monto, concepto, venta_id)
        VALUES (?, ?, 'cargo', ?, 'Venta a cuenta', ?)
      `).run(req.clienteId, cliente.id, total, ventaRes.rows[0].id).catch(err => {
        console.error('No se pudo generar el cargo de cuenta corriente:', err);
      });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en POST /api/ventas:', err);
    res.status(500).json({ ok: false, error: 'No se pudo registrar la venta.' });
  } finally {
    client.release();
  }
});

// ══════════════════ PROVEEDORES ══════════════════
// (antes vivían solo en localStorage — ver nota en db.js)

router.get('/api/proveedores', autenticar, requireRol('dueno', 'deposito', 'general'), async (req, res) => {
  try {
    const rows = await db.prepare(
      'SELECT * FROM proveedores WHERE negocio_id = ? ORDER BY nombre ASC'
    ).all(req.clienteId);
    res.json({ ok: true, proveedores: rows });
  } catch (err) {
    console.error('Error en GET /api/proveedores:', err);
    res.status(500).json({ ok: false, error: 'No se pudieron cargar los proveedores.' });
  }
});

router.post('/api/proveedores', autenticar, requireRol('dueno', 'deposito', 'general'), async (req, res) => {
  try {
    const { nombre, contacto, telefono } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio.' });
    }
    const r = await db.prepare(`
      INSERT INTO proveedores (negocio_id, nombre, contacto, telefono)
      VALUES (?, ?, ?, ?) RETURNING *
    `).get(req.clienteId, nombre.trim(), contacto || null, telefono || null);
    res.json({ ok: true, proveedor: r });
  } catch (err) {
    console.error('Error en POST /api/proveedores:', err);
    res.status(500).json({ ok: false, error: 'No se pudo crear el proveedor.' });
  }
});

router.delete('/api/proveedores/:id', autenticar, requireRol('dueno', 'deposito', 'general'), async (req, res) => {
  try {
    const r = await db.prepare('DELETE FROM proveedores WHERE id=? AND negocio_id=?')
      .run(req.params.id, req.clienteId);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'Proveedor no encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error en DELETE /api/proveedores/:id:', err);
    res.status(500).json({ ok: false, error: 'No se pudo eliminar el proveedor.' });
  }
});

// ══════════════════ COMPRAS ══════════════════
// (antes vivían solo en localStorage; el único camino real a estas tablas
// era el Copiloto IA — ver copiloto-routes.js. Ahora la pantalla normal
// de "Compras" también persiste acá.)

router.get('/api/compras', autenticar, requireRol('dueno', 'deposito', 'general'), async (req, res) => {
  try {
    const compras = await db.prepare(
      'SELECT * FROM compras WHERE negocio_id = ? ORDER BY fecha DESC'
    ).all(req.clienteId);
    if (!compras.length) return res.json({ ok: true, compras: [] });

    const ids = compras.map(c => c.id);
    const items = await db.prepare(
      `SELECT * FROM compra_items WHERE compra_id = ANY(?::int[])`
    ).all(ids);

    const itemsPorCompra = {};
    items.forEach(it => {
      (itemsPorCompra[it.compra_id] ||= []).push({
        productoId: it.producto_id,
        nombre: it.nombre,
        cantidad: parseInt(it.cantidad),
        costoUnitario: parseFloat(it.costo_unitario)
      });
    });

    res.json({
      ok: true,
      compras: compras.map(c => ({
        id: c.id,
        fecha: c.fecha,
        proveedorId: c.proveedor_id,
        proveedorNombre: c.proveedor_nombre,
        factura: c.factura,
        total: parseFloat(c.total) || 0,
        items: itemsPorCompra[c.id] || []
      }))
    });
  } catch (err) {
    console.error('Error en GET /api/compras:', err);
    res.status(500).json({ ok: false, error: 'No se pudieron cargar las compras.' });
  }
});

// POST /api/compras — crea la compra Y suma stock, todo en una transacción
// (igual patrón que POST /api/ventas). También actualiza el precio_costo
// del producto al último costo pagado, como ya hacía el frontend antes.
router.post('/api/compras', autenticar, requireRol('dueno', 'deposito', 'general'), async (req, res) => {
  const { proveedorId, factura, fecha, items } = req.body;

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ ok: false, error: 'La compra no tiene productos.' });
  }
  for (const it of items) {
    if (!it.nombre || !it.cantidad || it.cantidad <= 0) {
      return res.status(400).json({ ok: false, error: 'Hay un producto de la compra con datos inválidos.' });
    }
  }

  const total = items.reduce((a, it) => a + (parseFloat(it.costoUnitario) || 0) * parseInt(it.cantidad), 0);

  let proveedorNombre = null;
  if (proveedorId) {
    const prov = await db.prepare('SELECT nombre FROM proveedores WHERE id = ? AND negocio_id = ?').get(proveedorId, req.clienteId);
    proveedorNombre = prov ? prov.nombre : null;
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const compraRes = await client.query(
      `INSERT INTO compras (negocio_id, proveedor_id, proveedor_nombre, factura, total, fecha)
       VALUES ($1,$2,$3,$4,$5, COALESCE($6, CURRENT_TIMESTAMP)) RETURNING *`,
      [req.clienteId, proveedorId || null, proveedorNombre, factura || null, total, fecha || null]
    );
    const compraId = compraRes.rows[0].id;

    const productosActualizados = [];
    for (const it of items) {
      await client.query(
        `INSERT INTO compra_items (compra_id, producto_id, nombre, cantidad, costo_unitario)
         VALUES ($1,$2,$3,$4,$5)`,
        [compraId, it.productoId || null, it.nombre, it.cantidad, it.costoUnitario || 0]
      );
      if (it.productoId) {
        const r = await client.query(
          `UPDATE productos SET stock = stock + $1, precio_costo = $2
           WHERE id = $3 AND negocio_id = $4 RETURNING *`,
          [it.cantidad, it.costoUnitario || 0, it.productoId, req.clienteId]
        );
        if (r.rows[0]) productosActualizados.push(normalizarProducto(r.rows[0]));
      }
    }

    await client.query('COMMIT');
    res.json({
      ok: true,
      compra: {
        id: compraId,
        fecha: compraRes.rows[0].fecha,
        proveedorId: proveedorId || null,
        proveedorNombre,
        factura: factura || null,
        total,
        items
      },
      productosActualizados
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en POST /api/compras:', err);
    res.status(500).json({ ok: false, error: 'No se pudo registrar la compra.' });
  } finally {
    client.release();
  }
});

module.exports = router;
