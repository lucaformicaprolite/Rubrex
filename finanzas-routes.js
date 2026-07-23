// ══════════════════════════════════════════════════════════
//  finanzas-routes.js — Cuenta corriente, Gastos, Caja y Cheques
//
//  Cinco cosas viven acá:
//   1. Cuenta corriente de clientes (fiado): quién debe cuánto.
//   2. Gastos generales del negocio (alquiler, luz, sueldos, etc).
//   3. Apertura/cierre de caja (arqueo) — OPCIONAL, cada negocio
//      decide si lo usa (columna clientes.usar_caja).
//   4. Cheques recibidos o emitidos.
//   5. Notas de crédito/débito, para corregir facturas ya emitidas.
// ══════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();

const db = require('./db');
const { autenticar, requireRol } = require('./auth');

function normalizarMonto(v){ return v!=null ? parseFloat(v) : null; }

// ══════════════════ 1. CUENTA CORRIENTE ══════════════════

// Resumen de todos los clientes con su saldo actual (sumando cargos - pagos).
router.get('/api/cuenta-corriente', autenticar, requireRol('dueno', 'cajero'), async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT cn.id, cn.nombre, cn.telefono,
        COALESCE(SUM(CASE WHEN m.tipo='cargo' THEN m.monto ELSE -m.monto END), 0) AS saldo
      FROM clientes_negocio cn
      LEFT JOIN movimientos_cc m ON m.cliente_id = cn.id AND m.negocio_id = cn.negocio_id
      WHERE cn.negocio_id = ?
      GROUP BY cn.id, cn.nombre, cn.telefono
      HAVING COALESCE(SUM(CASE WHEN m.tipo='cargo' THEN m.monto ELSE -m.monto END), 0) != 0
      ORDER BY saldo DESC
    `).all(req.clienteId);
    res.json({ ok: true, cuentas: rows.map(r => ({ ...r, saldo: parseFloat(r.saldo) })) });
  } catch (err) {
    console.error('Error en GET /api/cuenta-corriente:', err);
    res.status(500).json({ ok: false, error: 'No se pudo cargar la cuenta corriente.' });
  }
});

// Historial de movimientos de UN cliente puntual.
router.get('/api/cuenta-corriente/:clienteId', autenticar, requireRol('dueno', 'cajero'), async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT * FROM movimientos_cc WHERE negocio_id = ? AND cliente_id = ? ORDER BY fecha DESC
    `).all(req.clienteId, req.params.clienteId);
    const saldo = rows.reduce((a, m) => a + (m.tipo === 'cargo' ? parseFloat(m.monto) : -parseFloat(m.monto)), 0);
    res.json({ ok: true, movimientos: rows.map(m => ({ ...m, monto: parseFloat(m.monto) })), saldo });
  } catch (err) {
    console.error('Error en GET /api/cuenta-corriente/:clienteId:', err);
    res.status(500).json({ ok: false, error: 'No se pudo cargar el historial.' });
  }
});

// Registrar un movimiento manual (normalmente un "pago" — el "cargo" se
// genera solo cuando se vende con método de pago "cuenta_corriente",
// ver negocio-routes.js).
router.post('/api/cuenta-corriente', autenticar, requireRol('dueno', 'cajero'), async (req, res) => {
  try {
    const { clienteId, tipo, monto, concepto } = req.body;
    if (!clienteId || !['cargo', 'pago'].includes(tipo) || !monto || monto <= 0) {
      return res.status(400).json({ ok: false, error: 'Datos inválidos.' });
    }
    const r = await db.prepare(`
      INSERT INTO movimientos_cc (negocio_id, cliente_id, tipo, monto, concepto)
      VALUES (?, ?, ?, ?, ?) RETURNING *
    `).get(req.clienteId, clienteId, tipo, monto, concepto || (tipo === 'pago' ? 'Pago recibido' : 'Cargo manual'));
    res.json({ ok: true, movimiento: { ...r, monto: parseFloat(r.monto) } });
  } catch (err) {
    console.error('Error en POST /api/cuenta-corriente:', err);
    res.status(500).json({ ok: false, error: 'No se pudo registrar el movimiento.' });
  }
});

// ══════════════════ 2. GASTOS ══════════════════

router.get('/api/gastos', autenticar, requireRol('dueno'), async (req, res) => {
  try {
    const rows = await db.prepare('SELECT * FROM gastos WHERE negocio_id = ? ORDER BY fecha DESC').all(req.clienteId);
    res.json({ ok: true, gastos: rows.map(g => ({ ...g, monto: parseFloat(g.monto) })) });
  } catch (err) {
    console.error('Error en GET /api/gastos:', err);
    res.status(500).json({ ok: false, error: 'No se pudieron cargar los gastos.' });
  }
});

router.post('/api/gastos', autenticar, requireRol('dueno'), async (req, res) => {
  try {
    const { concepto, categoria, monto, metodoPago, fecha } = req.body;
    if (!concepto || !concepto.trim() || !monto || monto <= 0) {
      return res.status(400).json({ ok: false, error: 'Concepto y monto son obligatorios.' });
    }
    const r = await db.prepare(`
      INSERT INTO gastos (negocio_id, concepto, categoria, monto, metodo_pago, fecha)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP)) RETURNING *
    `).get(req.clienteId, concepto.trim(), categoria || 'General', monto, metodoPago || 'efectivo', fecha || null);
    res.json({ ok: true, gasto: { ...r, monto: parseFloat(r.monto) } });
  } catch (err) {
    console.error('Error en POST /api/gastos:', err);
    res.status(500).json({ ok: false, error: 'No se pudo registrar el gasto.' });
  }
});

router.delete('/api/gastos/:id', autenticar, requireRol('dueno'), async (req, res) => {
  try {
    const r = await db.prepare('DELETE FROM gastos WHERE id=? AND negocio_id=?').run(req.params.id, req.clienteId);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'Gasto no encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error en DELETE /api/gastos/:id:', err);
    res.status(500).json({ ok: false, error: 'No se pudo eliminar el gasto.' });
  }
});

// ══════════════════ 3. CAJA (arqueo — opcional) ══════════════════

// Prende/apaga si este negocio usa el módulo de caja.
router.put('/api/caja/config', autenticar, requireRol('dueno'), async (req, res) => {
  try {
    const { usarCaja } = req.body;
    await db.prepare('UPDATE clientes SET usar_caja = ? WHERE id = ?').run(!!usarCaja, req.clienteId);
    res.json({ ok: true, usarCaja: !!usarCaja });
  } catch (err) {
    console.error('Error en PUT /api/caja/config:', err);
    res.status(500).json({ ok: false, error: 'No se pudo guardar la configuración.' });
  }
});

// Turno abierto actual (si hay). El front lo consulta al entrar al POS.
router.get('/api/caja/estado', autenticar, requireRol('dueno', 'cajero'), async (req, res) => {
  try {
    const cliente = await db.prepare('SELECT usar_caja FROM clientes WHERE id = ?').get(req.clienteId);
    const turno = await db.prepare(`
      SELECT * FROM caja_turnos WHERE negocio_id = ? AND estado = 'abierto' ORDER BY fecha_apertura DESC LIMIT 1
    `).get(req.clienteId);
    res.json({
      ok: true,
      usarCaja: !!(cliente && cliente.usar_caja),
      turno: turno ? { ...turno, monto_inicial: parseFloat(turno.monto_inicial) } : null
    });
  } catch (err) {
    console.error('Error en GET /api/caja/estado:', err);
    res.status(500).json({ ok: false, error: 'No se pudo consultar el estado de caja.' });
  }
});

router.post('/api/caja/abrir', autenticar, requireRol('dueno', 'cajero'), async (req, res) => {
  try {
    const abierto = await db.prepare(`SELECT id FROM caja_turnos WHERE negocio_id=? AND estado='abierto'`).get(req.clienteId);
    if (abierto) return res.status(400).json({ ok: false, error: 'Ya hay un turno de caja abierto.' });

    const { montoInicial } = req.body;
    const r = await db.prepare(`
      INSERT INTO caja_turnos (negocio_id, abierto_por, monto_inicial, estado)
      VALUES (?, ?, ?, 'abierto') RETURNING *
    `).get(req.clienteId, (req.usuario && req.usuario.nombre) || 'Sin nombre', montoInicial || 0);
    res.json({ ok: true, turno: { ...r, monto_inicial: parseFloat(r.monto_inicial) } });
  } catch (err) {
    console.error('Error en POST /api/caja/abrir:', err);
    res.status(500).json({ ok: false, error: 'No se pudo abrir la caja.' });
  }
});

router.post('/api/caja/cerrar', autenticar, requireRol('dueno', 'cajero'), async (req, res) => {
  try {
    const turno = await db.prepare(`SELECT * FROM caja_turnos WHERE negocio_id=? AND estado='abierto'`).get(req.clienteId);
    if (!turno) return res.status(400).json({ ok: false, error: 'No hay ningún turno de caja abierto.' });

    // Sumamos las ventas en efectivo hechas durante este turno para saber
    // cuánto debería haber en caja según el sistema.
    const ventasEfectivo = await db.prepare(`
      SELECT COALESCE(SUM(total), 0) AS total FROM ventas
      WHERE negocio_id = ? AND metodo_pago = 'efectivo' AND fecha >= ?
    `).get(req.clienteId, turno.fecha_apertura);
    const gastosEfectivo = await db.prepare(`
      SELECT COALESCE(SUM(monto), 0) AS total FROM gastos
      WHERE negocio_id = ? AND metodo_pago = 'efectivo' AND fecha >= ?
    `).get(req.clienteId, turno.fecha_apertura);

    const montoInicial = parseFloat(turno.monto_inicial);
    const montoSistema = montoInicial + parseFloat(ventasEfectivo.total) - parseFloat(gastosEfectivo.total);

    const { montoFinalDeclarado } = req.body;
    const declarado = parseFloat(montoFinalDeclarado);
    if (isNaN(declarado)) return res.status(400).json({ ok: false, error: 'Falta el monto contado.' });

    const diferencia = declarado - montoSistema;

    const r = await db.prepare(`
      UPDATE caja_turnos
      SET estado='cerrado', monto_final_declarado=?, monto_final_sistema=?, diferencia=?, fecha_cierre=CURRENT_TIMESTAMP
      WHERE id=? RETURNING *
    `).get(declarado, montoSistema, diferencia, turno.id);

    res.json({ ok: true, turno: {
      ...r,
      monto_inicial: parseFloat(r.monto_inicial),
      monto_final_declarado: parseFloat(r.monto_final_declarado),
      monto_final_sistema: parseFloat(r.monto_final_sistema),
      diferencia: parseFloat(r.diferencia)
    }});
  } catch (err) {
    console.error('Error en POST /api/caja/cerrar:', err);
    res.status(500).json({ ok: false, error: 'No se pudo cerrar la caja.' });
  }
});

router.get('/api/caja/historial', autenticar, requireRol('dueno'), async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT * FROM caja_turnos WHERE negocio_id = ? AND estado='cerrado' ORDER BY fecha_cierre DESC LIMIT 60
    `).all(req.clienteId);
    res.json({ ok: true, turnos: rows.map(t => ({
      ...t,
      monto_inicial: parseFloat(t.monto_inicial),
      monto_final_declarado: normalizarMonto(t.monto_final_declarado),
      monto_final_sistema: normalizarMonto(t.monto_final_sistema),
      diferencia: normalizarMonto(t.diferencia)
    })) });
  } catch (err) {
    console.error('Error en GET /api/caja/historial:', err);
    res.status(500).json({ ok: false, error: 'No se pudo cargar el historial de caja.' });
  }
});

// ══════════════════ 4. CHEQUES ══════════════════

router.get('/api/cheques', autenticar, requireRol('dueno', 'cajero'), async (req, res) => {
  try {
    const rows = await db.prepare('SELECT * FROM cheques WHERE negocio_id = ? ORDER BY fecha_vencimiento ASC').all(req.clienteId);
    res.json({ ok: true, cheques: rows.map(c => ({ ...c, monto: parseFloat(c.monto) })) });
  } catch (err) {
    console.error('Error en GET /api/cheques:', err);
    res.status(500).json({ ok: false, error: 'No se pudieron cargar los cheques.' });
  }
});

router.post('/api/cheques', autenticar, requireRol('dueno', 'cajero'), async (req, res) => {
  try {
    const { tipo, numero, banco, monto, fechaEmision, fechaVencimiento, origen, notas } = req.body;
    if (!['recibido', 'emitido'].includes(tipo) || !monto || monto <= 0) {
      return res.status(400).json({ ok: false, error: 'Datos inválidos.' });
    }
    const r = await db.prepare(`
      INSERT INTO cheques (negocio_id, tipo, numero, banco, monto, fecha_emision, fecha_vencimiento, origen, notas)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).get(req.clienteId, tipo, numero || null, banco || null, monto, fechaEmision || null, fechaVencimiento || null, origen || null, notas || null);
    res.json({ ok: true, cheque: { ...r, monto: parseFloat(r.monto) } });
  } catch (err) {
    console.error('Error en POST /api/cheques:', err);
    res.status(500).json({ ok: false, error: 'No se pudo registrar el cheque.' });
  }
});

router.put('/api/cheques/:id', autenticar, requireRol('dueno', 'cajero'), async (req, res) => {
  try {
    const { estado } = req.body;
    if (!['cartera', 'depositado', 'cobrado', 'rechazado', 'entregado'].includes(estado)) {
      return res.status(400).json({ ok: false, error: 'Estado inválido.' });
    }
    const r = await db.prepare('UPDATE cheques SET estado=? WHERE id=? AND negocio_id=? RETURNING *')
      .get(estado, req.params.id, req.clienteId);
    if (!r) return res.status(404).json({ ok: false, error: 'Cheque no encontrado.' });
    res.json({ ok: true, cheque: { ...r, monto: parseFloat(r.monto) } });
  } catch (err) {
    console.error('Error en PUT /api/cheques/:id:', err);
    res.status(500).json({ ok: false, error: 'No se pudo actualizar el cheque.' });
  }
});

router.delete('/api/cheques/:id', autenticar, requireRol('dueno'), async (req, res) => {
  try {
    const r = await db.prepare('DELETE FROM cheques WHERE id=? AND negocio_id=?').run(req.params.id, req.clienteId);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'Cheque no encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error en DELETE /api/cheques/:id:', err);
    res.status(500).json({ ok: false, error: 'No se pudo eliminar el cheque.' });
  }
});

// ══════════════════ 5. NOTAS DE CRÉDITO/DÉBITO ══════════════════

router.get('/api/notas-cd', autenticar, requireRol('dueno', 'cajero'), async (req, res) => {
  try {
    const rows = await db.prepare('SELECT * FROM notas_cd WHERE negocio_id = ? ORDER BY fecha DESC').all(req.clienteId);
    res.json({ ok: true, notas: rows.map(n => ({ ...n, monto: parseFloat(n.monto) })) });
  } catch (err) {
    console.error('Error en GET /api/notas-cd:', err);
    res.status(500).json({ ok: false, error: 'No se pudieron cargar las notas.' });
  }
});

router.post('/api/notas-cd', autenticar, requireRol('dueno', 'cajero'), async (req, res) => {
  try {
    const { tipo, ventaId, motivo, monto } = req.body;
    if (!['credito', 'debito'].includes(tipo) || !monto || monto <= 0) {
      return res.status(400).json({ ok: false, error: 'Datos inválidos.' });
    }
    const r = await db.prepare(`
      INSERT INTO notas_cd (negocio_id, tipo, venta_id, motivo, monto)
      VALUES (?, ?, ?, ?, ?) RETURNING *
    `).get(req.clienteId, tipo, ventaId || null, motivo || null, monto);
    res.json({ ok: true, nota: { ...r, monto: parseFloat(r.monto) } });
  } catch (err) {
    console.error('Error en POST /api/notas-cd:', err);
    res.status(500).json({ ok: false, error: 'No se pudo registrar la nota.' });
  }
});

module.exports = router;
