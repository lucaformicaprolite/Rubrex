// ══════════════════════════════════════════════════════════
//  RUBREX — server.js
//  Server Express que:
//   1) Sirve el front-end (index.html)
//   2) Expone /api/send-reset  → manda el mail de recuperación (Resend)
//   3) Expone /api/facturar    → pide el CAE a AFIP (vía @afipsdk/afip.js)
// ══════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const path = require('path');
const { Resend } = require('resend');
const Afip = require('@afipsdk/afip.js');

const app = express();
app.use(express.json());

// Sirve index.html y cualquier otro archivo estático (css, imágenes, etc.)
app.use(express.static(__dirname));

// ── Config Resend (email) ────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);
const EMAIL_FROM = process.env.EMAIL_FROM || 'Rubrex <onboarding@resend.dev>';

// ── Config AFIP ───────────────────────────────────────────
// MODO DESARROLLO (default): usa el CUIT de prueba que provee AfipSDK
// (20409378472) y un access_token gratuito, así podés probar el flujo
// completo ANTES de tener tu propio certificado.
// Sacá tu access_token gratis en: https://app.afipsdk.com
//
// MODO PRODUCCIÓN: una vez que tengas tu certificado real, completá
// AFIP_CUIT, AFIP_CERT (contenido del .crt) y AFIP_KEY (contenido del .key)
// en el .env, y poné AFIP_PRODUCTION=true
const afip = new Afip({
  CUIT: process.env.AFIP_CUIT ? Number(process.env.AFIP_CUIT) : 20409378472,
  access_token: process.env.AFIPSDK_ACCESS_TOKEN || undefined,
  cert: process.env.AFIP_CERT || undefined,
  key: process.env.AFIP_KEY || undefined,
  production: process.env.AFIP_PRODUCTION === 'true'
});

// Mapeo de tipo de factura → código de comprobante AFIP
// 1 = Factura A | 6 = Factura B | 11 = Factura C
const TIPO_COMPROBANTE = { A: 1, B: 6, C: 11 };

// ══════════════════════════════════════════════════════════
//  POST /api/send-reset
//  Body: { email, code }
// ══════════════════════════════════════════════════════════
app.post('/api/send-reset', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Faltan datos (email o código).' });
    }

    await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: 'Tu código para restablecer la contraseña — Rubrex',
      html: `
        <div style="font-family:sans-serif;max-width:420px;margin:0 auto">
          <h2 style="color:#C0392B">Rubrex</h2>
          <p>Usá este código para restablecer tu contraseña:</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
          <p style="color:#888;font-size:13px">Válido por 15 minutos. Si no fuiste vos, ignorá este mensaje.</p>
        </div>
      `
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Error en /api/send-reset:', err);
    res.status(500).json({ error: 'No se pudo enviar el email.' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/facturar
//  Body: { items, total, metodoPago, tipoFactura, puntoVenta, docTipo, docNro, razonSocial }
// ══════════════════════════════════════════════════════════
app.post('/api/facturar', async (req, res) => {
  try {
    const {
      total,
      tipoFactura = 'B',
      puntoVenta = 1,
      docTipo = 99,   // 99 = Consumidor Final | 80 = CUIT | 86 = CUIL | 96 = DNI
      docNro = 0
    } = req.body;

    if (!total || total <= 0) {
      return res.status(400).json({ ok: false, error: 'Total inválido.' });
    }

    // Factura A es siempre a Responsable Inscripto: exige CUIT real
    if (tipoFactura === 'A' && (docTipo !== 80 || !docNro)) {
      return res.status(400).json({ ok: false, error: 'Para Factura A el cliente necesita un CUIT válido.' });
    }

    const cbteTipo = TIPO_COMPROBANTE[tipoFactura] || TIPO_COMPROBANTE.B;

    // 1) Averiguar el próximo número de comprobante
    const ultimoNro = await afip.ElectronicBilling.getLastVoucher(puntoVenta, cbteTipo);
    const proximoNro = ultimoNro + 1;

    // 2) Armar la fecha en formato AAAAMMDD que pide AFIP/ARCA
    const hoy = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      .toISOString().split('T')[0];
    const fechaAfip = parseInt(hoy.replace(/-/g, ''));

    // 3) Calcular importes
    // Factura A discrimina IVA siempre (21% por default — ajustá si corresponde
    // otra alícuota). Factura B/C a consumidor final NO discrimina: el importe
    // ya lo incluye. Revisá esto con tu contador según tu actividad.
    const totalRedondeado = Math.round(total * 100) / 100;
    let impNeto, impIVA, ivaArray;
    if (tipoFactura === 'A') {
      impNeto = Math.round((totalRedondeado / 1.21) * 100) / 100;
      impIVA = Math.round((totalRedondeado - impNeto) * 100) / 100;
      ivaArray = [{ Id: 5, BaseImp: impNeto, Importe: impIVA }]; // Id 5 = 21%
    } else {
      impNeto = totalRedondeado;
      impIVA = 0;
      ivaArray = undefined;
    }

    const data = {
      CantReg: 1,
      PtoVta: puntoVenta,
      CbteTipo: cbteTipo,
      Concepto: 1,            // 1 = Productos
      DocTipo: docTipo,
      DocNro: docNro,
      CbteDesde: proximoNro,
      CbteHasta: proximoNro,
      CbteFch: fechaAfip,
      ImpTotal: totalRedondeado,
      ImpTotConc: 0,
      ImpNeto: impNeto,
      ImpOpEx: 0,
      ImpIVA: impIVA,
      ImpTrib: 0,
      MonId: 'PES',
      MonCotiz: 1,
      ...(ivaArray ? { Iva: ivaArray } : {})
    };

    const resultado = await afip.ElectronicBilling.createNextVoucher(data);

    res.json({
      ok: true,
      cae: resultado.CAE,
      caeFechaVto: resultado.CAEFchVto,
      nroComprobante: proximoNro,
      puntoVenta,
      tipoFactura,
      fecha: hoy
    });
  } catch (err) {
    console.error('Error en /api/facturar:', err);
    res.status(500).json({ ok: false, error: 'Error al facturar', detalle: err.message });
  }
});

// Cualquier otra ruta → devuelve el index.html (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Rubrex corriendo en http://localhost:${PORT}`);
});
