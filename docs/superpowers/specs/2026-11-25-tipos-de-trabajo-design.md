# Tipos de trabajo — diseño (aprobado por KM el 25/11/2026)

## Por qué
La app deja de ser sólo un lector de VIN: registra todo el trabajo del día de
cada trabajador. Al final del día tiene que poder decir, por ejemplo,
"Luis: 2 autos foto, 3 autos venta (1 exterior, 2 interior y exterior), 2 lavados".

## Tipos
| clave    | nombre                | detalle                                  |
|----------|-----------------------|------------------------------------------|
| foto     | Auto foto             | — (el trabajo principal, con lector VIN) |
| venta    | Auto venta            | exterior / interior / ambos (interior y exterior) |
| lavado   | Lavado exterior agua  | —                                        |
| car4us   | Car4us (sólo historial; no se ofrece al registrar) | — |

"Interior y exterior" cuenta como 1 auto venta, con su detalle.

## Objetivos
- Botón "Registrar trabajo": 1) ¿qué trabajo? (con detalle si es venta)
  2) ¿cómo? Leer VIN (lector de siempre) / Foto del auto (foto general, sin
  lectura) / Sin foto. 3) ficha: trabajador, supervisor, hora, notas, con quién → Guardar.
- VIN y foto opcionales para todos los tipos.
- El lector de VIN, la cámara, la galería (una y varias), el código de barras:
  sin cambios. Lo que registran es Auto foto. La tanda de galería permite
  elegir el tipo arriba (por defecto Auto foto).
- Reportes, resumen del día, lista de hoy, CSV: cuentan por tipo y por trabajador.
- Tiempo por auto y gráficos de ritmo: sólo Auto foto.
- Por confirmar: sólo trabajos donde se intentó leer VIN y no salió completo.
- Registros viejos: normales → Auto foto; etiqueta "Sección: Autos de venta"
  → Auto venta sin detalle; "Sección: Car4us" → car4us.

## No objetivos / anti-objetivos
- No se borra ni cambia ninguna función del lector de VIN.
- No se pierde ningún registro ni el registro de cambios.
- No se rompe una app vieja que siga abierta en un teléfono mientras se publica.

## Enfoques considerados
- A (elegido): columna `tipo_trabajo` + `tipo_detalle` en `vin_log_entries`.
  Un solo registro, con hora, historial de cambios y fotos. Requiere migración.
- B: contador "+1" aparte. Descartado: dos listas, sin hora ni historial.
- C: etiquetas de texto como "Otra sección". Descartado: frágil para sumar por tipo.

## Base (Supabase orajysldssgztignuist)
- `tipo_trabajo text check in (foto, venta, lavado, car4us)`, `tipo_detalle text
  check in (exterior, interior, ambos)`; relleno de los viejos según etiquetas.
- `vin_log_insert` / `vin_log_update` aceptan `p_tipo`, `p_tipo_detalle`
  (por defecto null → se deduce de las etiquetas, como hace la app vieja).
  El "mismo registro" (anti-duplicado) incluye el tipo.
- `vin_log_lista` devuelve `tipo_trabajo`, `tipo_detalle`.
- El trigger del registro de cambios ya apunta cualquier columna nueva.
- Migración aplicada antes de publicar la app; la app nueva tolera que la
  lista no traiga las columnas (cae a las etiquetas).

## Decisiones del constructor
- Textos, iconos y orden visual de los botones; el botón "Otra sección" se
  reemplaza por "Registrar trabajo" (Resúmenes sigue en los atajos).
- Pruebas: qa/prueba-registro-vin.js (S23) y una prueba pglite de la migración.
