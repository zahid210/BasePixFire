# AGENTS.md — Reglas de trabajo para agentes de IA

## Contexto
- Proyecto: ver `PROJECT.md`. Arquitectura: `ARCHITECTURE.md`. Datos: `DATA_CONTRACT.md`.
- Lee esos archivos al empezar cada sesión. Si falta algo, pregunta.
- Idioma de trabajo: español (comentarios, explicaciones y mensajes de commit).

## Cómo trabajar
1. **Plan antes que código.** Para cualquier cambio que toque varios archivos, explica el plan en pocas líneas y espera mi OK.
2. **Pregunta ante la ambigüedad.** No asumas formatos, nombres ni decisiones científicas.
3. **Simple y legible.** Prioriza que funcione y que el equipo lo entienda. Evita dependencias innecesarias y abstracciones complejas.
4. **Explica lo que haces.** Al terminar: qué cambiaste, en qué archivos y cómo probarlo.
5. **Prueba con datos pequeños** antes de usar datos completos.

## Ciencia y datos (muy importante)
- **No inventes datos, cifras ni resultados científicos.** Si no estás seguro de algo (nombres de columnas, fechas de operación de los satélites, comportamiento de un producto), dilo y propón cómo verificarlo con los recursos oficiales.
- Cualquier método de armonización debe poder explicarse en lenguaje simple y **validarse** (por ejemplo, comprobando que el "salto" entre MODIS y VIIRS desaparezca en el periodo de traslape).
- Documenta supuestos y limitaciones en `docs/METODO.md`.

## Seguridad y operación
- No ejecutes comandos destructivos (borrados masivos, `rm -rf`, sobrescrituras) sin avisar y esperar confirmación.
- No instales paquetes globales ni modifiques configuración del sistema sin avisar.
- No subas claves ni credenciales al repositorio (usa `.env` y agrégalo a `.gitignore`).

## Git
- Commits pequeños y frecuentes con mensajes claros.

## Cuando te atasques
- Si llevas mucho tiempo en el mismo problema, dilo y propón un enfoque alternativo más simple en vez de insistir.
- Si la sesión se vuelve larga, genera `SESSION_NOTES.md` con: qué está hecho, qué falta, decisiones tomadas y problemas abiertos.
