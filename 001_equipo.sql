-- Migración: login individual para el equipo (empleados) de cada negocio.
-- Es Postgres (igual que tu tabla `clientes`), no SQLite.
-- Corré esto UNA sola vez contra tu base de Render.

CREATE TABLE IF NOT EXISTS equipo (
  id                 SERIAL PRIMARY KEY,
  cliente_id         INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  nombre             TEXT NOT NULL,
  email              TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,
  rol                TEXT NOT NULL CHECK (rol IN ('dueno','cajero','deposito')),
  activo             BOOLEAN NOT NULL DEFAULT true,
  password_temporal  BOOLEAN NOT NULL DEFAULT true,
  creado_en          TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_equipo_cliente ON equipo(cliente_id);
CREATE INDEX IF NOT EXISTS idx_equipo_email ON equipo(email);

-- Opcional pero recomendado: agregá esto mismo dentro de tu función
-- db.init() en db.js, junto a donde ya creás la tabla `clientes`, así
-- se crea sola en cualquier entorno nuevo (igual que el resto de tus tablas).
