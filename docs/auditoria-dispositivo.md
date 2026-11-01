# Auditoría en dispositivo físico: Fast-Match

Protocolo para medir la latencia en red móvil real y validar la transición al perder una oportunidad. Las mediciones se hacen **en un teléfono físico con la build de desarrollo instalada**. El simulador y el Wi-Fi de oficina no sirven para esta prueba.

## Preparación

1. Instala el APK de la build `development` (QR de EAS) en un Android con SIM de datos.
2. Arranca Metro en el PC con `npm run proveedor`. El dev client se conecta por la LAN o con `--tunnel`.
3. Inicia sesión con un proveedor de pruebas con `kycStatus = VERIFIED` y ponte **Disponible**.
4. **Desactiva el Wi-Fi** y anota el operador y la tecnología que muestra la barra de estado (4G/4G+/5G).

## Mediciones (panel «Diagnóstico de latencia»)

| # | Prueba | Cómo | Métrica | Objetivo |
|---|---|---|---|---|
| A | Pintado del banner | «Simular alerta Fast-Match» ×20 | Evento → banner pintado (p50/p95) | p95 < 150 ms |
| B | RTT de red | «Medir» ×3 tandas | RTT HTTP (5 muestras/tanda) | Referencia por operador |
| C | Alerta real | Crear 20 solicitudes FAST_MATCH desde la App Cliente, a menos de 5 km | Servidor → móvil y evento → ACK | ACK ≈ 0 ms en el móvil |
| D | Δt emit→ACK (servidor) | Logs `metric: ws_dispatch_ack` (Datadog/CloudWatch) filtrando `deviceId` del móvil | `ackDeltaMs`, `latencyStatsMs.p95` | p95 < 300 ms en 4G |
| E | Fallback push | Pantalla bloqueada 2 min y lanzar una solicitud | `status: NO_ACTIVE_SOCKET` o `ACK_TIMEOUT` + llega notificación con sonido | Aviso < 5 s |

> «Servidor → móvil» compara el `createdAt` de la solicitud con el reloj del teléfono. Incluye el desfase entre relojes y el tiempo de PostGIS y despacho, así que es orientativo. La cifra de referencia es **D**, medida con `hrtime` en el servidor.

### Plantilla de resultados

| Fecha | Operador | Red | A p50/p95 | B RTT medio | C p50/p95 | D p95 (servidor) | E | Notas |
|---|---|---|---|---|---|---|---|---|
| 31/10/2026 | — | 4G+ | 111 / 134 ms (máx 223, n=20) ✅ | 159 ms (137–185, n=5, staging Frankfurt) | servidor→móvil 275 / 394 ms (n=14); ACK 0,5 / 9,5 ms; banner 88 / 276 ms ⚠️ (n=19) | p50 100,6 / p95 206,4 ms ✅ (n=20, 20/20 ACK_RECEIVED, máx 746,7 aislado) | ✅ app cerrada y bloqueada: push FCM 1,2 s, notificación en canal `chapus_urgent_jobs` a los 2,1 s del envío | A en modo demo sin backend (ACK 0 ms, n=20). C con alertas reales en 22600 Sabiñánigo; build de desarrollo. El p95 del banner con alertas reales lo marca una sola muestra (con n=19, p95 = máx): repetir en build de staging |
| | | | | | | | | |

## Pérdida de oportunidad (transición visual)

Hacen falta dos teléfonos proveedores en la misma zona.

| Escenario | Pasos | Resultado esperado |
|---|---|---|
| 1. Ganan antes de que toques | El teléfono B acepta primero | En A el banner pasa a gris con «Otro profesional se adelantó», el precio tachado y una vibración breve. Se desvanece en ~1,8 s sin parpadeos ni saltos de layout |
| 2. Tocas tarde (409) | Ambos pulsan «Aceptar» casi a la vez | En el perdedor, el botón muestra el spinner y después la misma transición gris. Nunca aparece un texto rojo de error |
| 3. Ficha abierta | A tiene abierta la ficha de la alerta cuando B gana | La ficha cambia a «Otro profesional se adelantó» con el botón «Volver al radar» |
| 4. Llega tarde por push | A abre la notificación cuando el trabajo ya está asignado (403 `RGPD_ACCESS_DENIED`) | La misma pantalla de oportunidad perdida, sin «error» ni dirección |
| 5. Sin KYC (403 `KYC_VERIFICATION_REQUIRED`) | Proveedor no verificado | Lleva a la verificación con Stripe, **no** a la pantalla de oportunidad perdida |

Documenta cada escenario con una grabación de pantalla (Android: ajustes rápidos → Grabar pantalla) y adjúntala al informe.
