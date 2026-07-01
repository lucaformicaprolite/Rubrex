// ══════════════════════════════════════════════════════════
//  equipo-routes.js — El DUEÑO gestiona su equipo (empleados)
//  Montalo en server.js con:  app.use(require('./equipo-routes'));
//  Usa las mismas deps que ya tenés: express, bcrypt, db, auth.
// ══════════════════════════════════════════════════════════
const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();

const db = require('./db');
const { autenticar, soloDueno } = require('./auth');

// Genera una contraseña temporal fácil de dictar (8 caracteres, sin ambigüedades tipo 0/O)
function generarPasswordTemporal() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ── GET /api/equipo — listar el equipo del negocio logueado ──
router.get('/api/equipo', autenticar, soloDueno, async (req, res) => {
  try {
    const equipo = await db.prepare(
      'SELECT id, nombre, email, rol, activo, password_temporal, creado_en FROM equipo WHERE cliente_id = ? ORDER BY creado_en DESC'
    ).all(req.usuario.clienteId);
    res.json({ ok: true, equipo });
  } catch (err) {
    console.error('Error en GET /api/equipo:', err);
    res.status(500).json({ error: 'No se pudo obtener el equipo.' });
  }
});

// ── POST /api/equipo — agregar un miembro nuevo ──
// Body: { nombre, email, rol }
router.post('/api/equipo', autenticar, soloDueno, async (req, res) => {
  try {
    const { nombre, email, rol } = req.body;
    if (!nombre || !email || !rol) {
      return res.status(400).json({ error: 'Faltan datos (nombre, email, rol).' });
    }
    if (!['cajero', 'deposito', 'dueno'].includes(rol)) {
      return res.status(400).json({ error: 'Rol inválido.' });
    }

    const yaEnEquipo = await db.prepare('SELECT id FROM equipo WHERE email = ?').get(email);
    const yaEsCliente = await db.prepare('SELECT id FROM clientes WHERE email = ?').get(email);
    if (yaEnEquipo || yaEsCliente) {
      return res.status(400).json({ error: 'Ya existe una cuenta con ese email.' });
    }

    const passwordTemporal = generarPasswordTemporal();
    const password_hash = await bcrypt.hash(passwordTemporal, 10);

    await db.prepare(`
      INSERT INTO equipo (cliente_id, nombre, email, password_hash, rol, password_temporal)
      VALUES (?, ?, ?, ?, ?, true)
    `).run(req.usuario.clienteId, nombre, email, password_hash, rol);

    // La contraseña en texto plano se devuelve UNA sola vez, acá. No se guarda así en ningún lado.
    res.json({ ok: true, passwordTemporal });
  } catch (err) {
    console.error('Error en POST /api/equipo:', err);
    res.status(500).json({ error: 'No se pudo agregar al equipo.' });
  }
});

// ── PUT /api/equipo/:id — cambiar rol o activar/desactivar ──
// Body: { rol?, activo? }
router.put('/api/equipo/:id', autenticar, soloDueno, async (req, res) => {
  try {
    const miembro = await db.prepare('SELECT * FROM equipo WHERE id = ? AND cliente_id = ?')
      .get(req.params.id, req.usuario.clienteId);
    if (!miembro) return res.status(404).json({ error: 'No encontrado.' });

    const { rol, activo } = req.body;
    if (rol && !['cajero', 'deposito', 'dueno'].includes(rol)) {
      return res.status(400).json({ error: 'Rol inválido.' });
    }

    await db.prepare(`
      UPDATE equipo SET
        rol = ?,
        activo = ?
      WHERE id = ?
    `).run(
      rol || miembro.rol,
      activo === undefined ? miembro.activo : !!activo,
      req.params.id
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Error en PUT /api/equipo/:id:', err);
    res.status(500).json({ error: 'No se pudo actualizar.' });
  }
});

// ── DELETE /api/equipo/:id — sacar a alguien del equipo ──
router.delete('/api/equipo/:id', autenticar, soloDueno, async (req, res) => {
  try {
    const miembro = await db.prepare('SELECT id FROM equipo WHERE id = ? AND cliente_id = ?')
      .get(req.params.id, req.usuario.clienteId);
    if (!miembro) return res.status(404).json({ error: 'No encontrado.' });

    await db.prepare('DELETE FROM equipo WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error en DELETE /api/equipo/:id:', err);
    res.status(500).json({ error: 'No se pudo eliminar.' });
  }
});

// ── POST /api/equipo/:id/resetear-password ──
router.post('/api/equipo/:id/resetear-password', autenticar, soloDueno, async (req, res) => {
  try {
    const miembro = await db.prepare('SELECT id FROM equipo WHERE id = ? AND cliente_id = ?')
      .get(req.params.id, req.usuario.clienteId);
    if (!miembro) return res.status(404).json({ error: 'No encontrado.' });

    const passwordTemporal = generarPasswordTemporal();
    const password_hash = await bcrypt.hash(passwordTemporal, 10);

    await db.prepare('UPDATE equipo SET password_hash = ?, password_temporal = true WHERE id = ?')
      .run(password_hash, req.params.id);

    res.json({ ok: true, passwordTemporal });
  } catch (err) {
    console.error('Error en POST /api/equipo/:id/resetear-password:', err);
    res.status(500).json({ error: 'No se pudo resetear la contraseña.' });
  }
});

module.exports = router;
