// ══════════════════════════════════════════════════════════
//  woocommerce-adapter.js
//
//  A diferencia de Tienda Nube, WooCommerce NO requiere que nadie
//  apruebe una app: el dueño del negocio genera sus propias claves
//  desde WP Admin → WooCommerce → Ajustes → Avanzado → REST API,
//  y las pega directo en Rubrex. Por eso este es el más simple de
//  conectar y el mejor punto de partida para probar el flujo.
// ══════════════════════════════════════════════════════════
const EcommerceAdapter = require('./base-adapter');

class WooCommerceAdapter extends EcommerceAdapter {
  _authHeader() {
    const { consumer_key, consumer_secret } = this.integracion.credenciales;
    return 'Basic ' + Buffer.from(`${consumer_key}:${consumer_secret}`).toString('base64');
  }
  _baseUrl() {
    // store_identifier = URL de la tienda, ej: "https://mitienda.com" (sin barra final)
    return this.integracion.store_identifier.replace(/\/$/, '');
  }

  async actualizarStock(externalId, cantidad) {
    const r = await fetch(`${this._baseUrl()}/wp-json/wc/v3/products/${externalId}`, {
      method: 'PUT',
      headers: { Authorization: this._authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ stock_quantity: cantidad, manage_stock: true })
    });
    if (!r.ok) throw new Error('WooCommerce rechazó la actualización de stock (HTTP ' + r.status + ').');
  }

  async listarProductos() {
    const out = [];
    let page = 1;
    while (true) {
      const r = await fetch(`${this._baseUrl()}/wp-json/wc/v3/products?per_page=100&page=${page}`, {
        headers: { Authorization: this._authHeader() }
      });
      if (!r.ok) throw new Error('No se pudieron traer los productos de WooCommerce.');
      const productos = await r.json();
      if (!productos.length) break;
      productos.forEach(p => out.push({
        external_id: String(p.id),
        external_variant_id: null,
        nombre: p.name,
        sku: p.sku || ''
      }));
      if (productos.length < 100) break;
      page++;
    }
    return out;
  }

  async registrarWebhooks(callbackUrl) {
    const eventos = [
      { topic: 'order.created', name: 'Rubrex - Orden creada' },
      { topic: 'order.updated', name: 'Rubrex - Orden actualizada' }
    ];
    for (const ev of eventos) {
      await fetch(`${this._baseUrl()}/wp-json/wc/v3/webhooks`, {
        method: 'POST',
        headers: { Authorization: this._authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: ev.name, topic: ev.topic, delivery_url: callbackUrl, status: 'active' })
      }).catch(() => {});
    }
    return { manual: false };
  }

  normalizarOrden(o) {
    return {
      external_order_id: String(o.id),
      fecha: o.date_created,
      cliente: {
        nombre: `${o.billing?.first_name || ''} ${o.billing?.last_name || ''}`.trim() || 'Cliente de WooCommerce',
        email: o.billing?.email || null,
        telefono: o.billing?.phone || null
      },
      items: (o.line_items || []).map(li => ({
        external_id: String(li.product_id),
        external_variant_id: li.variation_id ? String(li.variation_id) : null,
        cantidad: li.quantity,
        precio_unitario: parseFloat(li.price),
        nombre: li.name
      })),
      total: parseFloat(o.total),
      metodo_pago: o.payment_method_title || 'e-commerce',
      estado: ['processing', 'completed'].includes(o.status) ? 'pagado' : 'pendiente'
    };
  }
}

module.exports = WooCommerceAdapter;
