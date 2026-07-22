// ══════════════════════════════════════════════════════════
//  auth.js — Generación y verificación de tokens de sesión (JWT)
//  Necesita JWT_SECRET en el .env (cualquier string largo y random)
//
//  CAMBIOS respecto a la versión anterior:
//  - generarToken ahora acepta un `tipo` ('dueno' | 'equipo') y un `rol`
//    ('dueno' | 'cajero' | 'deposito'). Si no se los pasás, asume
//    tipo:'dueno', rol:'dueno' — así todo el código viejo que llama
//    generarToken(cliente) sigue funcionando exactamente igual.
//  - autenticar sigue dejando req.clienteId (compatibilidad con TODAS
//    tus rutas actuales), y además deja req.usuario = {clienteId, tipo, rol}
//    para las rutas nuevas que necesiten saber el rol.
// ══════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');

function generarToken(cliente, opts = {}) {
  const tipo = opts.tipo || 'dueno';
  const rol = opts.rol || 'dueno';
  return jwt.sign(
    {
      id: cliente.id,           // para el dueño: su propio id. Para equipo: el id del NEGOCIO (clienteId)
      email: cliente.email,
      tipo,
      rol
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// Middleware: se usa en cualquier ruta que requiera estar logueado.
// Lee el header "Authorization: Bearer <token>", lo valida, y deja
// el id del cliente en req.clienteId (compatibilidad con rutas viejas)
// y el detalle completo en req.usuario (para rutas nuevas con roles).
function autenticar(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autenticado. Falta el token.' });
  }
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.clienteId = payload.id;
    req.usuario = {
      clienteId: payload.id,
      email: payload.email,
      tipo: payload.tipo || 'dueno',
      rol: payload.rol || 'dueno'
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado. Iniciá sesión de nuevo.' });
  }
}

// Exige que sea el DUEÑO del negocio (no un empleado). Usalo en rutas
// sensibles: credenciales AFIP, gestión de equipo, borrado de datos, etc.
function soloDueno(req, res, next) {
  if (!req.usuario || req.usuario.tipo !== 'dueno') {
    return res.status(403).json({ error: 'Solo el dueño del negocio puede hacer esto.' });
  }
  next();
}

// Exige alguno de los roles indicados. Uso: requireRol('dueno','cajero')
function requireRol(...rolesPermitidos) {
  return (req, res, next) => {
    if (!req.usuario || !rolesPermitidos.includes(req.usuario.rol)) {
      return res.status(403).json({ error: 'Tu usuario no tiene permiso para esta acción.' });
    }
    next();
  };
}

module.exports = { generarToken, autenticar, soloDueno, requireRol };
