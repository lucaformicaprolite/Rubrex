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
//   - GEMINI_API_KEY      → ya la tenés, la usa el Copiloto también
//   - AFIPSDK_ACCESS_TOKEN → ya la tenés, la usa /api/facturar también
//
//  Flujo del webhook:
//   1) ¿El mensaje es un código de vinculación (ej "RBX-7X2K")?
//      → vincula el número a la cuenta y confirma.
//   2) ¿El número no está vinculado a ninguna cuenta?
//      → le pide que vincule primero desde la app.
//   3) ¿Hay un borrador de factura pendiente de confirmar para este
//      número? → interpreta si contestó "sí" (factura de verdad) o
//      "no" (cancela), o si mandó otra cosa, se lo aclara.
//   4) Si no hay borrador pendiente → le pide a la IA que interprete
//      el mensaje como pedido de factura. Si entendió, guarda el
//      borrador y pide confirmación. Si no entendió, se lo dice.
// ══════════════════════════════════════════════════════════
const express = require('express');
const twilio = require('twilio');
const db = require('./db');
const { vincularPorCodigo } = require('./whatsapp-routes');
const { interpretarPedidoFactura, esErrorTransitorio } = require('./whatsapp-ia');
const { emitirFactura, ErrorFacturacion } = require('./facturacion');

const router = express.Router();

const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const MINUTOS_VALIDEZ_BORRADOR = 5;

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

function esAfirmativo(texto) {
  return /^(si|sí|dale|confirmo|ok|listo|correcto|si\s*porfavor|sisi)$/i.test(texto.trim());
}
function esNegativo(texto) {
  return /^(no|cancelar|cancela|nel|nop)$/i.test(texto.trim());
}

function formatearPesos(n) {
  return Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

      const saludo = cliente.nombre ? ` ${cliente.nombre}` : '';

      // ── Paso 3: ¿hay un borrador de factura esperando confirmación? ──
      const borrador = await db.prepare(`
        SELECT id, datos FROM whatsapp_borradores
        WHERE telefono = ? AND negocio_id = ? AND estado = 'pendiente_confirmacion' AND expira > NOW()
        ORDER BY creado_en DESC LIMIT 1
      `).get(telefono, cliente.id);

      if (borrador) {
        if (esAfirmativo(texto)) {
          await db.prepare('DELETE FROM whatsapp_borradores WHERE id = ?').run(borrador.id);
          try {
            const resultado = await emitirFactura(cliente.id, {
              total: borrador.datos.total,
              tipoFactura: borrador.datos.tipoFactura,
            });
            return responderTwiML(
              res,
              `✅ Factura emitida por $${formatearPesos(resultado.total)}.\n` +
              `CAE: ${resultado.cae}\n` +
              `Comprobante N° ${resultado.nroComprobante} (Punto de venta ${resultado.puntoVenta})`
            );
          } catch (err) {
            const mensajeError = err instanceof ErrorFacturacion
              ? err.message
              : 'Tuve un problema al facturar con AFIP. Probá de nuevo en un rato, o hacelo desde Rubrex.';
            console.error('Error al emitir factura desde WhatsApp:', err);
            return responderTwiML(res, `❌ ${mensajeError}`);
          }
        }

        if (esNegativo(texto)) {
          await db.prepare('DELETE FROM whatsapp_borradores WHERE id = ?').run(borrador.id);
          return responderTwiML(res, 'Listo, cancelado. Mandame otro pedido cuando quieras.');
        }

        // Mandó otra cosa (ni sí ni no): recordamos qué está pendiente.
        return responderTwiML(
          res,
          `Todavía tengo pendiente confirmar: $${formatearPesos(borrador.datos.total)} por "${borrador.datos.descripcion}". ` +
          `Respondé "sí" para facturar o "no" para cancelar.`
        );
      }

      // ── Paso 4: no hay borrador pendiente → interpretar mensaje nuevo con IA ──
      let interpretado;
      try {
        interpretado = await interpretarPedidoFactura(texto);
      } catch (err) {
        console.error('Error interpretando pedido de factura con IA:', err);
        const msg = esErrorTransitorio(err)
          ? 'Estoy con mucha demanda ahora mismo, probá de nuevo en unos segundos.'
          : 'No pude entender el pedido. Probá de nuevo, por ejemplo: "facturame 5000 por un corte de pelo".';
        return responderTwiML(res, msg);
      }

      if (!interpretado.comprensible) {
        return responderTwiML(
          res,
          interpretado.aclaracionNecesaria ||
          `Hola${saludo}! No entendí bien el pedido. Mandame algo como: "facturame 5000 por un corte de pelo".`
        );
      }

      const expira = new Date(Date.now() + MINUTOS_VALIDEZ_BORRADOR * 60 * 1000);
      await db.prepare(`
        INSERT INTO whatsapp_borradores (negocio_id, telefono, datos, expira)
        VALUES (?, ?, ?, ?)
      `).run(
        cliente.id,
        telefono,
        JSON.stringify({
          total: interpretado.total,
          descripcion: interpretado.descripcion || 'Sin descripción',
          tipoFactura: interpretado.tipoFactura || 'B',
        }),
        expira
      );

      return responderTwiML(
        res,
        `Vas a facturar $${formatearPesos(interpretado.total)} (Factura ${interpretado.tipoFactura || 'B'}) ` +
        `por "${interpretado.descripcion || 'sin descripción'}". ¿Confirmás? Respondé "sí" o "no".`
      );
    } catch (err) {
      console.error('Error en webhook de WhatsApp:', err);
      responderTwiML(res, 'Tuve un problema procesando tu mensaje. Probá de nuevo en un rato.');
    }
  }
);

module.exports = router;

