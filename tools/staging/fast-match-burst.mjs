#!/usr/bin/env node
// Ráfaga de solicitudes FAST_MATCH contra staging para la auditoría de ackDeltaMs (pruebas C/D).
// Crea un cliente de pruebas (OTP fijo de staging) y publica N solicitudes cerca de un punto;
// cada una dispara geo:job_alert hacia los proveedores conectados a /offers.
//
// Uso: node tools/staging/fast-match-burst.mjs <lat> <lng> [n=20] [intervaloSeg=10]
// Solo staging: el OTP 123456 está desactivado en producción.

const API = process.env.CHAPUS_API_URL ?? 'https://chapus-api-staging.onrender.com/v1';
const CLIENT_PHONE = process.env.CHAPUS_TEST_CLIENT_PHONE ?? '+34600000902';
// De aquí sale la approximateZone que verá el proveedor; conviene que cuadre con el punto.
const ADDRESS = process.env.CHAPUS_TEST_ADDRESS ?? 'Calle de Prueba 1, 28013 Madrid';

const [lat, lng] = process.argv.slice(2, 4).map(Number);
const count = Number(process.argv[4] ?? 20);
const intervalSec = Number(process.argv[5] ?? 10);

if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
  console.error('Uso: node tools/staging/fast-match-burst.mjs <lat> <lng> [n=20] [intervaloSeg=10]');
  process.exit(1);
}
if (!API.includes('staging')) {
  console.error(`Rechazado: ${API} no parece staging.`);
  process.exit(1);
}

async function call(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'content-type': 'application/json',
      // Despacha sin esperar al pago: el backend solo lo acepta fuera de producción.
      'x-chapus-immediate-dispatch': 'true',
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

await call('POST', '/auth/otp/request', { phone: CLIENT_PHONE, channel: 'SMS' });
const { accessToken } = await call('POST', '/auth/otp/verify', {
  phone: CLIENT_PHONE,
  code: '123456',
  requestedRole: 'CLIENT',
});

// Desplazamiento de ~300 m para no apilar todas en el mismo punto.
const jitter = () => (Math.random() - 0.5) * 0.006;

for (let i = 1; i <= count; i++) {
  const sentAt = new Date().toISOString();
  const { request } = await call(
    'POST',
    '/requests',
    {
      categoryId: 102,
      pricingModel: 'FAST_MATCH',
      offeredPriceEur: 55,
      location: { lat: lat + jitter(), lng: lng + jitter() },
      addressText: ADDRESS,
      description: `Auditoría ackDeltaMs ${i}/${count}`,
      photoUrls: [],
    },
    accessToken,
  );
  console.log(`${String(i).padStart(2)}/${count}  ${sentAt}  ${request.id}`);
  if (i < count) await new Promise((r) => setTimeout(r, intervalSec * 1000));
}

console.log('\nListo. Cruza estos ids con los logs `ws_dispatch_ack` de Render para ver ackDeltaMs.');
