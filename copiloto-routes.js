// ══════════════════════════════════════════════════════════
//  copiloto-routes.js — Copiloto IA del negocio (chat + acciones)
//
//  Requiere:
//    npm install @google/genai --save
//    GEMINI_API_KEY como variable de entorno en Render (se saca gratis
//    en Google AI Studio: https://aistudio.google.com → Get API key)
//
//  Se monta en server.js IGUAL que los demás routers, sin prefijo
//  (las rutas de acá abajo ya incluyen /api/... completo):
//    app.use(require('./copiloto-routes'));
// ══════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { GoogleGenAI } = require('@google/genai');

const db = require('./db');
const { autenticar, requireRol } = require('./auth');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = 'gemini-3.5-flash';

// ─────────────────────────────────────────────────────────────
// Reintentos con backoff para errores TRANSITORIOS de Gemini
// (503 "high demand" / UNAVAILABLE, y cortes de red tipo
// HeadersTimeoutError). Errores de otro tipo (400, 401, 403...)
// se relanzan de inmediato, no tiene sentido reintentarlos.
// ─────────────────────────────────────────────────────────────
function esErrorTransitorio(err) {
  const status = err?.status || err?.error?.code;
  const msg = String(err?.message || '');
  return (
    status === 503 ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('high demand') ||
    msg.includes('fetch failed') ||
    msg.includes('HeadersTimeoutError') ||
    err?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT'
  );
}

async function generarConReintentos(params, { intentos = 3, esperaBaseMs = 1000 } = {}) {
  let ultimoError;
  for (let i = 0; i < intentos; i++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      ultimoError = err;
      if (!esErrorTransitorio(err) || i === intentos - 1) throw err;
      const espera = esperaBaseMs * Math.pow(2, i); // 1s, 2s, 4s...
      console.warn(`Gemini transitorio (intento ${i + 1}/${intentos}), reintentando en ${espera}ms:`, err.message);
      await new Promise(r => setTimeout(r, espera));
    }
  }
  throw ultimoError;
}

// ─────────────────────────────────────────────────────────────
// 1. ARMAR EL CONTEXTO DEL NEGOCIO (datos ya agregados, no filas crudas)
// ─────────────────────────────────────────────────────────────
async function obtenerContextoNegocio(negocioId) {
  const [ventas30d, topProductos, bajaRotacion, cliente, turnoAbierto, cheques, ctaCte] = await Promise.all([
    db.prepare(`
      SELECT COUNT(*)::int AS cantidad, COALESCE(SUM(total),0)::float AS total
      FROM ventas WHERE negocio_id = ? AND fecha >= NOW() - INTERVAL '30 days'
    `).get(negocioId),

    // Los items de cada venta viven como JSONB ({nombre,precio,qty}), no en
    // una tabla aparte — por eso el jsonb_array_elements acá abajo.
    db.prepare(`
      SELECT item->>'nombre' AS nombre,
             SUM((item->>'qty')::numeric)::float AS vendidos,
             SUM((item->>'qty')::numeric * (item->>'precio')::numeric)::float AS ingresos
      FROM ventas v, jsonb_array_elements(v.items) AS item
      WHERE v.negocio_id = ? AND v.fecha >= NOW() - INTERVAL '30 days'
      GROUP BY item->>'nombre' ORDER BY ingresos DESC LIMIT 5
    `).all(negocioId),

    db.prepare(`
      SELECT p.nombre, p.stock, p.categoria
      FROM productos p
      WHERE p.negocio_id = ? AND p.stock > 0
        AND NOT EXISTS (
          SELECT 1 FROM ventas v, jsonb_array_elements(v.items) AS item
          WHERE v.negocio_id = p.negocio_id AND v.fecha >= NOW() - INTERVAL '30 days'
            AND item->>'nombre' = p.nombre
        )
      LIMIT 10
    `).all(negocioId),

    db.prepare('SELECT usar_caja FROM clientes WHERE id = ?').get(negocioId),

    db.prepare(`
      SELECT id FROM caja_turnos WHERE negocio_id = ? AND estado = 'abierto' ORDER BY fecha_apertura DESC LIMIT 1
    `).get(negocioId),

    db.prepare(`
      SELECT COUNT(*)::int AS cantidad, COALESCE(SUM(monto),0)::float AS total
      FROM cheques WHERE negocio_id=? AND estado IN ('cartera') AND fecha_vencimiento <= NOW() + INTERVAL '7 days'
    `).get(negocioId),

    db.prepare(`
      SELECT cn.id, cn.nombre, COALESCE(SUM(CASE WHEN m.tipo='cargo' THEN m.monto ELSE -m.monto END),0)::float AS saldo
      FROM clientes_negocio cn
      LEFT JOIN movimientos_cc m ON m.cliente_id = cn.id AND m.negocio_id = cn.negocio_id
      WHERE cn.negocio_id = ?
      GROUP BY cn.id, cn.nombre
      HAVING COALESCE(SUM(CASE WHEN m.tipo='cargo' THEN m.monto ELSE -m.monto END),0) > 0
      ORDER BY saldo DESC LIMIT 5
    `).all(negocioId),
  ]);

  return {
    ventas_30d: ventas30d,
    productos_mas_vendidos: topProductos,
    productos_sin_movimiento_30d: bajaRotacion,
    usa_control_de_caja: !!(cliente && cliente.usar_caja),
    turno_de_caja_abierto: !!turnoAbierto,
    cheques_por_vencer_7dias: cheques,
    clientes_con_deuda_top5: ctaCte,
  };
}

function armarSystemPrompt(contexto, nombreNegocio) {
  return `Sos el copiloto de gestión de "${nombreNegocio}", un negocio pyme argentino que usa Rubrex.
Respondé SIEMPRE en español rioplatense, corto, directo y accionable. Nada de rodeos ni disclaimers largos.
No inventes datos que no estén en el contexto. Si falta info para responder algo, decilo.

Datos actuales del negocio (últimos 30 días salvo que se indique otra cosa):
${JSON.stringify(contexto, null, 2)}

Si el usuario te pide algo que implique MODIFICAR datos del negocio (cambiar precios, dar de baja un
producto, registrar un gasto, una compra o cargar un producto nuevo), usá la herramienta "proponer_accion"
en vez de decir que ya lo hiciste. Vos solo proponés, el sistema le pide confirmación al usuario antes
de ejecutar cualquier cambio. Si el usuario no te dio todos los datos necesarios para la acción (ej:
"registrame un gasto" sin decir el monto), preguntáselos antes de proponer la acción.`;
}

// ─────────────────────────────────────────────────────────────
// 2. HERRAMIENTA QUE EL MODELO PUEDE "PROPONER" (nunca se autoejecuta)
//    Gemini usa "functionDeclarations" en vez del "tools" de Anthropic,
//    pero el schema de parámetros (JSON Schema) es prácticamente igual.
// ─────────────────────────────────────────────────────────────
const TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'proponer_accion',
        description: 'Propone una acción concreta sobre el negocio para que el usuario la confirme. NO la ejecuta.',
        parameters: {
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
              description: `Parámetros exactos según el tipo:
- actualizar_precios_categoria: {categoria, porcentaje}  (porcentaje positivo sube, negativo baja)
- actualizar_precio_producto: {producto_id, precio_nuevo}
- dar_baja_producto: {producto_id}  (esto ELIMINA el producto, no es reversible)
- registrar_gasto: {concepto, categoria, monto, metodoPago}
- registrar_compra: {proveedor_nombre, factura, items:[{nombre, cantidad, costo_unitario}], total}
- crear_producto: {nombre, categoria, precio_costo, precio_venta, stock, codigo?}`,
            },
          },
          required: ['tipo', 'descripcion', 'parametros'],
        },
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────
// 3. POST /api/copiloto — chat normal
// ─────────────────────────────────────────────────────────────
router.post('/api/copiloto', autenticar, async (req, res) => {
  const { mensaje, historial = [] } = req.body;
  if (!mensaje || !mensaje.trim()) {
    return res.status(400).json({ ok: false, error: 'Falta el mensaje.' });
  }

  try {
    const negocioId = req.clienteId;
    const contexto = await obtenerContextoNegocio(negocioId);
    const clienteRow = await db.prepare('SELECT nombre FROM clientes WHERE id = ?').get(negocioId);
    const nombreNegocio = (clienteRow && clienteRow.nombre) || 'tu negocio';

    // Gemini usa roles 'user' / 'model' (Anthropic usaba 'user' / 'assistant').
    const contents = [
      ...historial.slice(-10).map(h => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }],
      })),
      { role: 'user', parts: [{ text: mensaje }] },
    ];

    const respuesta = await generarConReintentos({
      model: MODEL,
      contents,
      config: {
        systemInstruction: armarSystemPrompt(contexto, nombreNegocio),
        tools: TOOLS,
      },
    });

    const parts = respuesta.candidates?.[0]?.content?.parts || [];
    const partTexto = parts.find(p => p.text);
    const partAccion = parts.find(p => p.functionCall && p.functionCall.name === 'proponer_accion');

    res.json({
      ok: true,
      texto: partTexto ? partTexto.text : '',
      accionPropuesta: partAccion ? partAccion.functionCall.args : null,
    });
  } catch (err) {
    console.error('Error en /api/copiloto:', err);
    const mensaje = esErrorTransitorio(err)
      ? 'El copiloto está con mucha demanda ahora mismo. Probá de nuevo en unos segundos.'
      : 'No se pudo consultar al copiloto. Probá de nuevo.';
    res.status(503).json({ ok: false, error: mensaje });
  }
});

// ─────────────────────────────────────────────────────────────
// 4. POST /api/copiloto/confirmar — acá SÍ se ejecuta el cambio.
//    Solo dueño/cajero/depósito según corresponda a cada acción,
//    igual que exigen las rutas equivalentes en negocio-routes.js
//    y finanzas-routes.js.
// ─────────────────────────────────────────────────────────────
router.post('/api/copiloto/confirmar', autenticar, async (req, res) => {
  const { tipo, parametros } = req.body;
  const negocioId = req.clienteId;
  const rol = req.usuario.rol;

  try {
    if (tipo === 'actualizar_precios_categoria') {
      if (!['dueno'].includes(rol)) return res.status(403).json({ ok: false, error: 'Tu rol no puede cambiar precios.' });
      const { categoria, porcentaje } = parametros;
      if (!categoria || typeof porcentaje !== 'number') {
        return res.status(400).json({ ok: false, error: 'Faltan datos de la acción.' });
      }
      const r = await db.prepare(`
        UPDATE productos SET precio_venta = ROUND((precio_venta * (1 + ?/100.0))::numeric, 2)
        WHERE negocio_id = ? AND categoria = ?
      `).run(porcentaje, negocioId, categoria);
      return res.json({ ok: true, mensaje: `Actualizados ${r.changes} productos de "${categoria}".` });
    }

    if (tipo === 'actualizar_precio_producto') {
      if (!['dueno'].includes(rol)) return res.status(403).json({ ok: false, error: 'Tu rol no puede cambiar precios.' });
      const { producto_id, precio_nuevo } = parametros;
      const r = await db.prepare(`
        UPDATE productos SET precio_venta = ? WHERE id = ? AND negocio_id = ? RETURNING nombre, precio_venta
      `).get(precio_nuevo, producto_id, negocioId);
      if (!r) return res.status(404).json({ ok: false, error: 'Producto no encontrado.' });
      return res.json({ ok: true, mensaje: `"${r.nombre}" ahora cuesta $${r.precio_venta}.` });
    }

    if (tipo === 'dar_baja_producto') {
      if (!['dueno', 'deposito'].includes(rol)) return res.status(403).json({ ok: false, error: 'Tu rol no puede eliminar productos.' });
      const { producto_id } = parametros;
      const r = await db.prepare('DELETE FROM productos WHERE id=? AND negocio_id=?').run(producto_id, negocioId);
      if (!r.changes) return res.status(404).json({ ok: false, error: 'Producto no encontrado.' });
      return res.json({ ok: true, mensaje: 'Producto eliminado.' });
    }

    if (tipo === 'registrar_gasto') {
      if (!['dueno'].includes(rol)) return res.status(403).json({ ok: false, error: 'Tu rol no puede registrar gastos.' });
      const { concepto, categoria, monto, metodoPago } = parametros;
      if (!concepto || !monto || monto <= 0) {
        return res.status(400).json({ ok: false, error: 'Faltan datos del gasto.' });
      }
      const r = await db.prepare(`
        INSERT INTO gastos (negocio_id, concepto, categoria, monto, metodo_pago)
        VALUES (?, ?, ?, ?, ?) RETURNING concepto, monto
      `).get(negocioId, concepto, categoria || 'General', monto, metodoPago || 'efectivo');
      return res.json({ ok: true, mensaje: `Gasto "${r.concepto}" registrado por $${r.monto}.` });
    }

    if (tipo === 'registrar_compra') {
      if (!['dueno', 'deposito'].includes(rol)) return res.status(403).json({ ok: false, error: 'Tu rol no puede registrar compras.' });
      const { proveedor_nombre, factura, items = [], total } = parametros;
      if (!items.length) return res.status(400).json({ ok: false, error: 'La compra no tiene productos.' });

      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        const compraR = await client.query(
          `INSERT INTO compras (negocio_id, proveedor_nombre, factura, total) VALUES ($1,$2,$3,$4) RETURNING id`,
          [negocioId, proveedor_nombre || null, factura || null, total || 0]
        );
        const compraId = compraR.rows[0].id;

        for (const it of items) {
          await client.query(
            `INSERT INTO compra_items (compra_id, nombre, cantidad, costo_unitario) VALUES ($1,$2,$3,$4)`,
            [compraId, it.nombre, it.cantidad, it.costo_unitario]
          );
          // Suma stock al producto si existe uno con el mismo nombre en el negocio
          await client.query(
            `UPDATE productos SET stock = stock + $1 WHERE negocio_id=$2 AND LOWER(nombre)=LOWER($3)`,
            [it.cantidad, negocioId, it.nombre]
          );
        }
        await client.query('COMMIT');
        return res.json({ ok: true, mensaje: `Compra registrada (${items.length} productos).` });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }

    if (tipo === 'crear_producto') {
      if (!['dueno', 'deposito'].includes(rol)) return res.status(403).json({ ok: false, error: 'Tu rol no puede crear productos.' });
      const { nombre, categoria, precio_costo, precio_venta, stock, codigo } = parametros;
      if (!nombre || precio_venta == null) {
        return res.status(400).json({ ok: false, error: 'Faltan datos del producto.' });
      }
      const r = await db.prepare(`
        INSERT INTO productos (negocio_id, nombre, codigo, categoria, precio_costo, precio_venta, stock)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING nombre
      `).get(negocioId, nombre, codigo || null, categoria || 'General', precio_costo || 0, precio_venta, stock || 0);
      return res.json({ ok: true, mensaje: `Producto "${r.nombre}" creado.` });
    }

    return res.status(400).json({ ok: false, error: 'Tipo de acción desconocido.' });
  } catch (err) {
    console.error('Error en /api/copiloto/confirmar:', err);
    res.status(500).json({ ok: false, error: 'No se pudo aplicar el cambio.' });
  }
});

module.exports = router;
