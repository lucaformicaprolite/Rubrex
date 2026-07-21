// ═══════════════════════════════════════════════════════════════
// COPILOTO IA — copiloto-routes.js
// ═══════════════════════════════════════════════════════════════
// Requiere:
//   npm install @anthropic-ai/sdk --save
//
// Cómo montarlo en tu server.js:
//   const copilotoRoutes = require('./copiloto-routes');
//   app.use('/api/copiloto', copilotoRoutes);
//
// Ajustá estos dos imports según cómo se llamen en TU proyecto:
const pool = require('./db');                    // tu conexión a PostgreSQL (pg Pool)
const { requireAuth } = require('./auth-middleware'); // tu middleware JWT — debe dejar
                                                   // req.negocioId y req.usuarioNombre seteados

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-5';

// ─────────────────────────────────────────────────────────────
// 1. ARMAR EL CONTEXTO DEL NEGOCIO
//    Trae datos YA AGREGADOS (no filas crudas) para no gastar tokens
//    de más ni mandarle a la IA datos sensibles innecesarios.
// ─────────────────────────────────────────────────────────────
async function obtenerContextoNegocio(negocioId) {
  const [ventas30d, topProductos, bajaRotacion, caja, cheques, ctaCte] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS cantidad, COALESCE(SUM(total),0)::float AS total
      FROM ventas
      WHERE negocio_id = $1 AND fecha >= NOW() - INTERVAL '30 days'
    `, [negocioId]),

    pool.query(`
      SELECT p.nombre, SUM(vi.cantidad)::int AS vendidos, SUM(vi.cantidad*vi.precio_unitario)::float AS ingresos
      FROM venta_items vi
      JOIN ventas v ON v.id = vi.venta_id
      JOIN productos p ON p.id = vi.producto_id
      WHERE v.negocio_id = $1 AND v.fecha >= NOW() - INTERVAL '30 days'
      GROUP BY p.nombre ORDER BY ingresos DESC LIMIT 5
    `, [negocioId]),

    pool.query(`
      SELECT p.nombre, p.stock, p.categoria
      FROM productos p
      WHERE p.negocio_id = $1
        AND p.stock > 0
        AND NOT EXISTS (
          SELECT 1 FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id
          WHERE vi.producto_id = p.id AND v.fecha >= NOW() - INTERVAL '30 days'
        )
      LIMIT 10
    `, [negocioId]),

    pool.query(`SELECT * FROM caja_turnos WHERE negocio_id=$1 AND fecha_cierre IS NULL LIMIT 1`, [negocioId]),

    pool.query(`
      SELECT COUNT(*)::int AS cantidad, COALESCE(SUM(monto),0)::float AS total
      FROM cheques WHERE negocio_id=$1 AND estado='pendiente' AND fecha_vencimiento <= NOW() + INTERVAL '7 days'
    `, [negocioId]),

    pool.query(`
      SELECT COUNT(*)::int AS clientes_con_deuda, COALESCE(SUM(saldo),0)::float AS total_adeudado
      FROM cuenta_corriente WHERE negocio_id=$1 AND saldo > 0
    `, [negocioId]),
  ]);

  return {
    ventas_30d: ventas30d.rows[0],
    productos_mas_vendidos: topProductos.rows,
    productos_sin_movimiento: bajaRotacion.rows,
    turno_caja_abierto: caja.rows[0] || null,
    cheques_por_vencer_7dias: cheques.rows[0],
    cuenta_corriente: ctaCte.rows[0],
  };
}

function armarSystemPrompt(contexto, nombreNegocio) {
  return `Sos el copiloto de gestión de "${nombreNegocio}", un negocio pyme argentino que usa Rubrex.
Respondé SIEMPRE en español rioplatense, corto, directo y accionable. Nada de rodeos ni disclaimers largos.
No inventes datos que no estén en el contexto. Si falta info para responder algo, decilo.

Datos actuales del negocio (últimos 30 días salvo que se indique otra cosa):
${JSON.stringify(contexto, null, 2)}

Si el usuario te pide algo que implique MODIFICAR datos del negocio (ej: cambiar precios, dar de baja
un producto), usá la herramienta "proponer_accion" en vez de decir que ya lo hiciste. Vos solo proponés,
el sistema le pide confirmación al usuario antes de ejecutar cualquier cambio.`;
}

// ─────────────────────────────────────────────────────────────
// 2. HERRAMIENTAS QUE EL MODELO PUEDE "PROPONER"
//    Ninguna se ejecuta acá — solo arma la propuesta estructurada
//    que el frontend muestra con un botón de confirmar.
// ─────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'proponer_accion',
    description: 'Propone una acción concreta sobre el negocio para que el usuario la confirme. NO la ejecuta.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          enum: [
            'actualizar_precios_categoria',
            'actualizar_precio_producto',
            'dar_baja_producto',
            'registrar_gasto',
            'registrar_compra',
            'crear_producto',
          ],
        },
        descripcion: { type: 'string', description: 'Explicación breve en criollo de qué se va a hacer' },
        parametros: {
          type: 'object',
          description: `Parámetros según el tipo:
- actualizar_precios_categoria: {categoria, porcentaje}
- actualizar_precio_producto: {producto_id, precio_nuevo}
- dar_baja_producto: {producto_id}
- registrar_gasto: {concepto, categoria, monto, metodoPago}
- registrar_compra: {proveedor_nombre, factura, items:[{nombre, cantidad, costo_unitario}], total}
- crear_producto: {nombre, categoria, costo, precio_venta, stock_inicial, codigo_barras?}`,
        },
      },
      required: ['tipo', 'descripcion', 'parametros'],
    },
  },
];

// ─────────────────────────────────────────────────────────────
// 3. POST /api/copiloto  → chat normal (con posibilidad de proponer acción)
// ─────────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const { mensaje, historial = [] } = req.body;
  if (!mensaje || !mensaje.trim()) {
    return res.status(400).json({ ok: false, error: 'Falta el mensaje.' });
  }

  try {
    const negocioId = req.negocioId;
    const contexto = await obtenerContextoNegocio(negocioId);
    const nombreNegocio = req.negocioNombre || 'tu negocio';

    const messages = [
      ...historial.slice(-10).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: mensaje },
    ];

    const respuesta = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: armarSystemPrompt(contexto, nombreNegocio),
      tools: TOOLS,
      messages,
    });

    const bloqueTexto = respuesta.content.find(b => b.type === 'text');
    const bloqueAccion = respuesta.content.find(b => b.type === 'tool_use' && b.name === 'proponer_accion');

    res.json({
      ok: true,
      texto: bloqueTexto ? bloqueTexto.text : '',
      accionPropuesta: bloqueAccion ? bloqueAccion.input : null,
    });
  } catch (err) {
    console.error('Error en /api/copiloto:', err);
    res.status(500).json({ ok: false, error: 'No se pudo consultar al copiloto. Probá de nuevo.' });
  }
});

// ─────────────────────────────────────────────────────────────
// 4. POST /api/copiloto/confirmar  → acá SÍ se ejecuta el cambio
//    El frontend manda de vuelta exactamente lo que vino en
//    "accionPropuesta" cuando el usuario tocó "Confirmar".
// ─────────────────────────────────────────────────────────────
router.post('/confirmar', requireAuth, async (req, res) => {
  const { tipo, parametros } = req.body;
  const negocioId = req.negocioId;

  try {
    if (tipo === 'actualizar_precios_categoria') {
      const { categoria, porcentaje } = parametros;
      if (!categoria || typeof porcentaje !== 'number') {
        return res.status(400).json({ ok: false, error: 'Faltan datos de la acción.' });
      }
      const r = await pool.query(
        `UPDATE productos SET precio_venta = ROUND((precio_venta * (1 + $1/100.0))::numeric, 2)
         WHERE negocio_id = $2 AND categoria = $3
         RETURNING id, nombre, precio_venta`,
        [porcentaje, negocioId, categoria]
      );
      return res.json({ ok: true, mensaje: `Actualizados ${r.rowCount} productos de "${categoria}".`, productos: r.rows });
    }

    if (tipo === 'actualizar_precio_producto') {
      const { producto_id, precio_nuevo } = parametros;
      const r = await pool.query(
        `UPDATE productos SET precio_venta = $1 WHERE id = $2 AND negocio_id = $3 RETURNING id, nombre, precio_venta`,
        [precio_nuevo, producto_id, negocioId]
      );
      if (!r.rowCount) return res.status(404).json({ ok: false, error: 'Producto no encontrado.' });
      return res.json({ ok: true, mensaje: `Precio actualizado.`, producto: r.rows[0] });
    }

    if (tipo === 'dar_baja_producto') {
      const { producto_id } = parametros;
      await pool.query(`UPDATE productos SET activo=false WHERE id=$1 AND negocio_id=$2`, [producto_id, negocioId]);
      return res.json({ ok: true, mensaje: 'Producto dado de baja.' });
    }

    if (tipo === 'registrar_gasto') {
      const { concepto, categoria, monto, metodoPago } = parametros;
      if (!concepto || !monto || monto <= 0) {
        return res.status(400).json({ ok: false, error: 'Faltan datos del gasto.' });
      }
      const r = await pool.query(
        `INSERT INTO gastos (negocio_id, concepto, categoria, monto, metodo_pago, fecha)
         VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id, concepto, monto`,
        [negocioId, concepto, categoria || 'Otros', monto, metodoPago || 'efectivo']
      );
      return res.json({ ok: true, mensaje: `Gasto "${concepto}" registrado por $${monto}.`, gasto: r.rows[0] });
    }

    if (tipo === 'registrar_compra') {
      // ⚠️ Asume tablas "compras" y "compra_items" en Postgres. Si Compras todavía
      // vive en localStorage en tu proyecto, este bloque no va a funcionar tal cual
      // — avisame y lo adaptamos a cómo lo tengas armado realmente.
      const { proveedor_nombre, factura, items = [], total } = parametros;
      if (!items.length) return res.status(400).json({ ok: false, error: 'La compra no tiene productos.' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const compraR = await client.query(
          `INSERT INTO compras (negocio_id, proveedor_nombre, factura, total, fecha)
           VALUES ($1,$2,$3,$4,NOW()) RETURNING id`,
          [negocioId, proveedor_nombre || null, factura || null, total || 0]
        );
        const compraId = compraR.rows[0].id;

        for (const it of items) {
          await client.query(
            `INSERT INTO compra_items (compra_id, nombre, cantidad, costo_unitario) VALUES ($1,$2,$3,$4)`,
            [compraId, it.nombre, it.cantidad, it.costo_unitario]
          );
          // Suma el stock comprado al producto si existe uno con el mismo nombre en el negocio
          await client.query(
            `UPDATE productos SET stock = stock + $1 WHERE negocio_id=$2 AND LOWER(nombre)=LOWER($3)`,
            [it.cantidad, negocioId, it.nombre]
          );
        }
        await client.query('COMMIT');
        return res.json({ ok: true, mensaje: `Compra registrada (${items.length} productos).`, compra_id: compraId });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }

    if (tipo === 'crear_producto') {
      const { nombre, categoria, costo, precio_venta, stock_inicial, codigo_barras } = parametros;
      if (!nombre || precio_venta == null) {
        return res.status(400).json({ ok: false, error: 'Faltan datos del producto.' });
      }
      const r = await pool.query(
        `INSERT INTO productos (negocio_id, nombre, categoria, costo, precio_venta, stock, codigo_barras, activo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING id, nombre, precio_venta, stock`,
        [negocioId, nombre, categoria || 'General', costo || 0, precio_venta, stock_inicial || 0, codigo_barras || null]
      );
      return res.json({ ok: true, mensaje: `Producto "${nombre}" creado.`, producto: r.rows[0] });
    }

    return res.status(400).json({ ok: false, error: 'Tipo de acción desconocido.' });
  } catch (err) {
    console.error('Error en /api/copiloto/confirmar:', err);
    res.status(500).json({ ok: false, error: 'No se pudo aplicar el cambio.' });
  }
});

module.exports = router;
