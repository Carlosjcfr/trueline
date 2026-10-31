# Licencias y atribuciones

## Este plugin

Copyright (C) 2026 Carlos.

Distribuido bajo la **GNU General Public License v3.0 o posterior**
(`GPL-3.0-or-later`). Texto completo en `LICENSE`.

Este programa es software libre: puedes redistribuirlo y modificarlo según los
términos de la GNU GPL publicada por la Free Software Foundation, versión 3 o
cualquier versión posterior. Se distribuye con la esperanza de que sea útil, pero
**sin ninguna garantía**, ni siquiera la implícita de comerciabilidad o idoneidad
para un fin concreto.

## Código de terceros incluido

Las partes siguientes conservan su licencia original. Son licencias permisivas
compatibles con la GPL-3.0, y sus avisos se mantienen como exigen.

### Project Manager for Obsidian — MIT
Copyright (c) 2026 Stepan Kropachev — https://github.com/StepanKropachev/obsidian-pm

Adaptado: primitivos de UI (`src/ui/primitives/`), `src/ui/FormField.ts`, helpers de
`src/ui/dom.ts`, la estructura del Gantt (`src/views/gantt/`) y reglas de estilo de
`styles.css`. Cada archivo lleva una cabecera que indica su origen. Esas porciones
siguen disponibles bajo MIT para quien las extraiga. Licencia en
`licenses/obsidian-pm.LICENSE`.

### rrule.js — BSD-3-Clause
Copyright 2010, Jakub Roztocil y Lars Schöning — https://github.com/jakubroztocil/rrule

Dependencia empaquetada dentro de `main.js`. La BSD-3-Clause exige reproducir su
aviso también en la distribución binaria, por eso viaja con el plugin. Licencia en
`licenses/rrule.LICENSE`.

## Referencias sin código copiado

### Especificación de TaskNotes
https://github.com/callumalpass/tasknotes-spec

El modelo de datos sigue esta especificación para que el mismo vault sea legible por
TaskNotes y su ecosistema. No se ha copiado código de TaskNotes: implementar una
especificación no crea obra derivada. Desviaciones declaradas en `docs/conformance.md`.
