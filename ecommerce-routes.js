// ══════════════════════════════════════════════════════════
//  ecommerce-routes.js — Conectar tiendas, mapear productos,
//  y recibir los webhooks de ventas nuevas.
// ══════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const db = require('./db');
const { autenticar, soloDueno } = require('./auth');
const { encrypt, decrypt } = require('./crypto-utils');
const { getAdapter, getAdapterClass, plataformasSoportadas } = require('./adapters/factory');
const { propagarStock, procesarOrdenEntrante, integracionConCredenciales, log } = require('./ecommerce-sync');

function urlBase(req) {
  // Preferimos una variable de entorno explícita (recomendado en producción,
  // ej: https://rubrex.com) — si no está seteada, la inferimos del request.
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// ══════════════════ LISTAR / ESTADO ══════════════════

router.get('/api/integraciones', autenticar, async (req, res) => {
  try {
    const rows = await db.prepare(
      `SELECT id, plataforma, nombre_tienda, store_identifier, activo, ultima_sync, estado_sync
       FROM integraciones_ecommerce WHERE negocio_id = ?`
    ).all(req.clienteId);
    res.json({ ok: true, disponibles: plataformasSoportadas(), integraciones: rows });
  } catch (err) {
    console.error('Error en GET /api/integraciones:', err);
    res.status(500).json({ ok: false, error: 'No se pudieron cargar las integraciones.' });
  }
});

// ══════════════════ WOOCOMMERCE (API key, conexión directa) ══════════════════

router.post('/api/integraciones/woocommerce', autenticar, soloDueno, async (req, res) => {
  try {
    let { store_url, consumer_key, consumer_secret } = req.body;
    if (!store_url || !consumer_key || !consumer_secret) {
      return res.status(400).json({ ok: false, error: 'Faltan datos (URL de la tienda o claves de la API).' });
    }
    store_url = store_url.replace(/\/$/, '');

    // Probamos la conexión antes de guardar nada.
    const fakeIntegracion = { store_identifier: store_url, credenciales: { consumer_key, consumer_secret } };
    const AdapterClass = getAdapterClass('woocommerce');
    const testAdapter = new AdapterClass(fakeIntegracion);
    let productosDeMuestra;
    try {
      productosDeMuestra = await testAdapter.listarProductos();
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'No se pudo conectar con esa tienda. Revisá la URL y las claves.' });
    }

    const r = await db.prepare(`
      INSERT INTO integraciones_ecommerce (negocio_id, plataforma, nombre_tienda, store_identifier, credenciales_enc)
      VALUES (?, 'woocommerce', ?, ?, ?)
      ON CONFLICT (negocio_id, plataforma) DO UPDATE SET
        store_identifier = EXCLUDED.store_identifier,
        credenciales_enc = EXCLUDED.credenciales_enc,
        activo = true
      RETURNING *
    `).get(req.clienteId, store_url, store_url, encrypt(JSON.stringify({ consumer_key, consumer_secret })));

    // Registramos el webhook de "orden nueva" para no depender de que
    // el dueño lo configure a mano.
    const integracion = integracionConCredenciales(r);
    const adapter = getAdapter(integracion);
    const callbackUrl = `${urlBase(req)}/webhooks/woocommerce/${req.clienteId}`;
    await adapter.registrarWebhooks(callbackUrl).catch(() => {});

    res.json({ ok: true, integracion: { id: r.id, plataforma: r.plataforma, nombre_tienda: r.nombre_tienda, store_identifier: r.store_identifier, activo: r.activo }, productosEncontrados: productosDeMuestra.length });
  } catch (err) {
    console.error('Error en POST /api/integraciones/woocommerce:', err);
    res.status(500).json({ ok: false, error: 'No se pudo conectar la tienda.' });
  }
});

// ══════════════════ TIENDA NUBE (OAuth2) ══════════════════

router.get('/api/integraciones/tiendanube/conectar', autenticar, soloDueno, async (req, res) => {
  if (!process.env.TIENDANUBE_CLIENT_ID) {
    return res.status(500).json({ ok: false, error: 'Falta configurar TIENDANUBE_CLIENT_ID en el servidor.' });
  }
  const AdapterClass = getAdapterClass('tiendanube');
  // "state" lleva el token del usuario para poder identificarlo cuando
  // Tienda Nube nos redirija de vuelta (el callback no tiene sesión).
  const state = Buffer.from(JSON.stringify({ clienteId: req.clienteId, r: crypto.randomBytes(6).toString('hex') })).toString('base64url');
  res.json({ ok: true, authUrl: AdapterClass.getAuthUrl(state) });
});

// Tienda Nube redirige acá con ?code=...&state=... — esta ruta NO tiene
// el middleware "autenticar" (el navegador llega solo, sin tu token),
// por eso identificamos al negocio a través del "state".
router.get('/integraciones/tiendanube/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Faltan parámetros de Tienda Nube.');
    const { clienteId } = JSON.parse(Buffer.from(state, 'base64url').toString());

    const AdapterClass = getAdapterClass('tiendanube');
    const { access_token, store_id } = await AdapterClass.exchangeCodeForToken(code);

    const r = await db.prepare(`
      INSERT INTO integraciones_ecommerce (negocio_id, plataforma, nombre_tienda, store_identifier, credenciales_enc)
      VALUES (?, 'tiendanube', ?, ?, ?)
      ON CONFLICT (negocio_id, plataforma) DO UPDATE SET
        store_identifier = EXCLUDED.store_identifier,
        credenciales_enc = EXCLUDED.credenciales_enc,
        activo = true
      RETURNING *
    `).get(clienteId, 'Tienda Nube #' + store_id, store_id, encrypt(JSON.stringify({ access_token })));

    const integracion = integracionConCredenciales(r);
    const adapter = getAdapter(integracion);
    const callbackUrl = `${urlBase(req)}/webhooks/tiendanube/${clienteId}`;
    await adapter.registrarWebhooks(callbackUrl).catch(() => {});

    // Volvemos al panel de Rubrex, a la pantalla de integraciones.
    res.redirect(`${urlBase(req)}/?integracion=ok#integraciones`);
  } catch (err) {
    console.error('Error en callback de Tienda Nube:', err);
    res.redirect(`${urlBase(req)}/?integracion=error#integraciones`);
  }
});

router.get('/api/integraciones/:id/log', autenticar, async (req, res) => {
  try {
    const row = await db.prepare('SELECT id FROM integraciones_ecommerce WHERE id=? AND negocio_id=?')
      .get(req.params.id, req.clienteId);
    if (!row) return res.status(404).json({ ok: false, error: 'Integración no encontrada.' });
    const rows = await db.prepare(
      'SELECT * FROM ecommerce_sync_log WHERE integracion_id = ? ORDER BY creado_en DESC LIMIT 100'
    ).all(req.params.id);
    res.json({ ok: true, log: rows });
  } catch (err) {
    console.error('Error en GET /api/integraciones/:id/log:', err);
    res.status(500).json({ ok: false, error: 'No se pudo cargar la actividad.' });
  }
});

// ══════════════════ MERCADO LIBRE (OAuth2 con refresh token) ══════════════════

router.get('/api/integraciones/mercadolibre/conectar', autenticar, soloDueno, async (req, res) => {
  if (!process.env.MERCADOLIBRE_CLIENT_ID) {
    return res.status(500).json({ ok: false, error: 'Falta configurar MERCADOLIBRE_CLIENT_ID en el servidor.' });
  }
  const AdapterClass = getAdapterClass('mercadolibre');
  const state = Buffer.from(JSON.stringify({ clienteId: req.clienteId, r: crypto.randomBytes(6).toString('hex') })).toString('base64url');
  res.json({ ok: true, authUrl: AdapterClass.getAuthUrl(state) });
});

router.get('/integraciones/mercadolibre/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Faltan parámetros de Mercado Libre.');
    const { clienteId } = JSON.parse(Buffer.from(state, 'base64url').toString());

    const AdapterClass = getAdapterClass('mercadolibre');
    const credenciales = await AdapterClass.exchangeCodeForToken(code);

    const r = await db.prepare(`
      INSERT INTO integraciones_ecommerce (negocio_id, plataforma, nombre_tienda, store_identifier, credenciales_enc)
      VALUES (?, 'mercadolibre', ?, ?, ?)
      ON CONFLICT (negocio_id, plataforma) DO UPDATE SET
        store_identifier = EXCLUDED.store_identifier,
        credenciales_enc = EXCLUDED.credenciales_enc,
        activo = true
      RETURNING *
    `).get(clienteId, 'Mercado Libre #' + credenciales.user_id, credenciales.user_id, encrypt(JSON.stringify(credenciales)));

    // Nota: el webhook de Mercado Libre NO se registra por API — se
    // configura una sola vez en developers.mercadolibre.com.ar (ver
    // adapters/mercadolibre-adapter.js). No hace falta llamarlo acá.

    res.redirect(`${urlBase(req)}/?integracion=ok#integraciones`);
  } catch (err) {
    console.error('Error en callback de Mercado Libre:', err);
    res.redirect(`${urlBase(req)}/?integracion=error#integraciones`);
  }
});

// ══════════════════ DESCONECTAR ══════════════════

router.delete('/api/integraciones/:id', autenticar, soloDueno, async (req, res) => {
  try {
    const r = await db.prepare('DELETE FROM integraciones_ecommerce WHERE id=? AND negocio_id=?')
      .run(req.params.id, req.clienteId);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'Integración no encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error en DELETE /api/integraciones/:id:', err);
    res.status(500).json({ ok: false, error: 'No se pudo desconectar la tienda.' });
  }
});

// ══════════════════ MAPEO DE PRODUCTOS ══════════════════

// Trae los productos de la tienda externa + los de Rubrex + el mapeo actual,
// todo junto, para armar la pantalla de "vinculación manual" en un solo pedido.
router.get('/api/integraciones/:id/productos-externos', autenticar, async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM integraciones_ecommerce WHERE id=? AND negocio_id=?')
      .get(req.params.id, req.clienteId);
    if (!row) return res.status(404).json({ ok: false, error: 'Integración no encontrada.' });

    const integracion = integracionConCredenciales(row);
    const adapter = getAdapter(integracion);
    const externos = await adapter.listarProductos();

    const mapeoActual = await db.prepare(
      'SELECT * FROM productos_ecommerce_map WHERE integracion_id = ?'
    ).all(req.params.id);

    const propios = await db.prepare(
      'SELECT id, nombre, codigo FROM productos WHERE negocio_id = ? ORDER BY nombre ASC'
    ).all(req.clienteId);

    res.json({ ok: true, externos, propios, mapeoActual });
  } catch (err) {
    console.error('Error en GET /api/integraciones/:id/productos-externos:', err);
    res.status(500).json({ ok: false, error: 'No se pudieron traer los productos de la tienda. Revisá que las credenciales sigan siendo válidas.' });
  }
});

router.post('/api/integraciones/:id/mapeo', autenticar, async (req, res) => {
  try {
    const { producto_id, external_id, external_variant_id, external_nombre } = req.body;
    const integracion = await db.prepare('SELECT id FROM integraciones_ecommerce WHERE id=? AND negocio_id=?')
      .get(req.params.id, req.clienteId);
    if (!integracion) return res.status(404).json({ ok: false, error: 'Integración no encontrada.' });

    const r = await db.prepare(`
      INSERT INTO productos_ecommerce_map (integracion_id, producto_id, external_id, external_variant_id, external_nombre)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (integracion_id, producto_id) DO UPDATE SET
        external_id = EXCLUDED.external_id,
        external_variant_id = EXCLUDED.external_variant_id,
        external_nombre = EXCLUDED.external_nombre
      RETURNING *
    `).get(req.params.id, producto_id, external_id, external_variant_id || null, external_nombre || null);

    // Al mapear, sincronizamos el stock actual para arrancar alineados.
    const producto = await db.prepare('SELECT stock FROM productos WHERE id = ?').get(producto_id);
    if (producto) propagarStock(req.clienteId, producto_id, producto.stock).catch(() => {});

    res.json({ ok: true, mapeo: r });
  } catch (err) {
    console.error('Error en POST /api/integraciones/:id/mapeo:', err);
    res.status(500).json({ ok: false, error: 'No se pudo guardar el mapeo.' });
  }
});

router.delete('/api/integraciones/:id/mapeo/:mapeoId', autenticar, async (req, res) => {
  try {
    const r = await db.prepare(`
      DELETE FROM productos_ecommerce_map WHERE id=? AND integracion_id IN
        (SELECT id FROM integraciones_ecommerce WHERE id=? AND negocio_id=?)
    `).run(req.params.mapeoId, req.params.id, req.clienteId);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'Mapeo no encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error en DELETE mapeo:', err);
    res.status(500).json({ ok: false, error: 'No se pudo quitar el mapeo.' });
  }
});

// ══════════════════ WEBHOOK — venta nueva desde la tienda ══════════════════
// Sin "autenticar": estas rutas las llama la plataforma externa, no el
// navegador del dueño. La seguridad pasa por buscar una integración
// activa para ese negocio_id + plataforma, no por un token de Rubrex.
router.post('/webhooks/:plataforma/:negocio_id', express.json(), async (req, res) => {
  const { plataforma, negocio_id } = req.params;
  try {
    const row = await db.prepare(
      'SELECT * FROM integraciones_ecommerce WHERE negocio_id=? AND plataforma=? AND activo=true'
    ).get(negocio_id, plataforma);

    if (!row) return res.sendStatus(404); // no hay integración activa para ese negocio → ignoramos

    // Respondemos rápido (buenas prácticas de webhooks) y procesamos después.
    res.sendStatus(200);

    const integracion = integracionConCredenciales(row);
    const adapter = getAdapter(integracion);
    const ordenNormalizada = await adapter.obtenerOrdenNormalizada(req.body);

    if (!ordenNormalizada) return; // ej: notificación de ML que no es de una orden (envío, pregunta, etc.)

    if (ordenNormalizada.estado !== 'pagado') {
      await log(row.id, 'venta_entrante', 'ok', `Orden ${ordenNormalizada.external_order_id} recibida pero aún no está pagada — se ignora por ahora`);
      return;
    }
    await procesarOrdenEntrante(row, ordenNormalizada);
  } catch (err) {
    console.error(`Error en webhook de ${plataforma}:`, err);
    // La respuesta 200 ya se mandó arriba; esto queda solo en el log/consola.
  }
});

module.exports = router;
