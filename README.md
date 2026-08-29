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
- `TaskStore`: índice por id estable y por ruta, resolución de wikilinks, escritura
  vía `processFrontMatter`, sin bucles de eco
- `ProjectStore`: config por proyecto en el frontmatter, con herencia por el árbol
- **Vista de tabla** con jerarquía derivada de `projects`
- **Kanban** con arrastrar y soltar y orden fraccional estable
- **Gantt** con zoom día→año, barras arrastrables y redimensionables, hitos, línea de
  hoy y flechas de dependencia que respetan `reltype` y `gap`
- **Reprogramación automática** de dependientes, con detección de ciclos
- **Sincronización bidireccional con GitHub**: sondeo condicional con ETag, tabla de
  decisión explícita, detección de conflictos y prevención de bucles
- Modal de tarea con la rejilla de propiedades de PM y campos personalizados
- Pestaña de ajustes completa
- 49 tests

Pendiente:

1. Recurrencia con `rrule` y estado por instancia
2. Vista de calendario
3. Adaptador para la suite de conformidad de `tasknotes-spec`
4. GitHub Projects v2 (requiere GraphQL)

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
