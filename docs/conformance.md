# Conformidad con el spec de TaskNotes

Objetivo: perfiles `core-lite` y, más adelante, `recurrence`.

## Desviaciones declaradas

| Desviación | Motivo |
|---|---|
| Roles extra: `progress`, `assignees`, `milestone`, `gh_issue` | Aditivos. §2.7 obliga a todo lector a preservarlos, así que no afectan a otras implementaciones. |
| Config de proyecto en el frontmatter de la nota de proyecto | El spec no cubre proyectos como entidad configurable. Las claves viven en la nota del proyecto, nunca en la de tarea. |
| Los campos personalizados por proyecto se escriben planos en el frontmatter | Es lo que hace que Bases y Dataview puedan filtrarlos. |
| `time_estimate` se muestra en horas | Solo presentación: el valor persistido son minutos, como exige §2.3. |

## Sin implementar todavía

- Perfil `materialized-occurrences` (§4.18)
- `reminders` se leen y se preservan, pero no se disparan
- `recurrence`: se preserva el RRULE, aún no se expande
