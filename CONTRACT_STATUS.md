# Estado de la integración Frontend ↔ Backend (contrato v1.1.0)

> `CONTRACT_GAPS.md` contiene ahora el parche del dispatcher que envió Argon. Este archivo sustituye a la lista de huecos.

## ⚠️ El `openapi.yaml.yaml` v1.1.0 llegó truncado

Termina en la línea 273, a mitad de `ServiceRequestCreate.offeredPriceEur`. Faltan `ServiceRequestResponse`, `BidResponse` y **toda la sección `paths`**.

`packages/api-contract/openapi.yaml` se compone de dos partes:
- **Las líneas 1–273 de Argon, sin cambios** (esquemas estrictos de auth, presign, catálogo, errores…).
- **El resto, reconstruido por frontend** a partir de `bookings.service.ts`, `realtime.gateway.ts` y `presign.service.ts`. Está marcado en el YAML. Pasa `redocly lint` sin errores.

**Acción:** que Argon envíe el archivo completo. Basta con sustituir `packages/api-contract/openapi.yaml` y ejecutar `npm run gen:api && npm run typecheck`. Cualquier diferencia de forma saldrá como error de tipos.

Supuestos de la reconstrucción que conviene confirmar:

| Supuesto | Fuente |
|---|---|
| `ServiceRequestResponse` incluye `bidsCount`, `acceptedAt` y `completedAt` | SELECT de `getRequestById` |
| `BidResponse.provider = { id, fullName, ratingAvg, completedJobsCount, avatarUrl }` y `status: BidStatus` | SELECT de `getBidsByRequestId` |
| `POST /auth/otp/request` → 204 | No especificado |
| **`POST /auth/refresh { refreshToken }` → `AuthSessionResponse`** | No existe en el material recibido. Hace falta porque el JWT caduca y **el claim `kycStatus` debe re-firmarse tras el KYC** para que `/offers` acepte la conexión |
| `POST /requests/{id}/bids` → 201 `BidResponse` | Antes no había cuerpo |
| `start` y `complete` → 200 `ServiceRequestResponse` | Antes no había cuerpo |
| `paymentSheet` es `null` en BIDDING al crear | Descripción de la v1.0.0 |

## ✅ Integrado en el frontend

- **Login OTP** (SMS/WhatsApp, `+34[6789]xxxxxxxx`). Sesión en SecureStore con renovación proactiva y una sola petición de refresh a la vez. La pantalla de login está tras `Stack.Protected`.
- **Namespace `/offers`.**
  - `geo:job_alert { request, distanceKm }` se confirma con `{ received: true, timestamp }`.
  - `geo:job_taken` retira la alerta.
  - Un `connect_error` con 403 `KYC_VERIFICATION_REQUIRED` muestra el aviso de verificación.
  - Al volver de Stripe, la app renueva el JWT y reconecta.
- **Namespace `/bookings`.**
  - `request:subscribe` se repite en cada reconexión.
  - `request:updated` se ordena por `version`, descartando eventos fuera de orden.
  - `request:bid_created` llega deduplicado.
- **Presign.** Se pide una URL por archivo con el `fileSizeBytes` exacto del JPEG ya comprimido, porque S3 firma el `ContentLength`. El PUT se envía con `requiredHeaders`.
- **Consultas.** `GET /requests/{id}` y `GET /requests/{id}/bids` sustituyen la caché local. Se rehidratan al resuscribirse.

## Observaciones para Argon

1. **ACK con varios dispositivos** (`emitWithAckTimeout`). En Socket.IO v4, `err` se activa si *algún* socket de la sala no responde a tiempo, aunque `responses` sí contenga el ACK de otro. Con un móvil activo y una tablet zombie, hoy se dispara el push igualmente. Propuesta:
   ```ts
   resolve(Array.isArray(responses) && responses.some((a) => a?.received === true));
   ```
2. **Autorización (seguridad).**
   - `request:subscribe` une a cualquier usuario autenticado a cualquier sala `request:{id}`.
   - `getRequestById` no comprueba la propiedad de la solicitud.
   
   Ambos exponen la dirección del domicilio. Hay que verificar `client_id = sub`, o que el usuario sea el proveedor asignado o notificado.
3. **El proveedor no recibe `request:updated`.** Su pantalla "Trabajo asignado" no se entera en vivo de que el cliente pagó (`AWAITING_PAYMENT → ASSIGNED`). Opciones: permitir que el proveedor asignado se suscriba en `/bookings`, o emitir `job:updated` en la sala `provider:{id}` de `/offers`.
4. **Sin `categoryName` en el payload de `geo:job_alert`.** El frontend lo resuelve con el catálogo en caché. Es correcto, pero si el catálogo aún no ha cargado, el banner muestra "Trabajo".
5. **Push de respaldo.** Siguen pendientes el `distanceKm: 'Calculando...'` y la falta de `createdAt` en `data`.
