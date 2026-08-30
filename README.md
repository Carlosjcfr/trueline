# ProjectNotes

Gestión de proyectos en Obsidian sobre el modelo de datos de
[TaskNotes](https://github.com/callumalpass/tasknotes-spec), con la interfaz de
[Project Manager](https://github.com/StepanKropachev/obsidian-pm).

Una nota por tarea. El frontmatter sigue los roles semánticos del spec, así que el
mismo vault lo pueden leer TaskNotes, su CLI y este plugin sin migrar nada.

## Instalación (desarrollo)

```bash
npm install
npm run build          # genera main.js
npm run dev            # watch
npm test               # vitest
```

Copia `main.js`, `manifest.json` y `styles.css` a
`<vault>/.obsidian/plugins/projectnotes/` y activa el plugin.

## Cómo identifica una tarea

Por defecto, la propiedad `pn-task: true`. Configurable a tag o a otra
propiedad/valor, de modo que puedes apuntarlo a `pm-task: true` y ver las tareas que
ya tengas de Project Manager sin convertir nada.

## Esquema

```yaml
---
pn-task: true
id: revisar-dietas-a91f     # identidad estable; no cambia al renombrar ni mover
title: Revisar dietas Q3
status: in-progress
priority: high
scheduled: "2026-09-01"     # lo que Project Manager llama Start
due: "2026-09-15"
projects: ["[[Dietas]]"]    # proyecto, o tarea padre si es una subtarea
progress: 60                # EXTENSIÓN
assignees: [Carlos]         # EXTENSIÓN
milestone: false            # EXTENSIÓN
attachments: ["[[informe.pdf]]"]
timeEstimate: 90            # minutos (el modal los muestra en horas)
timeEntries:
  - startTime: "2026-09-01T09:00:00Z"
    endTime: "2026-09-01T10:30:00Z"
blockedBy:
  - uid: preparar-datos-3f2a
    reltype: FINISHTOSTART
    gap: P1D
gh-issue: "org/repo#412"    # EXTENSIÓN, clave del puente con GitHub
dateCreated: "2026-08-01T10:00:00Z"
dateModified: "2026-08-29T18:00:00Z"
---

El cuerpo es la hoja de la tarea. Markdown normal, embeds incluidos.
```

Un proyecto es una nota con `pn-project: true`. Su configuración vive en su propio
frontmatter y se hereda hacia los sub-proyectos:

```yaml
---
pn-project: true
title: Dietas
color: "#7c3aed"
icon: target
projects: ["[[Demarcacion]]"]   # anida bajo otro proyecto
defaultView: gantt
autoSchedule: true
statuses:
  - {id: blocked, label: Bloqueada, color: "#ef4444", icon: circle-slash, complete: false}
fields:
  - {key: cliente, type: text, label: Cliente}
  - {key: fase, type: select, label: Fase, options: [Diseño, Ejecución, Cierre]}
---
```

## Estado

Implementado:

- Modelo de datos conforme al spec (§2), con mapeo de roles, alias de lectura y
  precedencia canónica
- Serializador que preserva todo campo desconocido (§2.7)
- `TaskStore`: índice por id estable y por ruta, escritura vía `processFrontMatter`,
  sin bucles de eco
- `ProjectStore`: config por proyecto en el frontmatter, heredable por el árbol
- **Tabla**, **Kanban** (drag & drop con orden fraccional), **Gantt** (zoom día→año,
  barras arrastrables, hitos, flechas de dependencia) y **Calendario** (mes y semana)
- **Recurrencia RRULE** (§4): expansión de ocurrencias, estado por instancia, anclaje
  `scheduled` o `completion`, editor visual con vista previa
- **Cronómetro** con play/pause, sesiones editables, entrada manual y widget en la
  barra de estado
- **Reprogramación automática** de dependientes, con detección de ciclos
- **Sincronización bidireccional con GitHub** con ETag, tabla de decisión y anti-bucle
- Pestaña de ajustes completa
- 90 tests

Pendiente:

1. Adaptador para la suite de conformidad de `tasknotes-spec`
2. Perfil `materialized-occurrences` (§4.18)
3. Recordatorios: se leen y se preservan, pero aún no se disparan
4. GitHub Projects v2 (requiere GraphQL)

## Recurrencia

La regla se guarda en la forma combinada de una sola línea que exige el spec:

```yaml
recurrence: DTSTART:20260907;FREQ=WEEKLY;BYDAY=MO
recurrence_anchor: scheduled
complete_instances: ["2026-09-14"]
skipped_instances: ["2026-09-21"]
```

Completar una ocurrencia **no toca el `status` de la tarea** (§4.12): escribe la fecha
en `complete_instances`. Una revisión semanal marcada como "hecha" desaparecería de
todas las semanas futuras, que es justo lo que nadie quiere.

Con anclaje `completion`, completar reescribe el `DTSTART` a la fecha de finalización,
así que "cada 2 semanas desde que lo termine" funciona de verdad.

## Cronómetro

Una sesión en curso es una entrada de `timeEntries` con `startTime` y sin `endTime`.
No hay ningún otro sitio donde se guarde "el cronómetro está en marcha": si Obsidian
se cierra a lo bruto, la nota ya dice que había una sesión abierta y al arrancar se
recupera en lugar de perder la tarde.

Solo puede correr un cronómetro en todo el vault. Arrancar una tarea para la que está
corriendo otra la para primero — si no, los informes suman más horas de las que tiene
el día y nadie se entera hasta facturar.

Play y pausa están en la fila de la tabla, en la tarjeta del Kanban, en el modal y en
la barra de estado. Los botones del modal escriben directamente al vault, no al
borrador que se guarda al pulsar Guardar: cancelar el modal no debe borrar tiempo que
de verdad trabajaste.

## Sincronización con GitHub

Tres campos en el frontmatter sostienen todo el mecanismo:

| Campo | Qué guarda |
|---|---|
| `gh-issue` | `owner/repo#123`, la clave foránea |
| `gh-updated-at` | el `updated_at` del issue en la última sincronización |
| `gh-hash` | huella de los campos sincronizados en ese momento |

Con eso se responde, sin estado en servidor, la única pregunta que importa: **desde
que estuvimos de acuerdo, ¿quién ha cambiado?**

| | GitHub sin cambios | GitHub cambió |
|---|---|---|
| **Vault sin cambios** | nada | recibir |
| **Vault cambió** | enviar | conflicto → política configurada |

La política por defecto es **marcar y no tocar**: la tarea aparece listada y decides
tú. Escoger un ganador en silencio por trabajo ajeno es como los sincronizadores
pierden datos y confianza.

La prevención de bucles sale de los mismos campos: cada escritura nuestra reescribe
también `gh-hash` y `gh-updated-at`, así que la pasada siguiente ve "nadie cambió" y
se detiene.

**Sondeo:** peticiones condicionales con ETag. Un 304 no consume cuota, así que sondear
cada 60 s todo el día es prácticamente gratis.

**Aviso sobre el token:** se guarda en `data.json`, un archivo de texto plano dentro
del vault. Si sincronizas el vault o lo tienes en git, el token viaja con él. Usa un
token de alcance reducido (fine-grained) limitado a los repos que necesites, con
permiso de Issues de lectura y escritura, nunca un token clásico con permisos amplios.

## Licencias

Ver `NOTICE.md`. Código adaptado de Project Manager (MIT) y modelo de datos según la
especificación de TaskNotes.
