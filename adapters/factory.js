// ══════════════════════════════════════════════════════════
//  factory.js — Punto único donde se registran las plataformas
//  soportadas. Agregar Shopify/MercadoLibre el día de mañana es
//  escribir su adapter y sumar una línea acá — nada más.
// ══════════════════════════════════════════════════════════
const TiendaNubeAdapter = require('./tiendanube-adapter');
const WooCommerceAdapter = require('./woocommerce-adapter');
const MercadoLibreAdapter = require('./mercadolibre-adapter');

const ADAPTERS = {
  tiendanube: TiendaNubeAdapter,
  woocommerce: WooCommerceAdapter,
  mercadolibre: MercadoLibreAdapter
};

function getAdapter(integracion) {
  const AdapterClass = ADAPTERS[integracion.plataforma];
  if (!AdapterClass) throw new Error(`Plataforma no soportada: ${integracion.plataforma}`);
  return new AdapterClass(integracion);
}

function getAdapterClass(plataforma) {
  const AdapterClass = ADAPTERS[plataforma];
  if (!AdapterClass) throw new Error(`Plataforma no soportada: ${plataforma}`);
  return AdapterClass;
}

function plataformasSoportadas() {
  return Object.keys(ADAPTERS);
}

module.exports = { getAdapter, getAdapterClass, plataformasSoportadas };
