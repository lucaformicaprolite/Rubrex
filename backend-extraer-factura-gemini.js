// ═══════════════════════════════════════════════════════════════
// Endpoint de referencia: POST /api/compras/extraer-factura
// Versión con Gemini (Google AI), para que uses la misma API que ya
// tenés configurada en tu Copiloto. Agregalo junto a tus rutas /api/*.
// ═══════════════════════════════════════════════════════════════

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// El frontend manda: { archivo: "<base64 sin el prefijo data:...>", nombreArchivo, tipo }
app.post('/api/compras/extraer-factura', requireAuth, async (req, res) => {
  try {
    const { archivo, tipo } = req.body;
    if (!archivo) return res.status(400).json({ ok: false, error: 'Falta el archivo' });

    const mimeType = tipo || 'application/pdf';

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash', // ajustá al modelo que ya uses en tu Copiloto
      generationConfig: { responseMimeType: 'application/json' }
    });

    const prompt = `Sos un asistente contable. Extraé los datos de esta factura de compra
y devolvé SOLO un JSON válido con esta forma exacta:

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

    const result = await model.generateContent([
      { inlineData: { mimeType, data: archivo } },
      { text: prompt }
    ]);

    const textoRespuesta = result.response.text();
    const limpio = textoRespuesta.replace(/```json|```/g, '').trim();
    const extraccion = JSON.parse(limpio);

    res.json({ ok: true, extraccion });
  } catch (err) {
    console.error('Error extrayendo factura:', err);
    res.status(500).json({ ok: false, error: 'No se pudo leer la factura. Probá con otra imagen o cargá manualmente.' });
  }
});

// Nota: si en tu proyecto todavía no instalaste el paquete de Gemini, corré:
//   npm install @google/generative-ai
