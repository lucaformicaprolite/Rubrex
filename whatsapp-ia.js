// ══════════════════════════════════════════════════════════
//  whatsapp-ia.js — Interpreta el pedido de factura por WhatsApp
//
//  Usa el mismo modelo y patrón que copiloto-routes.js (Gemini,
//  reintentos con backoff), pero acá no hay chat de ida y vuelta:
//  recibe un mensaje de texto suelto y tiene que devolver un JSON
//  estructurado con lo que hay que facturar, o pedir que aclaren
//  si falta algo (ej: no dijo el monto).
// ══════════════════════════════════════════════════════════
const { GoogleGenAI, Type } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = 'gemini-3.5-flash';

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

const SYSTEM_PROMPT = `Interpretás pedidos de facturación mandados por WhatsApp a un ERP argentino (Rubrex).
El usuario te escribe en lenguaje natural, en español rioplatense, algo como:
"facturame 5000 por un corte de pelo" o "hac me una factura de 12300 por reparación de heladera".

Tu trabajo es extraer:
- total: el monto en pesos argentinos (número, sin "$" ni puntos de miles)
- descripcion: de qué es la factura, en pocas palabras
- tipoFactura: "A", "B" o "C", SOLO si el usuario lo dijo explícitamente (ej: "facturame como C",
  "necesito factura A"). Si no lo mencionó, NO lo incluyas en la respuesta — el sistema calcula
  automáticamente cuál corresponde según la condición fiscal del negocio. No asumas ni default.

Si el mensaje NO tiene un monto claro, o no queda claro que sea un pedido de facturación (ej: alguien
solo saluda, o pregunta algo), marcá comprensible=false y no inventes valores.`;

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    comprensible: {
      type: Type.BOOLEAN,
      description: 'true si el mensaje es un pedido de factura con monto identificable',
    },
    total: { type: Type.NUMBER, description: 'Monto en pesos, sin símbolos' },
    descripcion: { type: Type.STRING, description: 'Breve descripción del producto/servicio' },
    tipoFactura: {
      type: Type.STRING,
      enum: ['A', 'B', 'C'],
      description: 'Solo si el usuario lo mencionó explícitamente. Omitir si no lo dijo.',
    },
    aclaracionNecesaria: {
      type: Type.STRING,
      description: 'Si comprensible=false, qué le tenés que preguntar al usuario para poder facturar',
    },
  },
  required: ['comprensible'],
};

// ─────────────────────────────────────────────────────────────
// interpretarPedidoFactura(texto) → { comprensible, total?,
//   descripcion?, tipoFactura?, aclaracionNecesaria? }
// ─────────────────────────────────────────────────────────────
async function interpretarPedidoFactura(texto) {
  const respuesta = await generarConReintentos({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: texto }] }],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
    },
  });

  const parteTexto = respuesta.candidates?.[0]?.content?.parts?.find(p => p.text);
  if (!parteTexto) throw new Error('El modelo no devolvió una respuesta interpretable.');

  const json = JSON.parse(parteTexto.text);

  // Saneo básico: si dice que es comprensible pero el total no es un
  // número válido, lo tratamos como no comprensible en vez de romper
  // más adelante en facturacion.js.
  if (json.comprensible && (typeof json.total !== 'number' || json.total <= 0)) {
    return {
      comprensible: false,
      aclaracionNecesaria: '¿Por cuánto es la factura? Decime el monto en pesos.',
    };
  }

  return json;
}

module.exports = { interpretarPedidoFactura, esErrorTransitorio };
