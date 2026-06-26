# Rubrex — cómo correrlo

## 1. Instalar dependencias
```
npm install
```

## 2. Configurar variables de entorno
Copiá `.env.example` a `.env` y completá al menos `RESEND_API_KEY`
(gratis en resend.com). Para AFIP podés arrancar sin nada — el server
usa el modo de prueba de AfipSDK por default.

```
cp .env.example .env
```

## 3. Arrancar el servidor
```
npm start
```

Abrí `http://localhost:3000` — ahí ya tenés la app completa (front +
backend) funcionando en tu máquina.

## 4. Cuando quieras subirlo a internet
Subí esta carpeta (con `server.js`, `package.json`, `index.html`) a un
hosting que corra Node, por ejemplo Render.com:

1. Creá una cuenta en render.com
2. "New Web Service" → conectá tu repo de GitHub (o subí el .zip)
3. Build command: `npm install`
4. Start command: `npm start`
5. En la sección "Environment" pegá las mismas variables que tenés en tu `.env`
6. Deploy — te da una URL pública del tipo `rubrex.onrender.com`

## Nota sobre AFIP
Mientras no tengas tu certificado digital propio, el server usa el
modo de desarrollo de AfipSDK (CUIT de prueba 20409378472), así que
las facturas que generes ahí son de prueba, no válidas fiscalmente.
Cuando tengas tu certificado real, completá `AFIP_CUIT`, `AFIP_CERT`,
`AFIP_KEY` y poné `AFIP_PRODUCTION=true` en el `.env`.
