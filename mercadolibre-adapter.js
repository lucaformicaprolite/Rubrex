// ══════════════════════════════════════════════════════════
//  mercadolibre-adapter.js
//
//  Dos particularidades de Mercado Libre frente a Tienda Nube/WooCommerce:
//
//  1) El access_token dura solo 6 horas. Hay que refrescarlo con el
//     refresh_token antes de que expire — este adapter lo hace solo
//     (ver _asegurarTokenVigente) y persiste el token nuevo en la base.
//
//  2) Las notificaciones NO traen los datos de la orden, solo avisan
//     "cambió /orders/123" — hay que ir a buscarla con otro request.
//     Por eso este adapter sobreescribe obtenerOrdenNormalizada()
//     en vez de solo normalizarOrden().
//
//  Requiere una app registrada en https://developers.mercadolibre.com.ar
//  (client_id / client_secret) y que el "callback URL" configurado ahí
//  coincida EXACTO con APP_BASE_URL + /integraciones/mercadolibre/callback.
// ══════════════════════════════════════════════════════════
const EcommerceAdapter = require('./base-adapter');
const db = require('../db');
const { encrypt } = require('../crypto-utils');

const API_BASE = 'https://api.mercadolibre.com';

function redirectUri() {
  return (process.env.APP_BASE_URL || '') + '/integraciones/mercadolibre/callback';
}

class MercadoLibreAdapter extends EcommerceAdapter {
  static getAuthUrl(state) {
    const clientId = process.env.MERCADOLIBRE_CLIENT_ID;
    return `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri())}&state=${encodeURIComponent(state)}`;
  }

  static async exchangeCodeForToken(code) {
    const r = await fetch(`${API_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.MERCADOLIBRE_CLIENT_ID,
        client_secret: process.env.MERCADOLIBRE_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri()
      })
    });
    const data = await r.json();
    if (!r.ok || !data.access_token) {
      throw new Error(data.message || 'Mercado Libre rechazó la autorización.');
    }
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      user_id: String(data.user_id),
      expires_at: Date.now() + data.expires_in * 1000 - 60000 // 1 min de margen
    };
  }

  async _asegurarTokenVigente() {
    const cred = this.integracion.credenciales;
    if (cred.expires_at && Date.now() < cred.expires_at) return;

    const r = await fetch(`${API_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.MERCADOLIBRE_CLIENT_ID,
        client_secret: process.env.MERCADOLIBRE_CLIENT_SECRET,
        refresh_token: cred.refresh_token
      })
    });
    const data = await r.json();
    if (!r.ok || !data.access_token) {
      throw new Error('No se pudo renovar el token de Mercado Libre. Reconectá la cuenta desde Integraciones.');
    }
    const nuevasCred = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || cred.refresh_token,
      user_id: cred.user_id,
      expires_at: Date.now() + data.expires_in * 1000 - 60000
    };
    this.integracion.credenciales = nuevasCred;
    // Guardamos el token renovado para no tener que pedirlo de nuevo la próxima vez.
    await db.prepare('UPDATE integraciones_ecommerce SET credenciales_enc = ? WHERE id = ?')
      .run(encrypt(JSON.stringify(nuevasCred)), this.integracion.id);
  }

  _headers() {
    return { Authorization: `Bearer ${this.integracion.credenciales.access_token}`, 'Content-Type': 'application/json' };
  }

  async actualizarStock(externalId, cantidad, externalVariantId = null) {
    await this._asegurarTokenVigente();
    const body = externalVariantId
      ? { variations: [{ id: parseInt(externalVariantId), available_quantity: cantidad }] }
      : { available_quantity: cantidad };
    const r = await fetch(`${API_BASE}/items/${externalId}`, {
      method: 'PUT', headers: this._headers(), body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('Mercado Libre rechazó la actualización de stock (HTTP ' + r.status + ').');
  }

  async listarProductos() {
    await this._asegurarTokenVigente();
    const userId = this.integracion.credenciales.user_id;
    const out = [];
    let offset = 0;
    while (true) {
      const r = await fetch(`${API_BASE}/users/${userId}/items/search?limit=100&offset=${offset}`, { headers: this._headers() });
      if (!r.ok) throw new Error('No se pudieron traer las publicaciones de Mercado Libre.');
      const data = await r.json();
      const ids = data.results || [];
      if (!ids.length) break;

      const detalleR = await fetch(`${API_BASE}/items?ids=${ids.join(',')}`, { headers: this._headers() });
      const detalle = await detalleR.json();
      detalle.forEach(entry => {
        const it = entry.body;
        if (!it) return;
        if (it.variations && it.variations.length) {
          it.variations.forEach(v => out.push({
            external_id: String(it.id),
            external_variant_id: String(v.id),
            nombre: `${it.title} (${(v.attribute_combinations || []).map(a => a.value_name).join(' / ')})`,
            sku: v.seller_custom_field || ''
          }));
        } else {
          out.push({ external_id: String(it.id), external_variant_id: null, nombre: it.title, sku: it.seller_custom_field || '' });
        }
      });
      offset += 100;
      if (ids.length < 100) break;
    }
    return out;
  }

  async registrarWebhooks() {
    // Mercado Libre NO permite registrar el webhook por API — se configura
    // UNA sola vez a nivel de toda la app en developers.mercadolibre.com.ar
    // → tu app → "Notificaciones" → tópico "orders_v2", apuntando a:
    //   https://tu-dominio.com/webhooks/mercadolibre/:negocio_id
    // (esa misma URL sirve para todos los negocios que conecten ML —
    // el :negocio_id va en la ruta según quién esté conectando).
    return { manual: true };
  }

  // Mercado Libre solo avisa "cambió /orders/123" — hay que ir a buscarla.
  async obtenerOrdenNormalizada(payload) {
    if (payload.topic !== 'orders_v2' && payload.topic !== 'orders') return null;
    await this._asegurarTokenVigente();
    const r = await fetch(`${API_BASE}${payload.resource}`, { headers: this._headers() });
    if (!r.ok) throw new Error('No se pudo obtener el detalle de la orden desde Mercado Libre.');
    const orden = await r.json();
    return this.normalizarOrden(orden);
  }

  normalizarOrden(o) {
    return {
      external_order_id: String(o.id),
      fecha: o.date_created,
      cliente: {
        nombre: `${o.buyer?.first_name || ''} ${o.buyer?.last_name || ''}`.trim() || 'Comprador de Mercado Libre',
        email: null,   // ML no comparte el email real del comprador
        telefono: null
      },
      items: (o.order_items || []).map(oi => ({
        external_id: String(oi.item.id),
        external_variant_id: oi.item.variation_id ? String(oi.item.variation_id) : null,
        cantidad: oi.quantity,
        precio_unitario: oi.unit_price,
        nombre: oi.item.title
      })),
      total: o.total_amount,
      metodo_pago: 'Mercado Pago',
      estado: (o.status === 'paid' || o.status === 'confirmed') ? 'pagado' : 'pendiente'
    };
  }
}

module.exports = MercadoLibreAdapter;
