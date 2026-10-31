# Estado de la integración Frontend ↔ Backend

> `CONTRACT_GAPS.md` contiene el parche del dispatcher que envió Argon. Este archivo recoge el estado vivo.

## Contrato

`packages/api-contract/openapi.yaml` incluye las líneas 1–273 de la v1.1.0 de Argon (llegó truncada); el resto lo reconstruyó frontend desde el código de backend.

`ServiceRequestResponse` es ahora el espejo exacto de `ServiceRequestDTO` (`service-request.serializer.ts`). Sus campos nuevos son `addressText: string | null`, `approximateZone` e `isAddressMasked`.

**Pendiente:** que Argon envíe el YAML completo. Basta con sustituirlo y ejecutar `npm run gen:api && npm run typecheck`.

Supuestos que hay que confirmar:
- `POST /auth/refresh`. Hace falta para re-firmar el claim `kycStatus`.
- Que `POST /requests/{id}/bids` devuelva `BidResponse`.
- Que `start` y `complete` devuelvan el DTO.
- La forma de `booking:assigned`: `{ job, guaranteedPayoutEur }`.

## ✅ Integrado (v1.1 + privacidad + job:updated)

| Pieza | Frontend |
|---|---|
| Máscara RGPD en el serializador | La UI usa solo `isAddressMasked`, `addressText` y `approximateZone`. Se eliminó el enmascarado del lado cliente. La ruta (Google Maps, Waze, Mapas de Apple) solo se ofrece con `isAddressMasked: false`. |
| `job:updated` en `/offers` y `/bookings` | Listener global en el proveedor (`useJobEvents`) y por solicitud en el cliente. Descarta eventos fuera de orden por `version`. |
| `booking:assigned` | Vibra, guarda `guaranteedPayoutEur` y lleva al profesional a la ficha si está en otra pantalla. |
| Sin polling | Se eliminó el sondeo de `GET /requests/{id}`. La app solo vuelve a pedir el estado tras reconectar el socket o al volver a primer plano, por si se perdió algún evento. |
| ACK de telemetría | `{ received: true, deviceId, clientTimestamp }`. `deviceId` es un id de instalación estable guardado en SecureStore. |
| 403 `RGPD_ACCESS_DENIED` | Un proveedor que perdió la carrera ve «Este trabajo ya no está disponible». |
| Push sin dirección | Se usa `approximateZone` del `data` del push. |

## ⚠️ Observaciones para Argon (por prioridad)

1. **Regresión en el push de respaldo (bloqueante para Fast-Match).** `sendBatchPushFallback` envía solo `data`. Se perdieron:
   - en Android, `notification` con `channelId: 'chapus_urgent_jobs'`;
   - en iOS, `apns` con `alert`, `sound` y `apns-priority: 10`.

   Sin ellos, iOS no muestra nada con la app cerrada, y Android no despierta la pantalla ni hace sonar `urgent_alert.wav`. **El profesional con el móvil en el bolsillo no se entera.** Basta con recuperar esos bloques con un título genérico (precio y `approximateZone`, nunca la dirección).
2. **`adapter.rooms` es local al nodo.** Con Redis Adapter en varias instancias, `rooms.get('provider:{id}')` no ve los sockets conectados a otro nodo. Esos proveedores salen como `NO_ACTIVE_SOCKET` y reciben push en lugar de WS, lo que dispara el coste de FCM y la latencia. Opciones: `await offersNamespace.in(room).fetchSockets()`, que funciona en todo el clúster, o emitir siempre y decidir solo por el ACK.
3. **`toDTO` lanza excepción dentro de `Promise.all` del dispatcher.** Si una oleada se despacha cuando la solicitud ya no está `OPEN`, el primer candidato lanza 403 y aborta la oleada entera, incluido el push. Conviene comprobar el estado antes de despachar.
4. **Emisor de `booking:assigned`.** No está en el material recibido; el frontend lo escucha con la forma supuesta.
5. **p95 en `logWaveViabilityMetrics`.** `floor(n * 0.95)` devuelve el máximo cuando n ≤ 20. Para nearest-rank es `ceil(0.95 n) - 1`. Es menor, pero sobrestima el p95 en oleadas pequeñas.
6. **`job:updated` a `client:{id}`.** El gateway de `/bookings` no une a nadie a esa sala, solo a `request:{id}`. Hoy funciona por la segunda sala; si se quiere la primera, hay que hacer `socket.join(\`client:${sub}\`)` al conectar.
