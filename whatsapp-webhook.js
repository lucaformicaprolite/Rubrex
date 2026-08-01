// ══════════════════════════════════════════════════════════
//  whatsapp-webhook.js — Recibe los mensajes de WhatsApp (Twilio)
//
//  Twilio manda un POST por cada mensaje entrante, con Content-Type
//  application/x-www-form-urlencoded (no JSON), y espera de vuelta
//  una respuesta en formato TwiML (XML) con lo que le queremos
//  contestar al usuario.
//
//  Variables de entorno necesarias (configurar en Render):
//   - TWILIO_AUTH_TOKEN   → para verificar que el mensaje sea de Twilio
//
//  Flujo actual del webhook:
//   1) ¿El mensaje es un código de vinculación (ej "RBX-7X2K")?
//      → vincula el número a la cuenta y confirma.
//   2) ¿El número no está vinculado a ninguna cuenta?
//      → le pide que vincule primero desde la app.
//   3) Ya vinculado → placeholder por ahora (acá va a ir la IA que
//      interpreta el pedido de factura, más el flujo de confirmación
//      usando la tabla whatsapp_borradores).
// ══════════════════════════════════════════════════════════
const express = require('express');
const twilio = require('twilio');
const db = require('./db');
const { vincularPorCodigo } = require('./whatsapp-routes');

const router = express.Router();

const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

// Twilio manda el remitente como "whatsapp:+5493544644461".
// Lo dejamos en el mismo formato que guardamos en whatsapp_telefono
// (sin "whatsapp:" ni "+"), para que matchee con lo que guarda
// vincularPorCodigo().
function normalizarTelefono(numeroTwilio) {
  return (numeroTwilio || '').replace('whatsapp:', '').replace('+', '');
}

function responderTwiML(res, mensaje) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(mensaje);
  res.type('text/xml').send(twiml.toString());
}

router.post(
  '/api/whatsapp/webhook',
  express.urlencoded({ extended: false }), // Twilio manda form-urlencoded, no JSON
  async (req, res) => {
    try {
      // ── Verificar que el request realmente venga de Twilio ──
      // Sin esto, cualquiera que encuentre la URL podría mandar
      // mensajes falsos haciéndose pasar por un cliente tuyo.
      const firma = req.headers['x-twilio-signature'];
      const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const esValido = TWILIO_AUTH_TOKEN
        ? twilio.validateRequest(TWILIO_AUTH_TOKEN, firma, url, req.body)
        : false;

      if (!esValido) {
        console.warn('Webhook de WhatsApp: firma inválida o TWILIO_AUTH_TOKEN no configurado. Se descarta el request.');
        return res.status(403).send('Firma inválida');
      }

      const telefono = normalizarTelefono(req.body.From);
      const texto = (req.body.Body || '').trim();

      if (!telefono || !texto) {
        return responderTwiML(res, 'No pude leer tu mensaje, ¿podés reenviarlo?');
      }

      // ── Paso 1: ¿es un código de vinculación? (ej "RBX-7X2K") ──
      const matchCodigo = texto.toUpperCase().match(/^RBX-[A-Z0-9]{4}$/);
      if (matchCodigo) {
        const cliente = await vincularPorCodigo(matchCodigo[0], telefono);
        if (cliente) {
          return responderTwiML(
            res,
            `¡Listo${cliente.nombre ? ', ' + cliente.nombre : ''}! Tu WhatsApp quedó vinculado a Rubrex. ` +
            `Ya vas a poder facturar mandando un mensaje, por ejemplo: "facturame $5000 por un corte de pelo".`
          );
        }
        return responderTwiML(
          res,
          'Ese código no es válido o ya venció. Generá uno nuevo desde Rubrex → Mi perfil → WhatsApp.'
        );
      }

      // ── Paso 2: ¿este número ya está vinculado a alguna cuenta? ──
      const cliente = await db.prepare(
        'SELECT id, nombre FROM clientes WHERE whatsapp_telefono = ?'
      ).get(telefono);

      if (!cliente) {
        return responderTwiML(
          res,
          'Todavía no vinculé este número a ninguna cuenta de Rubrex. ' +
          'Entrá a Rubrex → Mi perfil → WhatsApp, generá un código, y mandámelo por acá para vincular tu cuenta.'
        );
      }

      // ── Paso 3: TODO — interpretar el pedido con IA y armar el
      // borrador de factura (tabla whatsapp_borradores), o procesar
      // la confirmación si ya había un borrador pendiente para este
      // número. Lo armamos en el próximo paso.
      return responderTwiML(
        res,
        `Hola${cliente.nombre ? ' ' + cliente.nombre : ''}! Recibí: "${texto}". ` +
        `Todavía estoy aprendiendo a facturar por acá, esta parte la estamos terminando de armar 🚧`
      );
    } catch (err) {
      console.error('Error en webhook de WhatsApp:', err);
      responderTwiML(res, 'Tuve un problema procesando tu mensaje. Probá de nuevo en un rato.');
    }
  }
);

module.exports = router;
