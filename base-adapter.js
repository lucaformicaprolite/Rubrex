// ══════════════════════════════════════════════════════════
//  base-adapter.js — Interfaz común para cualquier plataforma
//  de e-commerce. Agregar una plataforma nueva (Shopify,
//  MercadoLibre, VTEX...) es escribir UNA clase que extienda
//  esta y respete estos métodos. El resto del sistema (rutas,
//  webhooks, sync de stock) no necesita saber nada de la
//  plataforma puntual.
// ══════════════════════════════════════════════════════════
class EcommerceAdapter {
  // `integracion` = fila de la tabla integraciones_ecommerce, con
  // `credenciales` ya desencriptadas (objeto JS, no el JSON crudo).
  constructor(integracion) {
    this.integracion = integracion;
  }

  // Actualiza el stock de UN producto en la plataforma externa.
  // externalId / externalVariantId vienen de productos_ecommerce_map.
  async actualizarStock(externalId, cantidad, externalVariantId = null) {
    throw new Error('actualizarStock no implementado para esta plataforma');
  }

  // Trae los productos de la tienda externa (para la pantalla de mapeo).
  // Debe devolver: [{ external_id, external_variant_id, nombre, sku }]
  async listarProductos() {
    throw new Error('listarProductos no implementado para esta plataforma');
  }

  // Registra el webhook de "nueva orden" en la plataforma externa,
  // apuntando a callbackUrl. Si la plataforma no soporta esto vía API
  // (hay que configurarlo a mano en su panel), puede no hacer nada.
  async registrarWebhooks(callbackUrl) {
    return { manual: true };
  }

  // Punto de entrada que usa el webhook. Por defecto asume que el payload
  // que mandó la plataforma YA ES la orden completa (caso Tienda Nube y
  // WooCommerce) y solo la normaliza. Plataformas como Mercado Libre, que
  // mandan una notificación sin datos y hay que ir a buscarlos aparte,
  // sobreescriben este método en vez de (o además de) normalizarOrden.
  async obtenerOrdenNormalizada(payload) {
    return this.normalizarOrden(payload);
  }

  // Convierte el payload crudo que manda el webhook de la plataforma
  // a un formato único que entiende Rubrex. SIEMPRE debe devolver esta forma:
  normalizarOrden(ordenExterna) {
    return {
      external_order_id: null,
      fecha: null,
      cliente: { nombre: null, email: null, telefono: null },
      items: [], // [{ external_id, external_variant_id, cantidad, precio_unitario, nombre }]
      total: null,
      metodo_pago: null,
      estado: null // 'pagado' | 'pendiente' | 'cancelado'
    };
  }
}

module.exports = EcommerceAdapter;
