# Chapus: frontend móvil

Monorepo (npm workspaces) con dos apps Expo SDK 58 (React Native 0.88) y paquetes compartidos.

```
apps/cliente        Chapus (es.chapus.cliente): catálogo, reserva, fotos, PaymentSheet
apps/proveedor      Chapus Pro (es.chapus.proveedor): disponibilidad, radar, alertas con ACK, KYC Stripe
packages/api-contract  openapi.yaml + tipos generados (openapi-typescript)
packages/core       tipos de dominio estrictos, validación zod, eventos realtime
packages/api        cliente REST tipado (openapi-fetch), hooks TanStack Query, socket.io-client
packages/ui         tokens y componentes base
```

## Puesta en marcha

```bash
npm install
npm run gen:api            # regenera tipos tras cambiar openapi.yaml
cp apps/cliente/.env.example apps/cliente/.env
cp apps/proveedor/.env.example apps/proveedor/.env
```

Stripe, las notificaciones remotas y Google o Apple Pay **no funcionan en Expo Go**. Hace falta un development build:

```bash
cd apps/proveedor && npx eas-cli@latest build --profile development --platform android
```

Después: `npm run proveedor` o `npm run cliente` (equivale a `expo start`).

En el emulador Android, `localhost` del PC es `10.0.2.2` (ya configurado en el perfil `development` de `eas.json`).

## Flujos implementados

- **Alertas al proveedor (WS + push).** `features/alerts/useJobAlertChannel.ts` confirma `geo:job_alert` con `{ received: true }` antes de cualquier otro trabajo, porque el dispatcher espera 1,5 s. Si no recibe el ACK, el aviso llega por FCM/APNs en el canal `chapus_urgent_jobs`, con sonido `urgent_alert.wav`. Ambas vías se deduplican por `requestId`, y los FAST_MATCH con más de 45 s se descartan.
- **Fast-Match.** Aceptación atómica: un 409 muestra "otro profesional lo aceptó antes" y un 403 redirige a la verificación KYC.
- **Bidding.** Formulario de presupuesto con validación zod. El cliente acepta una oferta y paga con PaymentSheet (Escrow).
- **KYC.** El onboarding de Stripe Connect Express se abre en `openAuthSessionAsync` con deep link de retorno.
- **Fotos.** Se redimensionan a 1600 px en JPEG al 70 % y se suben directamente a S3 con URLs prefirmadas.

Estado de la integración con backend: ver [CONTRACT_STATUS.md](CONTRACT_STATUS.md).

## Despliegue

| Entorno | Build | OTA |
|---|---|---|
| development | `eas build --profile development` | `eas update --channel development` |
| staging | `eas build --profile staging` | `eas update --channel staging` |
| production | `eas build --profile production` y después `eas submit -p ios|android` | `eas update --channel production` |

Antes del primer build de producción hay que hacer lo siguiente:
1. `npx eas-cli@latest init` en cada app (crea `projectId`).
2. Añadir `google-services.json` (FCM) y la APNs key en EAS credentials para Chapus Pro.
3. Dar de alta el Merchant ID `merchant.es.chapus` en Apple y el dominio en Stripe para Apple Pay.
4. Sustituir `assets/sounds/urgent_alert.wav` (tono provisional generado) por el sonido definitivo.
5. Revisar las URLs de `staging` en `eas.json` (son supuestas: `staging-api.chapus.es`).

## Auditoría en dispositivo físico

1. `npx eas-cli@latest login` (cuenta Expo del equipo) y `npx eas-cli@latest init` en cada app.
2. Android de Chapus Pro: subir `google-services.json` (FCM) con `eas credentials`; sin él no hay token push.
3. `npx eas-cli@latest build --profile development --platform android` (y `ios`, que requiere Apple Developer). Instalar desde el QR y ejecutar `npm run proveedor`.
4. En Chapus Pro → **Diagnóstico de latencia** (perfiles development y staging, `EXPO_PUBLIC_DIAGNOSTICS=1`):
   - «Simular alerta» mide de evento a banner pintado (objetivo < 150 ms) sin backend.
   - Con alertas reales mide servidor → móvil y evento → ACK.
   - «Medir» compara el RTT HTTP en Wi-Fi, 4G y 5G.
5. PaymentSheet: en Metro, cada pago imprime `[payments] init … · bloqueo JS máx … ms`. Más de 50 ms indica que la UI se congeló.

## Permisos (cuándo y por qué)

| Permiso | App | Momento | Justificación mostrada |
|---|---|---|---|
| Ubicación (en uso) | Pro | Al activar «Disponible» | Alertas de trabajo en tu zona |
| Notificaciones | Pro | Mismo gesto, tras la ubicación | Avisos con el móvil bloqueado |
| Ubicación en 2.º plano | Pro | Opt-in en el radar, ya online | Divulgación destacada de Google + aviso permanente |
| Ubicación (en uso) | Cliente | Botón «Usar mi ubicación» (opcional, se puede escribir la dirección) | Encontrar profesionales cerca |
| Cámara | Cliente | Botón «Cámara» | Presupuesto más preciso |
| Galería | Cliente | Nunca: usa el selector del sistema | — |

No se pide ningún permiso en el arranque ni en el login. Las pantallas previas viven en `packages/ui/src/permissions.tsx`, y los textos de Info.plist se fuerzan en español con `tools/expo-plugins/with-purpose-strings.js`.
