// ══════════════════════════════════════════════════════════
//  whatsapp-routes.js — Vinculación de cuenta con WhatsApp
//
//  Expone:
//   1) POST /api/whatsapp/generar-codigo → el dueño genera un código
//      corto (ej "RBX-7X2K") desde la app, para mandarlo por WhatsApp
//      y vincular su número sin exponer la contraseña por chat.
//   2) GET  /api/whatsapp/estado         → si ya está vinculado o no.
//   3) POST /api/whatsapp/desvincular    → borra el número vinculado.
//
//  También exporta vincularPorCodigo(), que va a usar el webhook de
//  WhatsApp (todavía no creado) cuando alguien le escriba el código
//  al bot para confirmar la vinculación.
// ══════════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const { autenticar, soloDueno } = require('./auth');

const router = express.Router();

const MINUTOS_VALIDEZ_CODIGO = 10;

// Sin O/0/I/1 para que no se confundan al leer el código en voz alta
// o al tipearlo rápido desde WhatsApp.
const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generarCodigo() {
  let codigo = '';
  for (let i = 0; i < 4; i++) {
    codigo += ALFABETO_CODIGO[crypto.randomInt(0, ALFABETO_CODIGO.length)];
  }
  return `RBX-${codigo}`;
}

// ══════════════════════════════════════════════════════════
//  POST /api/whatsapp/generar-codigo   (requiere ser el dueño)
//  Genera un código de vinculación válido por 10 minutos.
// ══════════════════════════════════════════════════════════
router.post('/api/whatsapp/generar-codigo', autenticar, soloDueno, async (req, res) => {
  try {
    const codigo = generarCodigo();
    const expira = new Date(Date.now() + MINUTOS_VALIDEZ_CODIGO * 60 * 1000);

    await db.prepare(`
      UPDATE clientes
      SET whatsapp_codigo_vinculacion = ?, whatsapp_codigo_expira = ?
      WHERE id = ?
    `).run(codigo, expira, req.clienteId);

    res.json({ ok: true, codigo, expira, minutosValidez: MINUTOS_VALIDEZ_CODIGO });
  } catch (err) {
    console.error('Error en /api/whatsapp/generar-codigo:', err);
    res.status(500).json({ error: 'No se pudo generar el código.' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/whatsapp/estado   (requiere estar logueado)
//  Devuelve si la cuenta ya tiene un número de WhatsApp vinculado.
//  No expone el número completo, solo los últimos 4 dígitos, para
//  que el dueño pueda reconocerlo sin que quede visible del todo.
// ══════════════════════════════════════════════════════════
router.get('/api/whatsapp/estado', autenticar, async (req, res) => {
  try {
    const cliente = await db.prepare(
      'SELECT whatsapp_telefono FROM clientes WHERE id = ?'
    ).get(req.clienteId);

    const telefono = cliente?.whatsapp_telefono || null;
    res.json({
      ok: true,
      vinculado: !!telefono,
      telefonoParcial: telefono ? `•••• ${telefono.slice(-4)}` : null
    });
  } catch (err) {
    console.error('Error en /api/whatsapp/estado:', err);
    res.status(500).json({ error: 'No se pudo consultar el estado.' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/whatsapp/desvincular   (requiere ser el dueño)
// ══════════════════════════════════════════════════════════
router.post('/api/whatsapp/desvincular', autenticar, soloDueno, async (req, res) => {
  try {
    await db.prepare(
      'UPDATE clientes SET whatsapp_telefono = NULL WHERE id = ?'
    ).run(req.clienteId);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error en /api/whatsapp/desvincular:', err);
    res.status(500).json({ error: 'No se pudo desvincular.' });
  }
});

// ══════════════════════════════════════════════════════════
//  vincularPorCodigo(codigo, telefono)
//  La va a llamar el webhook cuando alguien le escriba un código al
//  bot. Busca al cliente dueño de ese código (no vencido), y si lo
//  encuentra, guarda el número que le escribió como su
//  whatsapp_telefono y limpia el código (de un solo uso).
//
//  Devuelve el cliente vinculado, o null si el código no existe o
//  ya venció.
// ══════════════════════════════════════════════════════════
async function vincularPorCodigo(codigo, telefono) {
  const cliente = await db.prepare(`
    SELECT id, nombre FROM clientes
    WHERE whatsapp_codigo_vinculacion = ?
      AND whatsapp_codigo_expira > NOW()
  `).get(codigo);

  if (!cliente) return null;

  await db.prepare(`
    UPDATE clientes
    SET whatsapp_telefono = ?,
        whatsapp_codigo_vinculacion = NULL,
        whatsapp_codigo_expira = NULL
    WHERE id = ?
  `).run(telefono, cliente.id);

  return cliente;
}

module.exports = router;
module.exports.vincularPorCodigo = vincularPorCodigo;
