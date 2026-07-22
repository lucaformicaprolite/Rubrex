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
const { generarToken, autenticar, soloDueno } = require('./auth');
const { encrypt, decrypt } = require('./crypto-utils');

const app = express();
// Límite subido de 100kb (default) a 6mb: la foto de perfil viaja como
// base64 dentro del JSON y un archivo de imagen de pocos MB, al pasar
// a base64, pesa ~33% más. El frontend ya limita la foto a 3MB antes
// de mandarla, así que 6mb da margen de sobra.
app.use(express.json({ limit: '6mb' }));

// 👈 nuevo: corta el acceso a la app si la cuenta no tiene el pago al
// día (trial vencido, suscripción cancelada, etc). Va ANTES que las
// demás rutas para que aplique a todas parejo.
app.use(require('./pagos-routes').bloquearSiVencido);

app.use(require('./equipo-routes')); // gestión de equipo (empleados)
app.use(require('./negocio-routes')); // productos, clientes del negocio y ventas
app.use(require('./ecommerce-routes')); // 👈 nuevo: integraciones con Tienda Nube / WooCommerce
app.use(require('./finanzas-routes')); // 👈 nuevo: cuenta corriente, gastos, caja y cheques
app.use(require('./copiloto-routes')); // 👈 nuevo: Copiloto IA (chat + acciones sobre el negocio)
app.use(require('./pagos-routes')); // suscripciones con MercadoPago

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
    // Validación de formato: sin esto, un texto random (sin @) queda
    // guardado como "email" válido en la base, y recién explota más
    // adelante al mandarlo a MercadoPago en /api/suscripcion/crear,
    // dejando cuentas fantasma a medio crear.
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Ingresá un email válido.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
    }

    // Ojo: NO alcanza con "existe o no existe". Si alguien arrancó un
    // registro antes y nunca llegó a pagar (quedó en 'pendiente',
    // 'sin_plan' o 'cancelada'), ese email no debería quedar "quemado"
    // para siempre — lo tratamos como cuenta fantasma y la reemplazamos.
    // Solo bloqueamos si la cuenta existente ya pagó o está en trial activo.
    const ESTADOS_CON_ACCESO_REAL = ['activo', 'trial_activo', 'gracia'];
    const existente = await db.prepare(
      'SELECT id, estado_suscripcion FROM clientes WHERE email = ?'
    ).get(email);
    if (existente) {
      if (ESTADOS_CON_ACCESO_REAL.includes(existente.estado_suscripcion)) {
        return res.status(400).json({ error: 'Ese email ya está registrado. ¿Querés iniciar sesión?' });
      }
      // Cuenta fantasma (nunca pagó): la borramos y dejamos que se registre de nuevo.
      await db.prepare('DELETE FROM clientes WHERE id = ?').run(existente.id);
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

    // 1) ¿Es el dueño del negocio? (como siempre)
    const cliente = await db.prepare('SELECT * FROM clientes WHERE email = ?').get(email);
    if (cliente) {
      const passwordOk = await bcrypt.compare(password, cliente.password_hash);
      if (!passwordOk) {
        return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
      }
      const token = generarToken(cliente, { tipo: 'dueno', rol: 'dueno' });
      return res.json({
        ok: true,
        token,
        cliente: { id: cliente.id, email: cliente.email, nombre: cliente.nombre },
        usuario: { nombre: cliente.nombre, rol: 'dueno', tipo: 'dueno' }
      });
    }

    // 2) Si no es el dueño, ¿es alguien del equipo?
    const miembro = await db.prepare('SELECT * FROM equipo WHERE email = ? AND activo = true').get(email);
    if (miembro) {
      const passwordOk = await bcrypt.compare(password, miembro.password_hash);
      if (!passwordOk) {
        return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
      }
      const negocio = await db.prepare('SELECT id, nombre, email FROM clientes WHERE id = ?').get(miembro.cliente_id);
      // El token lleva el id del NEGOCIO (para que todas las rutas de datos sigan
      // funcionando igual que hoy), más el tipo/rol del empleado que se logueó.
      const token = generarToken(
        { id: negocio.id, email: miembro.email },
        { tipo: 'equipo', rol: miembro.rol }
      );
      return res.json({
        ok: true,
        token,
        cliente: { id: negocio.id, email: negocio.email, nombre: negocio.nombre },
        usuario: {
          nombre: miembro.nombre,
          rol: miembro.rol,
          tipo: 'equipo',
          passwordTemporal: !!miembro.password_temporal
        }
      });
    }

    return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
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

    // Si quien está logueado es un empleado, buscamos su nombre real
    // (el del negocio, `cliente.nombre`, es distinto del nombre de la persona).
    let nombreUsuario = cliente.nombre;
    if (req.usuario.tipo === 'equipo') {
      const miembro = await db.prepare('SELECT nombre FROM equipo WHERE cliente_id = ? AND email = ?')
        .get(req.clienteId, req.usuario.email);
      if (miembro) nombreUsuario = miembro.nombre;
    }

    res.json({
      ok: true,
      cliente: {
        id: cliente.id,
        email: cliente.email,
        nombre: cliente.nombre,
        afipConfigurado: !!(cliente.afip_cuit && cliente.afip_cert && cliente.afip_key),
        afip_cuit: cliente.afip_cuit || null,
        afip_punto_venta: cliente.afip_punto_venta || 1,
        afip_production: !!cliente.afip_production,
        plan: cliente.plan || 'sin_plan',
        estado_suscripcion: cliente.estado_suscripcion || 'sin_plan',
        trial_fin: cliente.trial_fin || null
      },
      usuario: {
        nombre: nombreUsuario,
        rol: req.usuario.rol,
        tipo: req.usuario.tipo
      }
    });
  } catch (err) {
    console.error('Error en /api/me:', err);
    res.status(500).json({ error: 'No se pudo consultar el estado del cliente.' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/perfil   (requiere estar logueado)
//  Devuelve el nombre para mostrar, la foto de perfil y el
//  nombre del negocio del cliente logueado.
// ══════════════════════════════════════════════════════════
app.get('/api/perfil', autenticar, async (req, res) => {
  try {
    const cliente = await db.prepare('SELECT email, nombre, nombre_display, avatar, telefono, ubicacion FROM clientes WHERE id = ?').get(req.clienteId);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });

    res.json({
      ok: true,
      perfil: {
        email: cliente.email,
        nombreDisplay: cliente.nombre_display || null,
        nombreNegocio: cliente.nombre || null,
        avatar: cliente.avatar || null,
        telefono: cliente.telefono || null,
        ubicacion: cliente.ubicacion || null
      }
    });
  } catch (err) {
    console.error('Error en /api/perfil (GET):', err);
    res.status(500).json({ error: 'No se pudo obtener el perfil.' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/perfil   (requiere estar logueado)
//  Body: { nombreDisplay, nombreNegocio, avatar, telefono, ubicacion }
//  - Cualquier campo que NO venga en el body, no se toca.
//  - avatar: string base64 (data URL) para actualizarla, o null para
//    quitar la foto.
//
//  NOTA: si quien está logueado es un empleado (tipo "equipo"), el token
//  igual lleva el id DEL NEGOCIO (ver /api/login), así que esto actualiza
//  la fila del dueño — hoy el perfil (nombre/foto/tel/ubicación) es uno
//  solo por negocio, no por empleado. Si más adelante se quiere un perfil
//  por persona del equipo, hay que sumar estas columnas a la tabla
//  "equipo" también.
// ══════════════════════════════════════════════════════════
app.post('/api/perfil', autenticar, async (req, res) => {
  try {
    const { nombreDisplay, nombreNegocio, avatar, telefono, ubicacion } = req.body;

    const campos = [];
    const valores = [];
    if (nombreDisplay !== undefined) { campos.push('nombre_display = ?'); valores.push(nombreDisplay || null); }
    if (nombreNegocio !== undefined) { campos.push('nombre = ?'); valores.push(nombreNegocio || null); }
    if (avatar !== undefined) { campos.push('avatar = ?'); valores.push(avatar || null); }
    if (telefono !== undefined) { campos.push('telefono = ?'); valores.push(telefono || null); }
    if (ubicacion !== undefined) { campos.push('ubicacion = ?'); valores.push(ubicacion || null); }

    if (!campos.length) {
      return res.status(400).json({ error: 'Nada para actualizar.' });
    }

    valores.push(req.clienteId);
    await db.prepare(`UPDATE clientes SET ${campos.join(', ')} WHERE id = ?`).run(...valores);

    res.json({ ok: true });
  } catch (err) {
    console.error('Error en /api/perfil (POST):', err);
    res.status(500).json({ error: 'No se pudo actualizar el perfil.' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/perfil/password   (requiere estar logueado)
//  Body: { passwordActual, passwordNueva }
//  Cambia la contraseña de la cuenta (la del DUEÑO — un empleado del
//  equipo tiene su propia contraseña en la tabla "equipo", que se
//  cambia desde la pantalla "Equipo y roles", no desde acá).
// ══════════════════════════════════════════════════════════
app.post('/api/perfil/password', autenticar, async (req, res) => {
  try {
    if (req.usuario.tipo === 'equipo') {
      return res.status(403).json({ error: 'Tu contraseña la administra el dueño del negocio desde "Equipo y roles".' });
    }

    const { passwordActual, passwordNueva } = req.body;
    if (!passwordActual || !passwordNueva) {
      return res.status(400).json({ error: 'Faltan datos.' });
    }
    if (passwordNueva.length < 8) {
      return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 8 caracteres.' });
    }

    const cliente = await db.prepare('SELECT password_hash FROM clientes WHERE id = ?').get(req.clienteId);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });

    const passwordOk = await bcrypt.compare(passwordActual, cliente.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ error: 'La contraseña actual no es correcta.' });
    }

    const nuevoHash = await bcrypt.hash(passwordNueva, 10);
    await db.prepare('UPDATE clientes SET password_hash = ? WHERE id = ?').run(nuevoHash, req.clienteId);

    res.json({ ok: true });
  } catch (err) {
    console.error('Error en /api/perfil/password:', err);
    res.status(500).json({ error: 'No se pudo cambiar la contraseña.' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/afip-generar-csr   (requiere estar logueado)
//  Body: { afip_cuit, organizacion }
//  Genera una clave privada + un CSR nuevos en el servidor.
//  Guarda la clave (encriptada) en la base de datos y devuelve
//  el CSR para que el cliente lo suba a AFIP.
// ══════════════════════════════════════════════════════════
app.post('/api/afip-generar-csr', autenticar, soloDueno, async (req, res) => {
  const tmpId = crypto.randomBytes(8).toString('hex');
  const keyPath = path.join(os.tmpdir(), `rubrex_${tmpId}.key`);
  const csrPath = path.join(os.tmpdir(), `rubrex_${tmpId}.csr`);

  try {
    let { afip_cuit, organizacion } = req.body;
    if (!afip_cuit) {
      return res.status(400).json({ error: 'Falta el CUIT.' });
    }
    // Limpiamos el CUIT por si lo pegaron con guiones o espacios (ej: "20-12345678-9")
    afip_cuit = String(afip_cuit).replace(/\D/g, '');

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
app.post('/api/afip-credenciales', autenticar, soloDueno, async (req, res) => {
  try {
    let { afip_cuit, afip_cert, afip_key, afip_punto_venta, afip_production } = req.body;

    // Limpiamos el CUIT por si lo pegaron con guiones o espacios (ej: "20-12345678-9")
    if (afip_cuit) afip_cuit = String(afip_cuit).replace(/\D/g, '');

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
//  Body: { email }
//
//  ANTES: el código lo generaba el navegador y este endpoint solo lo
//  mandaba por mail, sin guardar nada — no había forma de verificarlo
//  después, y el "cambio de contraseña" quedaba solo en localStorage
//  del navegador (nunca tocaba la contraseña real en Postgres).
//
//  AHORA: el código lo genera y valida el SERVIDOR. Se guarda hasheado
//  (bcrypt) en password_resets con 15 minutos de expiración. La
//  respuesta es siempre { ok:true } exista o no el email, para no
//  revelar qué emails están registrados (previene enumeración de
//  cuentas) — si no existe, simplemente no se manda ningún mail.
// ══════════════════════════════════════════════════════════
app.post('/api/send-reset', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Falta el email.' });
    }

    // ¿A quién pertenece ese email? Dueño o miembro del equipo (igual que /api/login).
    const cliente = await db.prepare('SELECT id FROM clientes WHERE email = ?').get(email);
    let tipo = null;
    if (cliente) {
      tipo = 'dueno';
    } else {
      const miembro = await db.prepare('SELECT id FROM equipo WHERE email = ? AND activo = true').get(email);
      if (miembro) tipo = 'equipo';
    }

    // Mensaje genérico siempre, exista o no la cuenta.
    const respuestaGenerica = { ok: true, mensaje: 'Si ese email está registrado, te enviamos un código.' };
    if (!tipo) {
      return res.json(respuestaGenerica);
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = await bcrypt.hash(code, 10);
    const expira = new Date(Date.now() + 15 * 60 * 1000);

    await db.prepare(`
      INSERT INTO password_resets (email, code_hash, tipo, intentos, expira)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT (email) DO UPDATE SET code_hash = ?, tipo = ?, intentos = 0, expira = ?
    `).run(email, codeHash, tipo, expira, codeHash, tipo, expira);

    const { error } = await resend.emails.send({
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

    if (error) {
      console.error('Resend rechazó el envío en /api/send-reset:', error);
      return res.status(500).json({ error: 'No se pudo enviar el email.', detalle: error.message || error });
    }

    res.json(respuestaGenerica);
  } catch (err) {
    console.error('Error en /api/send-reset:', err);
    res.status(500).json({ error: 'No se pudo enviar el email.', detalle: err.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/verificar-reset
//  Body: { email, code, passwordNueva }
//  Verifica el código contra el guardado en password_resets y, si es
//  válido, actualiza la contraseña REAL en la tabla que corresponda
//  (clientes o equipo). Esto es lo que faltaba: antes nada llamaba a
//  este paso, el navegador solo escribía en su propio localStorage.
// ══════════════════════════════════════════════════════════
app.post('/api/verificar-reset', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const { code, passwordNueva } = req.body;
    if (!email || !code || !passwordNueva) {
      return res.status(400).json({ error: 'Faltan datos.' });
    }
    if (passwordNueva.length < 8) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
    }

    const reset = await db.prepare('SELECT * FROM password_resets WHERE email = ?').get(email);
    if (!reset) {
      return res.status(400).json({ error: 'Pedí un código nuevo, no hay ninguno pendiente para ese email.' });
    }
    if (new Date(reset.expira).getTime() < Date.now()) {
      await db.prepare('DELETE FROM password_resets WHERE email = ?').run(email);
      return res.status(400).json({ error: 'El código expiró. Pedí uno nuevo.' });
    }
    if (reset.intentos >= 5) {
      await db.prepare('DELETE FROM password_resets WHERE email = ?').run(email);
      return res.status(400).json({ error: 'Demasiados intentos fallidos. Pedí un código nuevo.' });
    }

    const codeOk = await bcrypt.compare(String(code), reset.code_hash);
    if (!codeOk) {
      await db.prepare('UPDATE password_resets SET intentos = intentos + 1 WHERE email = ?').run(email);
      return res.status(400).json({ error: 'El código es incorrecto.' });
    }

    const nuevoHash = await bcrypt.hash(passwordNueva, 10);
    if (reset.tipo === 'dueno') {
      await db.prepare('UPDATE clientes SET password_hash = ? WHERE email = ?').run(nuevoHash, email);
    } else {
      await db.prepare('UPDATE equipo SET password_hash = ?, password_temporal = false WHERE email = ?').run(nuevoHash, email);
    }

    await db.prepare('DELETE FROM password_resets WHERE email = ?').run(email);
    res.json({ ok: true, mensaje: 'Contraseña actualizada. Ya podés iniciar sesión con la nueva.' });
  } catch (err) {
    console.error('Error en /api/verificar-reset:', err);
    res.status(500).json({ error: 'No se pudo restablecer la contraseña.' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/contacto
//  Body: { nombre, email, telefono, mensaje }
//  Formulario de contacto de la landing → manda el mail a tu casilla
// ══════════════════════════════════════════════════════════
app.post('/api/contacto', async (req, res) => {
  try {
    const { nombre, email, telefono, mensaje } = req.body;
    if (!nombre || !email || !mensaje) {
      return res.status(400).json({ error: 'Faltan datos (nombre, email o mensaje).' });
    }

    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: 'rubrexinfo@gmail.com',
      replyTo: email,
      subject: `Nueva consulta de ${nombre} — Rubrex`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
          <h2 style="color:#C0392B">Nueva consulta desde la web</h2>
          <p><b>Nombre:</b> ${nombre}</p>
          <p><b>Email:</b> ${email}</p>
          <p><b>Teléfono:</b> ${telefono || '-'}</p>
          <p><b>Mensaje:</b></p>
          <p style="white-space:pre-wrap">${mensaje}</p>
        </div>
      `
    });

    if (error) {
      console.error('Resend rechazó el envío en /api/contacto:', error);
      return res.status(500).json({ error: 'No se pudo enviar la consulta.', detalle: error.message || error });
    }

    console.log('Consulta enviada, id de Resend:', data?.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error en /api/contacto:', err);
    res.status(500).json({ error: 'No se pudo enviar la consulta.', detalle: err.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/facturar   (requiere estar logueado)
//  Body: { total, tipoFactura }
//  Usa las credenciales AFIP DEL CLIENTE LOGUEADO, no un CUIT global.
// ══════════════════════════════════════════════════════════
app.post('/api/facturar', autenticar, async (req, res) => {
  if (!['dueno', 'cajero'].includes(req.usuario.rol)) {
    return res.status(403).json({ ok: false, error: 'Tu usuario no tiene permiso para facturar.' });
  }
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

    // Limpiamos el CUIT por si quedó guardado con guiones o espacios
    // (ej: "20-12345678-9"), porque AfipSDK exige solo los 11 dígitos.
    const cuitLimpio = String(cliente.afip_cuit).replace(/\D/g, '');

    const afip = new Afip({
      CUIT: Number(cuitLimpio),
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
// ══════════════════════════════════════════════════════════
//  RUTA TEMPORAL — solo para marcar TU cuenta como exenta de pago,
//  ya que el plan Free de Render no te da acceso a la Shell.
//  Usala UNA VEZ desde el navegador y después borrá este bloque
//  (o al menos cambiá ADMIN_SECRET) para no dejarla dando vueltas.
// ══════════════════════════════════════════════════════════
app.get('/api/admin/exento-pago', async (req, res) => {
  if (!process.env.ADMIN_SECRET || req.query.clave !== process.env.ADMIN_SECRET) {
    return res.status(403).send('Clave incorrecta.');
  }
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).send('Falta el email. Usá ?email=tu@email.com&clave=...');

  try {
    const r = await db.prepare('UPDATE clientes SET exento_pago = true WHERE email = ?').run(email);
    res.send(`Listo. Filas modificadas: ${r.changes}`);
  } catch (err) {
    console.error('Error en /api/admin/exento-pago:', err);
    res.status(500).send('Error: ' + err.message);
  }
});

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
