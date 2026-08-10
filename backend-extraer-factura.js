// ═══════════════════════════════════════════════════════════════
// Endpoint de referencia: POST /api/compras/extraer-factura
// Agregalo a tu backend (Node/Express) junto al resto de tus rutas /api/*.
// Sigue el mismo patrón que ya usás en /api/copiloto: el frontend nunca
// ve la API key, solo tu servidor le habla a Claude.
// ═══════════════════════════════════════════════════════════════

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// El frontend manda: { archivo: "<base64 sin el prefijo data:...>", nombreArchivo, tipo }
app.post('/api/compras/extraer-factura', requireAuth, async (req, res) => {
  try {
    const { archivo, tipo } = req.body;
    if (!archivo) return res.status(400).json({ ok: false, error: 'Falta el archivo' });

    const esPDF = (tipo || '').includes('pdf');

    const mensaje = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', // usá el modelo que ya tengas configurado
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: esPDF ? 'document' : 'image',
            source: {
              type: 'base64',
              media_type: esPDF ? 'application/pdf' : (tipo || 'image/png'),
              data: archivo
            }
          },
          {
            type: 'text',
            text: `Sos un asistente contable. Extraé los datos de esta factura de compra
y devolvé SOLO un JSON válido (sin texto extra, sin markdown), con esta forma exacta:

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

Si algún campo no se puede leer, usá null o un array vacío. No inventes datos que no estén en la factura.`
          }
        ]
      }]
    });

    const textoRespuesta = mensaje.content.find(b => b.type === 'text')?.text || '{}';
    const limpio = textoRespuesta.replace(/```json|```/g, '').trim();
    const extraccion = JSON.parse(limpio);

    res.json({ ok: true, extraccion });
  } catch (err) {
    console.error('Error extrayendo factura:', err);
    res.status(500).json({ ok: false, error: 'No se pudo leer la factura. Probá con otra imagen o cargá manualmente.' });
  }
});
