// ══════════════════════════════════════════════════════════
//  tiendanube-adapter.js
//
//  IMPORTANTE — requisito previo fuera del código:
//  Tienda Nube requiere que registres una "app" en su portal de
//  partners (https://partners.tiendanube.com) para conseguir un
//  TIENDANUBE_CLIENT_ID y TIENDANUBE_CLIENT_SECRET. Mientras la app
//  esté en modo "borrador" ya podés usarla para conectar TU PROPIA
//  tienda (la que aparece como owner de la app) sin que Tienda Nube
//  la revise — recién si querés que la usen otros negocios además
//  del tuyo necesitás pasar su revisión.
// ══════════════════════════════════════════════════════════
const EcommerceAdapter = require('./base-adapter');

const API_BASE = 'https://api.tiendanube.com/v1';
const AUTH_BASE = 'https://www.tiendanube.com/apps';

class TiendaNubeAdapter extends EcommerceAdapter {
  // ── OAuth: paso 1, armar la URL a la que mandamos al dueño del negocio ──
  static getAuthUrl(state) {
    const clientId = process.env.TIENDANUBE_CLIENT_ID;
    return `${AUTH_BASE}/${clientId}/authorize?state=${encodeURIComponent(state)}`;
  }

  // ── OAuth: paso 2, Tienda Nube nos redirige de vuelta con un "code" ──
  static async exchangeCodeForToken(code) {
    const r = await fetch('https://www.tiendanube.com/apps/authorize/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.TIENDANUBE_CLIENT_ID,
        client_secret: process.env.TIENDANUBE_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code
      })
    });
    const data = await r.json();
    if (!r.ok || !data.access_token) {
      throw new Error(data.error_description || data.error || 'Tienda Nube rechazó la autorización.');
    }
    // data trae: access_token, user_id (= store id), scope, token_type
    return { access_token: data.access_token, store_id: String(data.user_id) };
  }

  _headers() {
    return {
      'Authentication': `bearer ${this.integracion.credenciales.access_token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Rubrex (soporte@rubrex.com)'
    };
  }

  async actualizarStock(externalId, cantidad, externalVariantId = null) {
    const storeId = this.integracion.store_identifier;
    // Tienda Nube maneja el stock a nivel de VARIANTE (todo producto
    // tiene al menos una variante, aunque no tenga talle/color).
    if (!externalVariantId) {
      // Si no guardamos la variante, buscamos la primera del producto.
      const prodR = await fetch(`${API_BASE}/${storeId}/products/${externalId}`, { headers: this._headers() });
      const prod = await prodR.json();
      externalVariantId = prod?.variants?.[0]?.id;
      if (!externalVariantId) throw new Error('No se encontró la variante del producto en Tienda Nube.');
    }
    const r = await fetch(`${API_BASE}/${storeId}/products/${externalId}/variants/${externalVariantId}`, {
      method: 'PUT',
      headers: this._headers(),
      body: JSON.stringify({ stock: cantidad })
    });
    if (!r.ok) throw new Error('Tienda Nube rechazó la actualización de stock (HTTP ' + r.status + ').');
  }

  async listarProductos() {
    const storeId = this.integracion.store_identifier;
    const r = await fetch(`${API_BASE}/${storeId}/products?per_page=200`, { headers: this._headers() });
    if (!r.ok) throw new Error('No se pudieron traer los productos de Tienda Nube.');
    const productos = await r.json();
    const out = [];
    for (const p of productos) {
      const nombre = p.name?.es || Object.values(p.name || {})[0] || 'Sin nombre';
      for (const v of (p.variants || [{ id: null, sku: p.sku }])) {
        out.push({
          external_id: String(p.id),
          external_variant_id: v.id ? String(v.id) : null,
          nombre: v.id && p.variants.length > 1 ? `${nombre} (${(v.values || []).map(x => x.es || Object.values(x)[0]).join(' / ')})` : nombre,
          sku: v.sku || p.sku || ''
        });
      }
    }
    return out;
  }

  async registrarWebhooks(callbackUrl) {
    const storeId = this.integracion.store_identifier;
    const eventos = ['order/created', 'order/paid'];
    for (const evento of eventos) {
      await fetch(`${API_BASE}/${storeId}/webhooks`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ event: evento, url: callbackUrl })
      }).catch(() => {}); // si ya existe o falla uno, seguimos con el resto
    }
    return { manual: false };
  }

  normalizarOrden(o) {
    return {
      external_order_id: String(o.id),
      fecha: o.created_at,
      cliente: {
        nombre: o.customer?.name || o.contact_name || 'Cliente de Tienda Nube',
        email: o.customer?.email || o.contact_email || null,
        telefono: o.customer?.phone || o.contact_phone || null
      },
      items: (o.products || []).map(p => ({
        external_id: String(p.product_id),
        external_variant_id: p.variant_id ? String(p.variant_id) : null,
        cantidad: p.quantity,
        precio_unitario: parseFloat(p.price),
        nombre: p.name
      })),
      total: parseFloat(o.total),
      metodo_pago: o.payment_details?.method || o.gateway || 'e-commerce',
      estado: (o.payment_status === 'paid' || o.status === 'paid') ? 'pagado' : 'pendiente'
    };
  }
}

module.exports = TiendaNubeAdapter;
