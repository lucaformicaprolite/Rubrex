// ══════════════════════════════════════════════════════════
//  facturacion.js — Lógica de emisión de factura a AFIP
//
//  Extraída de /api/facturar en server.js para que la pueda llamar
//  también el webhook de WhatsApp (whatsapp-webhook.js), sin
//  duplicar código ni hacer un HTTP call interno raro.
//
//  emitirFactura(negocioId, { total, tipoFactura }) hace exactamente
//  lo mismo que hacía el endpoint, pero como función común. El
//  endpoint /api/facturar en server.js ahora es solo una capa fina
//  encima de esto (valida el rol del usuario logueado y llama acá).
// ══════════════════════════════════════════════════════════
const Afip = require('@afipsdk/afip.js');
const db = require('./db');
const { decrypt } = require('./crypto-utils');

const TIPO_COMPROBANTE = { A: 1, B: 6, C: 11 };

class ErrorFacturacion extends Error {
  constructor(mensaje, status = 400) {
    super(mensaje);
    this.status = status;
  }
}

// Misma regla que getTipoFactura() en el frontend (index.html), pero acá
// asumimos siempre "Consumidor Final" del lado del cliente porque el
// webhook de WhatsApp no pide CUIT/DNI de a quién le estás facturando.
// Si el negocio es Responsable Inscripto y en algún momento facturan a
// OTRO Responsable Inscripto identificado, eso va a seguir necesitando
// hacerse desde la web (ahí sí se puede elegir el cliente y sale "A").
function calcularTipoFacturaPorDefecto(condicionIvaNegocio) {
  if (condicionIvaNegocio === 'Monotributo') return 'C';
  return 'B'; // Responsable Inscripto a Consumidor Final, o condición sin configurar
}

async function emitirFactura(negocioId, { total, tipoFactura }) {
  const cliente = await db.prepare('SELECT * FROM clientes WHERE id = ?').get(negocioId);

  if (!cliente || !cliente.afip_cuit || !cliente.afip_cert || !cliente.afip_key) {
    throw new ErrorFacturacion(
      'Este negocio todavía no cargó sus credenciales de AFIP. Andá a Rubrex → Credenciales AFIP primero.'
    );
  }

  // Si no vino un tipoFactura explícito (ej: el webhook de WhatsApp, que
  // no siempre lo sabe), lo calculamos según la condición de IVA del
  // negocio en vez de asumir "B" a ciegas — eso es justo lo que rompía
  // cuando un monotributista intentaba facturar por WhatsApp.
  const tipoFacturaFinal = tipoFactura || calcularTipoFacturaPorDefecto(cliente.condicion_iva_negocio);

  if (!process.env.AFIPSDK_ACCESS_TOKEN) {
    throw new ErrorFacturacion(
      'Falta configurar AFIPSDK_ACCESS_TOKEN en las variables de entorno del servidor.',
      500
    );
  }

  if (!total || total <= 0) {
    throw new ErrorFacturacion('Total inválido.');
  }

  // Limpiamos el CUIT por si quedó guardado con guiones o espacios
  // (ej: "20-12345678-9"), porque AfipSDK exige solo los 11 dígitos.
  const cuitLimpio = String(cliente.afip_cuit).replace(/\D/g, '');

  const afip = new Afip({
    CUIT: Number(cuitLimpio),
    cert: decrypt(cliente.afip_cert),
    key: decrypt(cliente.afip_key),
    production: !!cliente.afip_production,
    access_token: process.env.AFIPSDK_ACCESS_TOKEN,
  });

  const puntoVenta = cliente.afip_punto_venta || 1;
  const cbteTipo = TIPO_COMPROBANTE[tipoFacturaFinal] || TIPO_COMPROBANTE.B;

  // 1) Averiguar el próximo número de comprobante
  const ultimoNro = await afip.ElectronicBilling.getLastVoucher(puntoVenta, cbteTipo);
  const proximoNro = ultimoNro + 1;

  // 2) Armar la fecha en formato AAAAMMDD que pide AFIP
  const hoy = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString().split('T')[0];
  const fechaAfip = parseInt(hoy.replace(/-/g, ''));

  // 3) Calcular importes (sin discriminar IVA, igual que el endpoint original)
  const totalRedondeado = Math.round(total * 100) / 100;

  const data = {
    CantReg: 1,
    PtoVta: puntoVenta,
    CbteTipo: cbteTipo,
    Concepto: 1,
    DocTipo: 99,
    DocNro: 0,
    CbteDesde: proximoNro,
    CbteHasta: proximoNro,
    CbteFch: fechaAfip,
    ImpTotal: totalRedondeado,
    ImpTotConc: 0,
    ImpNeto: totalRedondeado,
    ImpOpEx: 0,
    ImpIVA: 0,
    ImpTrib: 0,
    MonId: 'PES',
    MonCotiz: 1,
  };

  const resultado = await afip.ElectronicBilling.createNextVoucher(data);

  return {
    cae: resultado.CAE,
    caeFechaVto: resultado.CAEFchVto,
    nroComprobante: proximoNro,
    puntoVenta,
    tipoFactura: tipoFacturaFinal,
    fecha: hoy,
    total: totalRedondeado,
  };
}

module.exports = { emitirFactura, ErrorFacturacion, calcularTipoFacturaPorDefecto };
