# Tipos de trabajo — plan

> Ejecución: nativa (en esta sesión), revisión al final. Spec: docs/superpowers/specs/2026-11-25-tipos-de-trabajo-design.md

**Goal:** registrar cualquier tipo de trabajo (foto, venta+detalle, lavado) con VIN/foto opcionales y contarlo por tipo en todo.
**Architecture:** columnas nuevas en vin_log_entries; en la app, `tipoDe(r)` reemplaza a `seccionDe/esNormal` como única fuente del tipo.
**Tech:** HTML/JS de un archivo (index.html), Postgres/Supabase, pruebas Chrome headless + pglite.

## Global Constraints
- Lector de VIN (lector-vin.js), cámara, galería, tanda, código de barras: sin cambios de comportamiento.
- Claves: foto | venta | lavado | car4us; detalle: exterior | interior | ambos.
- Nombres visibles: "Auto foto", "Auto venta", "Lavado exterior agua"; detalle "Exterior", "Interior", "Interior y exterior".
- Nunca escribir en producción desde pruebas. Migración: archivo en soo-app/supabase/migrations, aplicada por SQL editor.

## Review Focus
1. App vieja abierta tras la migración: insert sin p_tipo → tipo deducido de etiquetas (prueba pglite).
2. App nueva antes de la migración (lista sin tipo_trabajo): cae a etiquetas → foto (prueba app: fila sin campo).
3. Dos "Sin foto" del mismo tipo y trabajador en el mismo minuto: no se fusionan (client_at con ms; prueba pglite con tipos distintos misma hora → 2 filas).
4. Editar un registro cambia su tipo y queda en el historial (prueba pglite: campos incluye tipo_trabajo).
5. Resumen/CSV con mezcla de tipos y registros viejos con etiqueta de sección (prueba app).

### Task 1: Migración
Files: soo-app/supabase/migrations/20261125100000_vin_log_tipos_de_trabajo.sql; Test: soo-app/qa/prueba-tipos-base.mjs
- columnas + checks + relleno; insert/update con `p_tipo text default null, p_tipo_detalle text default null` (update: null = no cambia); lista devuelve tipo_trabajo, tipo_detalle; anti-duplicado incluye tipo.
- Test: viejo sin p_tipo con etiqueta venta → 'venta'; sin etiqueta → 'foto'; p_tipo 'lavado' → 'lavado'; detalle inválido → error; venta+ambos ok; misma hora y trabajador, tipos distintos → 2 filas; update cambia tipo y aparece en vin_log_cambios.campos.
- Commit.

### Task 2: Modelo del tipo en la app
index.html: `TIPOS` (clave→{nombre, uno, varios}), `DETALLES`, `tipoDe(r)` (tipo_trabajo || por etiquetas || 'foto'), `detalleDe(r)`, `esNormal = r => tipoDe(r)==='foto'`, `textoCuenta(filas)` → "2 autos foto, 3 autos venta (1 exterior, 2 interior y exterior), 2 lavados exterior agua". Reemplazar usos de seccionDe/SECCIONES en lista, reportes, CSV (columna "tipo"), resumen, fotos de respaldo.

### Task 3: Registrar trabajo
Botón "Registrar trabajo" (reemplaza "Otra sección"): hoja `tipoScrim` con paso 1 (tipo + detalle) y paso 2 (Leer VIN → abrirLector({tipo}) / Foto del auto → cámara general → ficha / Sin foto → ficha). Ficha (rev_*) con selector de tipo en lugar de rev_seccion; VIN opcional; guarda p_tipo/p_tipo_detalle; confirmado=true si no se intentó VIN; Por confirmar sólo si tipo foto sin VIN completo, o VIN incompleto escrito. Lector/galería/barras siguen llegando como 'foto'. Tanda: selector de tipo arriba.

### Task 4: Pruebas app + verificación
qa/prueba-registro-vin.js: registrar lavado sin foto, venta ambos con foto, foto con VIN; lista de hoy y resumen cuentan por tipo; CSV columna tipo; fila sin tipo_trabajo con etiqueta venta sale como Auto venta. Suite completa verde, captura S23. Commit ambos repos; aplicar migración en producción y verificar con curl anon.
