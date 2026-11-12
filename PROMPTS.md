# PROMPTS.md — Prompts listos para copiar

> Antes de usar cualquiera: el agente debe poder leer `PROJECT.md`, `AGENTS.md`, `ARCHITECTURE.md` y `DATA_CONTRACT.md` (están en la raíz del repo). Ahí está todo el contexto del proyecto.

## 1. Entrevista y plan

Compara las dos respuestas: preguntas que hace, riesgos que detecta y claridad del método de armonización.

```
Lee PROJECT.md, AGENTS.md, ARCHITECTURE.md y DATA_CONTRACT.md.
NO escribas código todavía.

Actúa como arquitecto senior en datos geoespaciales y desarrollo web.
Mi equipo no tiene experiencia en este tipo de reto y
tenemos ~39 horas.

1. Resume con tus palabras qué pide el reto y cómo crees que se evaluará.
2. Señala riesgos, ambigüedades y supuestos peligrosos en los documentos.
3. Hazme las preguntas que necesites para decidir bien (máximo 8,
   ordenadas por importancia). Espera mis respuestas antes de continuar.
4. Después, propón 2 o 3 enfoques para armonizar MODIS y VIIRS (puedes
   usar las hipótesis H1-H3 de ARCHITECTURE.md o proponer otras), con
   ventajas, desventajas y cómo validar que funciona. Recomienda uno y
   explícalo en lenguaje simple.
5. No inventes datos ni nombres de columnas: si dudas, dime cómo verificarlo.
```

## 2. Refinar los documentos

```
Con lo que decidimos [pega aquí resultados del spike y decisiones],
actualiza ARCHITECTURE.md, DATA_CONTRACT.md. Marca qué cambió
y por qué. No escribas código de la aplicación.
```

## 3. Revisión cruzada

```
Revisa este cambio como un revisor escéptico: [pega diff o indica archivos].
Compáralo con ARCHITECTURE.md y DATA_CONTRACT.md. Busca errores lógicos,
casos borde y incumplimientos del contrato de datos. No reescribas todo:
dame una lista priorizada de problemas y cómo comprobar cada uno.
```

## 4. Revisión científica del método

```
Aquí está mi método de armonización de MODIS y VIIRS: [pega docs/METODO.md].
Evalúalo críticamente: ¿qué sesgos introduce?, ¿qué casos podrían romperlo?,
¿qué evidencia mostraría que de verdad corrige el salto entre sensores?
Explícalo de forma que alguien sin experiencia pueda defenderlo ante un jurado.
```

## 5. Dudas conceptuales

```
Explícame como a alguien sin experiencia: [concepto, por ejemplo
"qué es FRP en datos de incendios satelitales" o "por qué MODIS y VIIRS
no se pueden comparar directamente"]. Usa un ejemplo simple y dime
qué debería verificar en los datos oficiales.
```