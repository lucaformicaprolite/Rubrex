// ══════════════════════════════════════════════════════════
//  factura-routes.js — Extracción de facturas de compra con IA
//
//  Requiere:
//    (ya lo tenés) npm install @google/genai --save
//    (ya la tenés) GEMINI_API_KEY como variable de entorno en Render
//
//  Se monta en server.js IGUAL que copiloto-routes.js:
//    app.use(require('./factura-routes'));
// ══════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { GoogleGenAI } = require('@google/genai');

const { autenticar } = require('./auth');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = 'gemini-3.5-flash';

// Mismo helper de reintentos que copiloto-routes.js (duplicado acá para que
// este archivo funcione solo; si preferís, movelo a un módulo compartido
// ej. ./ia-utils.js y lo importás en los dos lados).
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
      const espera = esperaBaseMs * Math.pow(2, i);
      console.warn(`Gemini transitorio (intento ${i + 1}/${intentos}), reintentando en ${espera}ms:`, err.message);
      await new Promise(r => setTimeout(r, espera));
    }
  }
  throw ultimoError;
}

const PROMPT_EXTRACCION = `Sos un asistente contable. Extraé los datos de esta factura de compra
y devolvé SOLO un JSON válido (sin texto extra, sin markdown) con esta forma exacta:

{
  "proveedorNombre": "string",
  "proveedorCuit": "string",
  "tipoComprobante": "string (ej: Factura A)",
  "numero": "string (ej: 0002-00000027)",
  "fecha": "YYYY-MM-DD",
  "items": [
    { "codigo": "string opcional", "descripcion": "string", "cantidad": number, "precioUnitario": number }
  ],
  "subtotal": number,
  "iva": number,
  "percepciones": number,
  "total": number
}

Si algún campo no se puede leer, usá null o un array vacío. No inventes datos que no estén en la factura.`;

// ─────────────────────────────────────────────────────────────
// POST /api/compras/extraer-factura
// Body: { archivo: "<base64 sin prefijo data:...>", nombreArchivo, tipo }
// ─────────────────────────────────────────────────────────────
router.post('/api/compras/extraer-factura', autenticar, async (req, res) => {
  const { archivo, tipo } = req.body;
  if (!archivo) {
    return res.status(400).json({ ok: false, error: 'Falta el archivo.' });
  }

  try {
    const mimeType = tipo || 'application/pdf';

    const respuesta = await generarConReintentos({
      model: MODEL,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: archivo } },
          { text: PROMPT_EXTRACCION },
        ],
      }],
      config: {
        responseMimeType: 'application/json',
      },
    });

    const parts = respuesta.candidates?.[0]?.content?.parts || [];
    const partTexto = parts.find(p => p.text);
    const textoRespuesta = partTexto ? partTexto.text : '{}';
    const limpio = textoRespuesta.replace(/```json|```/g, '').trim();
    const extraccion = JSON.parse(limpio);

    res.json({ ok: true, extraccion });
  } catch (err) {
    console.error('Error en /api/compras/extraer-factura:', err);
    const mensaje = esErrorTransitorio(err)
      ? 'El lector de facturas está con mucha demanda ahora mismo. Probá de nuevo en unos segundos.'
      : 'No se pudo leer la factura. Probá con otra imagen o cargá la compra a mano.';
    res.status(503).json({ ok: false, error: mensaje });
  }
});

module.exports = router;
