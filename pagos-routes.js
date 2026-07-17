// ══════════════════════════════════════════════════════════
//  pagos-routes.js — Suscripciones con MercadoPago
//
//  Expone dos endpoints:
//   POST /api/suscripcion/crear    → el front lo llama justo después de
//        registrar la cuenta. Crea la suscripción (preapproval) en
//        MercadoPago y devuelve el link (init_point) para mandar al
//        usuario a cargar la tarjeta.
//   POST /api/mercadopago/webhook  → NO lo llama el front, lo llama
//        MercadoPago solo, para avisar cuando cambia el estado del pago
//        o de la suscripción (tarjeta cargada, cobro exitoso, cancelación).
//
//  Variables de entorno que necesita este archivo (agregalas en Render):
//   MP_ACCESS_TOKEN  → el "Access Token" de producción de tu cuenta de
//                       MercadoPago (Panel de desarrolladores > Credenciales).
//   SITE_URL         → la URL pública de tu sitio, ej: https://rubrex.com
//                       (se usa para volver ahí después del pago).
//
//  Instalación: correr una vez en el proyecto:
//   npm install mercadopago
//
//  Y en server.js, junto a los otros app.use(require('./...')), agregar:
//   app.use(require('./pagos-routes').bloquearSiVencido); ← poner esta ANTES que las demás rutas
//   app.use(require('./pagos-routes'));                   ← esta puede ir donde estaban las otras
// ══════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { MercadoPagoConfig, PreApproval, Payment } = require('mercadopago');

const db = require('./db');
const { autenticar } = require('./auth');

const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const preapproval = new PreApproval(mpClient);
const pagoMP = new Payment(mpClient);

// Precios reales de la landing (sección de precios de index.html).
const PLANES = {
  starter:  { nombre: 'Rubrex - Plan Starter',  precio: 19999 },
  pro:      { nombre: 'Rubrex - Plan Pro',      precio: 54999 },
  business: { nombre: 'Rubrex - Plan Business', precio: 139999 }
};

const DIAS_TRIAL = 15;
const DIAS_GRACIA = 10; // si falla el cobro del mes, cuánto esperamos antes de cortar
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';

// ══════════════════════════════════════════════════════════
//  Rutas de /api/ que NO requieren tener el pago al día.
//  Todo lo que no esté en esta lista, si el que pide tiene una
//  cuenta con la suscripción vencida, se bloquea.
// ══════════════════════════════════════════════════════════
const RUTAS_SIN_BLOQUEO = [
  '/api/registro',
  '/api/login',
  '/api/me',
  '/api/send-reset',
  '/api/contacto',
  '/api/suscripcion/crear',
  '/api/mercadopago/webhook'
];

// ══════════════════════════════════════════════════════════
//  Middleware global: corta el acceso a la app si la cuenta no
//  está al día (trial vencido, plan cancelado, pago rechazado).
//  Se engancha en server.js ANTES de las demás rutas.
// ══════════════════════════════════════════════════════════
async function bloquearSiVencido(req, res, next) {
  // No tocamos nada que no sea /api/, ni las rutas de la lista libre.
  if (!req.path.startsWith('/api/') || RUTAS_SIN_BLOQUEO.includes(req.path)) {
    return next();
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next(); // sin token: que la ruta de siempre responda 401

  // Delegamos la validación del token al mismo "autenticar" que usa el
  // resto de la app. Si el token es inválido, autenticar ya responde
  // el error y corta acá — no seguimos.
  autenticar(req, res, async () => {
    try {
      if (!req.clienteId) return next();

      const cliente = await db.prepare('SELECT exento_pago, estado_suscripcion, trial_fin, gracia_fin FROM clientes WHERE id = ?')
        .get(req.clienteId);
      if (!cliente) return next();

      if (cliente.exento_pago) return next(); // cuenta admin/interna: pasa siempre

      const ahora = new Date();
      const trialVigente = cliente.trial_fin && new Date(cliente.trial_fin) > ahora;
      const graciaVigente = cliente.gracia_fin && new Date(cliente.gracia_fin) > ahora;

      const accesoOk = cliente.estado_suscripcion === 'activo'
        || (cliente.estado_suscripcion === 'trial_activo' && trialVigente)
        || (cliente.estado_suscripcion === 'gracia' && graciaVigente); // falló un cobro, pero todavía está dentro del margen

      if (accesoOk) return next();

      return res.status(402).json({
        ok: false,
        suscripcionVencida: true,
        error: 'Tu cuenta no tiene el pago al día. Reactivá tu plan para seguir usando Rubrex.'
      });
    } catch (err) {
      console.error('Error en bloquearSiVencido:', err);
      return next(); // ante la duda, no tumbamos el servidor
    }
  });
}

// ══════════════════════════════════════════════════════════
//  POST /api/suscripcion/crear   (requiere estar logueado)
//  Body esperado: { plan: 'intermedio' | 'pro' }
// ══════════════════════════════════════════════════════════
router.post('/api/suscripcion/crear', autenticar, async (req, res) => {
  try {
    const { plan } = req.body || {};
    if (!PLANES[plan]) {
      return res.status(400).json({ error: 'Plan inválido.' });
    }
    if (!process.env.MP_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'Falta configurar MP_ACCESS_TOKEN en el servidor.' });
    }

    const cliente = await db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.clienteId);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });

    const trialFin = new Date(Date.now() + DIAS_TRIAL * 24 * 60 * 60 * 1000);

    const resultado = await preapproval.create({
      body: {
        reason: PLANES[plan].nombre,
        external_reference: String(cliente.id), // así el webhook sabe a qué cliente actualizar
        payer_email: cliente.email,
        back_url: `${SITE_URL}/?suscripcion=ok`,
        status: 'pending',
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: PLANES[plan].precio,
          currency_id: 'ARS',
          start_date: trialFin.toISOString() // recién ahí se hace el primer cobro
        }
      }
    });

    await db.prepare(`
      UPDATE clientes
      SET plan = ?, estado_suscripcion = 'pendiente', trial_fin = ?, mp_preapproval_id = ?
      WHERE id = ?
    `).run(plan, trialFin, resultado.id, cliente.id);

    res.json({ ok: true, init_point: resultado.init_point });
  } catch (err) {
    console.error('Error en /api/suscripcion/crear:', err);
    res.status(500).json({ error: 'No se pudo iniciar la suscripción.' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/mercadopago/webhook
//  Esta URL hay que cargarla en el panel de MercadoPago
//  (Tus integraciones > tu app > Webhooks) como:
//    https://tu-servidor.com/api/mercadopago/webhook
// ══════════════════════════════════════════════════════════
router.post('/api/mercadopago/webhook', async (req, res) => {
  // Respondemos 200 ya mismo. Si tardamos, MercadoPago reintenta de más
  // y no gana nada quedarse esperando a que terminemos de procesar.
  res.sendStatus(200);

  try {
    const tipo = req.query.type || (req.body && req.body.type);
    const id = req.query['data.id'] || (req.body && req.body.data && req.body.data.id);
    if (!id) return;

    if (tipo === 'subscription_preapproval' || tipo === 'preapproval') {
      const info = await preapproval.get({ id });
      const clienteId = parseInt(info.external_reference, 10);
      if (!clienteId) return;

      if (info.status === 'authorized') {
        // Cargó la tarjeta y está al día: sacamos cualquier margen que
        // hubiera quedado pendiente de una falla anterior.
        await db.prepare(`
          UPDATE clientes SET estado_suscripcion = 'trial_activo', mp_preapproval_id = ?, gracia_fin = NULL WHERE id = ?
        `).run(info.id, clienteId);
      } else if (info.status === 'paused') {
        // MercadoPago ya reintentó varias veces y no pudo cobrar: le damos
        // el margen de DIAS_GRACIA, pero sin resetear el reloj si ya
        // estaba corriendo por un aviso anterior.
        const cliente = await db.prepare('SELECT gracia_fin, estado_suscripcion FROM clientes WHERE id = ?').get(clienteId);
        const graciaFin = (cliente && cliente.gracia_fin) ? cliente.gracia_fin : new Date(Date.now() + DIAS_GRACIA * 24 * 60 * 60 * 1000);
        await db.prepare(`
          UPDATE clientes SET estado_suscripcion = 'gracia', mp_preapproval_id = ?, gracia_fin = ? WHERE id = ?
        `).run(info.id, graciaFin, clienteId);
      } else if (info.status === 'cancelled') {
        // Cancelación explícita (no es una falla de pago): corta directo, sin margen.
        await db.prepare(`
          UPDATE clientes SET estado_suscripcion = 'cancelada', mp_preapproval_id = ? WHERE id = ?
        `).run(info.id, clienteId);
      }
    }

    if (tipo === 'payment') {
      const pago = await pagoMP.get({ id });
      const clienteId = pago.external_reference ? parseInt(pago.external_reference, 10) : null;
      if (!clienteId) return;

      if (pago.status === 'approved') {
        // Cobro exitoso: cuenta activa, y borramos cualquier margen pendiente.
        await db.prepare(`
          UPDATE clientes SET estado_suscripcion = 'activo', mp_ultimo_pago = NOW(), gracia_fin = NULL WHERE id = ?
        `).run(clienteId);
      } else if (pago.status === 'rejected') {
        // Primer aviso de que el cobro del mes falló: arranca el margen de
        // DIAS_GRACIA días. Si ya estaba corriendo (otro reintento fallido
        // del mismo mes), no lo reiniciamos.
        const cliente = await db.prepare('SELECT gracia_fin FROM clientes WHERE id = ?').get(clienteId);
        const graciaFin = (cliente && cliente.gracia_fin) ? cliente.gracia_fin : new Date(Date.now() + DIAS_GRACIA * 24 * 60 * 60 * 1000);
        await db.prepare(`
          UPDATE clientes SET estado_suscripcion = 'gracia', gracia_fin = ? WHERE id = ?
        `).run(graciaFin, clienteId);
      }
    }
  } catch (err) {
    console.error('Error procesando webhook de MercadoPago:', err);
  }
});

module.exports = router;
module.exports.bloquearSiVencido = bloquearSiVencido;
