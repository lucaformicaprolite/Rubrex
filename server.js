// ══════════════════════════════════════════════════════════
//  RUBREX — server.js
//  Server Express que:
//   1) Sirve el front-end (index.html)
//   2) Expone /api/registro    → alta de un cliente nuevo
//   3) Expone /api/login       → login, devuelve un token
//   4) Expone /api/afip-credenciales → el cliente guarda su cert/key de AFIP
//   5) Expone /api/send-reset  → manda el mail de recuperación (Resend)
//   6) Expone /api/facturar    → pide el CAE a AFIP usando LAS
//      CREDENCIALES DEL CLIENTE LOGUEADO (no un CUIT global fijo)
// ══════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { execSync } = require('child_process');
const { Resend } = require('resend');
const Afip = require('@afipsdk/afip.js');

const db = require('./db');
const { generarToken, autenticar } = require('./auth');
const { encrypt, decrypt } = require('./crypto-utils');

const app = express();
app.use(express.json());

// Sirve index.html y cualquier otro archivo estático (css, imágenes, etc.)
app.use(express.static(__dirname));

// ── Config Resend (email) ────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);
const EMAIL_FROM = process.env.EMAIL_FROM || 'Rubrex <onboarding@resend.dev>';

// Mapeo de tipo de factura → código de comprobante AFIP
// 1 = Factura A | 6 = Factura B | 11 = Factura C
const TIPO_COMPROBANTE = { A: 1, B: 6, C: 11 };

// ══════════════════════════════════════════════════════════
//  POST /api/registro
//  Body: { email, password, nombre, afip_cuit, afip_punto_venta }
//  Crea un cliente nuevo. Las credenciales AFIP se pueden mandar
//  acá o cargarlas después con /api/afip-credenciales.
// ══════════════════════════════════════════════════════════
app.post('/api/registro', async (req, res) => {
  try {
    const { email, password, nombre, afip_cuit, afip_punto_venta } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Faltan email o password.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
    }

    const existente = await db.prepare('SELECT id FROM clientes WHERE email = ?').get(email);
    if (existente) {
      return res.status(400).json({ error: 'Ese email ya está registrado.' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const info = await db.prepare(`
      INSERT INTO clientes (email, password_hash, nombre, afip_cuit, afip_punto_venta)
      VALUES (?, ?, ?, ?, ?)
    `).run(email, password_hash, nombre || null, afip_cuit || null, afip_punto_venta || 1);

    const token = generarToken({ id: info.lastInsertRowid, email });
    res.json({ ok: true, token, cliente: { id: info.lastInsertRowid, email, nombre: nombre || null } });
  } catch (err) {
    console.error('Error en /api/registro:', err);
    res.status(500).json({ error: 'No se pudo registrar.' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/login
//  Body: { email, password }
// ══════════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Faltan email o password.' });
    }

    const cliente = await db.prepare('SELECT * FROM clientes WHERE email = ?').get(email);
    if (!cliente) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
    }

    const passwordOk = await bcrypt.compare(password, cliente.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
    }

    const token = generarToken(cliente);
    res.json({
      ok: true,
      token,
      cliente: { id: cliente.id, email: cliente.email, nombre: cliente.nombre }
    });
  } catch (err) {
    console.error('Error en /api/login:', err);
    res.status(500).json({ error: 'No se pudo iniciar sesión.' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/me   (requiere estar logueado)
//  Devuelve los datos del cliente logueado, y si ya cargó o no
//  sus credenciales de AFIP (sin exponer el certificado/clave).
// ══════════════════════════════════════════════════════════
app.get('/api/me', autenticar, async (req, res) => {
  try {
    const cliente = await db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.clienteId);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });

    res.json({
      ok: true,
      cliente: {
        id: cliente.id,
        email: cliente.email,
        nombre: cliente.nombre,
        afipConfigurado: !!(cliente.afip_cuit && cliente.afip_cert && cliente.afip_key),
        afip_cuit: cliente.afip_cuit || null,
        afip_punto_venta: cliente.afip_punto_venta || 1,
        afip_production: !!cliente.afip_production
      }
    });
  } catch (err) {
    console.error('Error en /api/me:', err);
    res.status(500).json({ error: 'No se pudo consultar el estado del cliente.' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/afip-generar-csr   (requiere estar logueado)
//  Body: { afip_cuit, organizacion }
//  Genera una clave privada + un CSR nuevos en el servidor.
//  Guarda la clave (encriptada) en la base de datos y devuelve
//  el CSR para que el cliente lo suba a AFIP.
// ══════════════════════════════════════════════════════════
app.post('/api/afip-generar-csr', autenticar, async (req, res) => {
  const tmpId = crypto.randomBytes(8).toString('hex');
  const keyPath = path.join(os.tmpdir(), `rubrex_${tmpId}.key`);
  const csrPath = path.join(os.tmpdir(), `rubrex_${tmpId}.csr`);

  try {
    const { afip_cuit, organizacion } = req.body;
    if (!afip_cuit) {
      return res.status(400).json({ error: 'Falta el CUIT.' });
    }

    // Limpiamos el nombre para que sea válido dentro del CSR (sin espacios ni símbolos raros)
    const orgLimpia = (organizacion || 'Cliente').replace(/[^a-zA-Z0-9]/g, '') || 'Cliente';

    // 1) Generar la clave privada y el CSR usando archivos temporales
    //    (algunos entornos, como Render, no soportan leer claves desde /dev/stdin)
    execSync(`openssl genrsa -out "${keyPath}" 2048`);
    execSync(`openssl req -new -key "${keyPath}" -subj "/CN=Rubrex${orgLimpia}/O=${orgLimpia}/C=AR" -out "${csrPath}"`);

    const keyPem = fs.readFileSync(keyPath, 'utf8');
    const csrPem = fs.readFileSync(csrPath, 'utf8');

    // 2) Guardamos la clave ENCRIPTADA en la base de datos.
    //    El certificado (afip_cert) queda vacío hasta que el cliente
    //    suba el .crt que le va a dar AFIP.
    await db.prepare(`
      UPDATE clientes SET afip_cuit = ?, afip_key = ?, afip_cert = NULL
      WHERE id = ?
    `).run(afip_cuit, encrypt(keyPem), req.clienteId);

    res.json({ ok: true, csr: csrPem });
  } catch (err) {
    console.error('Error en /api/afip-generar-csr:', err);
    res.status(500).json({ error: 'No se pudo generar el certificado.', detalle: err.message });
  } finally {
    // Borramos los archivos temporales siempre, haya salido bien o mal
    try { fs.unlinkSync(keyPath); } catch (e) {}
    try { fs.unlinkSync(csrPath); } catch (e) {}
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/afip-credenciales   (requiere estar logueado)
//  Body: { afip_cuit, afip_cert, afip_key, afip_punto_venta, afip_production }
//  El cliente carga (o actualiza) su certificado y clave de AFIP.
//  Se guardan ENCRIPTADOS en la base de datos.
// ══════════════════════════════════════════════════════════
app.post('/api/afip-credenciales', autenticar, async (req, res) => {
  try {
    const { afip_cuit, afip_cert, afip_key, afip_punto_venta, afip_production } = req.body;

    if (!afip_cuit || !afip_cert) {
      return res.status(400).json({ error: 'Faltan afip_cuit o afip_cert.' });
    }

    // Si no mandan una clave nueva, usamos la que ya estaba guardada
    // (por ejemplo, la que generó "Generar certificado" antes).
    let keyAGuardar;
    if (afip_key) {
      keyAGuardar = encrypt(afip_key);
    } else {
      const actual = await db.prepare('SELECT afip_key FROM clientes WHERE id = ?').get(req.clienteId);
      keyAGuardar = actual ? actual.afip_key : null;
    }

    if (!keyAGuardar) {
      return res.status(400).json({
        error: 'No hay una clave privada guardada. Generá el certificado primero con el botón "Generar certificado", o pegá tu clave manualmente.'
      });
    }

    await db.prepare(`
      UPDATE clientes SET
        afip_cuit = ?,
        afip_cert = ?,
        afip_key = ?,
        afip_punto_venta = ?,
        afip_production = ?
      WHERE id = ?
    `).run(
      afip_cuit,
      encrypt(afip_cert),
      keyAGuardar,
      afip_punto_venta || 1,
      afip_production ? 1 : 0,
      req.clienteId
    );

    res.json({ ok: true, mensaje: 'Credenciales de AFIP guardadas correctamente.' });
  } catch (err) {
    console.error('Error en /api/afip-credenciales:', err);
    res.status(500).json({ error: 'No se pudieron guardar las credenciales.' });
  }
});

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
//  POST /api/facturar   (requiere estar logueado)
//  Body: { total, tipoFactura }
//  Usa las credenciales AFIP DEL CLIENTE LOGUEADO, no un CUIT global.
// ══════════════════════════════════════════════════════════
app.post('/api/facturar', autenticar, async (req, res) => {
  try {
    const cliente = await db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.clienteId);

    if (!cliente || !cliente.afip_cuit || !cliente.afip_cert || !cliente.afip_key) {
      return res.status(400).json({
        ok: false,
        error: 'Este cliente todavía no cargó sus credenciales de AFIP. Usá /api/afip-credenciales primero.'
      });
    }

    // Se crea una instancia de Afip POR REQUEST, con las credenciales
    // de ESTE cliente (desencriptadas al vuelo, nunca quedan en texto
    // plano en memoria más tiempo del necesario).
    // NOTA: access_token es el token de AfipSDK (https://app.afipsdk.com/),
    // NO es el certificado/clave de AFIP. Es obligatorio para producción.
    if (!process.env.AFIPSDK_ACCESS_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: 'Falta configurar AFIPSDK_ACCESS_TOKEN en las variables de entorno del servidor. Generalo en https://app.afipsdk.com/'
      });
    }

    const afip = new Afip({
      CUIT: Number(cliente.afip_cuit),
      cert: decrypt(cliente.afip_cert),
      key: decrypt(cliente.afip_key),
      production: !!cliente.afip_production,
      access_token: process.env.AFIPSDK_ACCESS_TOKEN
    });

    const { total, tipoFactura = 'B' } = req.body;
    const puntoVenta = cliente.afip_punto_venta || 1;

    if (!total || total <= 0) {
      return res.status(400).json({ ok: false, error: 'Total inválido.' });
    }

    const cbteTipo = TIPO_COMPROBANTE[tipoFactura] || TIPO_COMPROBANTE.B;

    // 1) Averiguar el próximo número de comprobante
    const ultimoNro = await afip.ElectronicBilling.getLastVoucher(puntoVenta, cbteTipo);
    const proximoNro = ultimoNro + 1;

    // 2) Armar la fecha en formato AAAAMMDD que pide AFIP
    const hoy = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      .toISOString().split('T')[0];
    const fechaAfip = parseInt(hoy.replace(/-/g, ''));

    // 3) Calcular importes
    // NOTA: para Factura B/C a consumidor final, lo habitual es NO discriminar
    // IVA (el importe ya lo incluye). Revisá esto con tu contador/condición de
    // IVA — si tu caso necesita discriminar, agregá el array "Iva" abajo.
    const totalRedondeado = Math.round(total * 100) / 100;

    const data = {
      CantReg: 1,
      PtoVta: puntoVenta,
      CbteTipo: cbteTipo,
      Concepto: 1,             // 1 = Productos
      DocTipo: 99,              // 99 = Consumidor Final (sin CUIT/DNI)
      DocNro: 0,
      CbteDesde: proximoNro,
      CbteHasta: proximoNro,
      CbteFch: fechaAfip,
      ImpTotal: totalRedondeado,
      ImpTotConc: 0,
      ImpNeto: totalRedondeado, // sin discriminar IVA
      ImpOpEx: 0,
      ImpIVA: 0,
      ImpTrib: 0,
      MonId: 'PES',
      MonCotiz: 1
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

// Primero nos asegursamos de que la tabla exista en Postgres, y recién
// ahí levantamos el servidor (si la base falla, el server no arranca
// a medias sin tabla — mejor que falle rápido y se vea en los logs).
db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✓ Rubrex corriendo en http://localhost:${PORT}`);
      console.log('✓ Conectado a Postgres y tabla "clientes" verificada.');
    });
  })
  .catch((err) => {
    console.error('✗ No se pudo inicializar la base de datos Postgres:', err);
    process.exit(1);
  });
