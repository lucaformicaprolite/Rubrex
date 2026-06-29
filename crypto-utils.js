// ══════════════════════════════════════════════════════════
//  crypto-utils.js — Encripta/desencripta el certificado y la
//  clave privada de AFIP de cada cliente antes de guardarlos
//  en la base de datos.
//
//  Necesita una ENCRYPTION_KEY en el .env (32 bytes en hex).
//  Generala una sola vez con:
//    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//  y pegala en tu .env. NUNCA la compartas ni la subas a git.
// ══════════════════════════════════════════════════════════
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error(
      'Falta o está mal formada ENCRYPTION_KEY en el .env. Generala con: ' +
      `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  return Buffer.from(key, 'hex');
}

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Todo junto en un solo string: iv:authTag:datos (todo en hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(stored) {
  if (!stored) return null;
  const [ivHex, authTagHex, dataHex] = stored.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
