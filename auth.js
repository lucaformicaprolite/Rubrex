// ══════════════════════════════════════════════════════════
//  auth.js — Generación y verificación de tokens de sesión (JWT)
//  Necesita JWT_SECRET en el .env (cualquier string largo y random)
// ══════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');

function generarToken(cliente) {
  return jwt.sign(
    { id: cliente.id, email: cliente.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// Middleware: se usa en cualquier ruta que requiera estar logueado.
// Lee el header "Authorization: Bearer <token>", lo valida, y deja
// el id del cliente en req.clienteId para que la ruta lo use.
function autenticar(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autenticado. Falta el token.' });
  }
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.clienteId = payload.id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado. Iniciá sesión de nuevo.' });
  }
}

module.exports = { generarToken, autenticar };
