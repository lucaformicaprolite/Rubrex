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

// Convierte lo que devuelve Postgres (NUMERIC llega como string) a
// number, para no romper la matemática que ya hace el front-end.
function normalizarProducto(p) {
  return {
    ...p,
    precio_costo: parseFloat(p.precio_costo) || 0,
    precio_venta: parseFloat(p.precio_venta) || 0,
    stock: parseInt(p.stock) || 0
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
    origen: v.origen
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

router.post('/api/productos', autenticar, requireRol('dueno', 'deposito'), async (req, res) => {
  try {
    const { nombre, codigo, categoria, precio_costo, precio_venta, stock, foto } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio.' });
    }
    const r = await db.prepare(`
      INSERT INTO productos (negocio_id, nombre, codigo, categoria, precio_costo, precio_venta, stock, foto)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).get(
      req.clienteId, nombre.trim(), codigo || null, categoria || 'General',
      precio_costo || 0, precio_venta || 0, stock || 0, foto || null
    );
    res.json({ ok: true, producto: normalizarProducto(r) });
  } catch (err) {
    console.error('Error en POST /api/productos:', err);
    res.status(500).json({ ok: false, error: 'No se pudo crear el producto.' });
  }
});

router.put('/api/productos/:id', autenticar, requireRol('dueno', 'deposito'), async (req, res) => {
  try {
    const { nombre, codigo, categoria, precio_costo, precio_venta, stock, foto } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio.' });
    }
    const r = await db.prepare(`
      UPDATE productos SET nombre=?, codigo=?, categoria=?, precio_costo=?, precio_venta=?, stock=?, foto=?
      WHERE id=? AND negocio_id=? RETURNING *
    `).get(
      nombre.trim(), codigo || null, categoria || 'General',
      precio_costo || 0, precio_venta || 0, stock || 0, foto || null,
      req.params.id, req.clienteId
    );
    if (!r) return res.status(404).json({ ok: false, error: 'Producto no encontrado.' });
    res.json({ ok: true, producto: normalizarProducto(r) });
  } catch (err) {
    console.error('Error en PUT /api/productos/:id:', err);
    res.status(500).json({ ok: false, error: 'No se pudo actualizar el producto.' });
  }
});

router.delete('/api/productos/:id', autenticar, requireRol('dueno', 'deposito'), async (req, res) => {
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

router.delete('/api/clientes-negocio/:id', autenticar, requireRol('dueno', 'cajero', 'deposito'), async (req, res) => {
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
router.post('/api/ventas', autenticar, requireRol('dueno', 'cajero'), async (req, res) => {
  const { items, total, metodoPago, cliente, factura, sinCAE, origen } = req.body;

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
      `INSERT INTO ventas (negocio_id, items, total, metodo_pago, cliente_id, cliente_nombre, cliente_condicion_iva, factura, sin_cae, origen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        req.clienteId, JSON.stringify(items), total, metodoPago || 'efectivo',
        cliente?.id || null, cliente?.nombre || null, cliente?.condicion_iva || null,
        factura ? JSON.stringify(factura) : null, !!sinCAE, origen || 'pos'
      ]
    );

    await client.query('COMMIT');
    res.json({
      ok: true,
      venta: normalizarVenta(ventaRes.rows[0]),
      productosActualizados
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en POST /api/ventas:', err);
    res.status(500).json({ ok: false, error: 'No se pudo registrar la venta.' });
  } finally {
    client.release();
  }
});

module.exports = router;
