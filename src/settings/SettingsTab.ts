import { Notice, PluginSettingTab, Setting, type App } from 'obsidian'
import type ProjectNotesPlugin from '../main'
import { describeReport } from '../github/sync'

/**
 * Settings.
 *
 * The GitHub section is deliberately explicit about direction and conflicts rather than
 * offering a single "sync" toggle. A bridge that writes to someone else's repository
 * should never leave the user guessing which way the data moves.
 */
export class ProjectNotesSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ProjectNotesPlugin
  ) {
    super(app, plugin)
  }

  override display(): void {
    const { containerEl } = this
    containerEl.empty()

    this.renderGeneral()
    this.renderGitHub()
  }

  private save(): void {
    void this.plugin.saveSettings()
  }

  private renderGeneral(): void {
    const { containerEl } = this
    const settings = this.plugin.settings

    new Setting(containerEl).setName('General').setHeading()

    new Setting(containerEl)
      .setName('Identificación de tareas')
      .setDesc(
        'Cómo se reconoce una nota como tarea. Con "propiedad" puedes apuntarlo a pm-task para leer las tareas que ya tengas de Project Manager.'
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ property: 'Propiedad', tag: 'Etiqueta' })
          .setValue(settings.identification.mode)
          .onChange((value) => {
            settings.identification.mode = value as 'property' | 'tag'
            this.save()
            this.display()
          })
      )

    new Setting(containerEl)
      .setName(settings.identification.mode === 'tag' ? 'Etiqueta' : 'Clave de propiedad')
      .addText((text) =>
        text.setValue(settings.identification.key).onChange((value) => {
          settings.identification.key = value.trim()
          this.save()
        })
      )

    if (settings.identification.mode === 'property') {
      new Setting(containerEl)
        .setName('Valor esperado')
        .setDesc('Vacío acepta cualquier valor no vacío.')
        .addText((text) =>
          text.setValue(settings.identification.value ?? '').onChange((value) => {
            settings.identification.value = value.trim() || undefined
            this.save()
          })
        )
    }

    new Setting(containerEl)
      .setName('Carpeta de tareas')
      .addText((text) =>
        text.setValue(settings.tasksFolder).onChange((value) => {
          settings.tasksFolder = value.trim()
          this.save()
        })
      )

    new Setting(containerEl)
      .setName('Abrir tareas en')
      .setDesc('En pestaña se abre la nota completa, con su cuerpo markdown editable.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ tab: 'Pestaña', modal: 'Ventana modal' })
          .setValue(settings.openTasksIn)
          .onChange((value) => {
            settings.openTasksIn = value as 'modal' | 'tab'
            this.save()
          })
      )

    new Setting(containerEl)
      .setName('Vista por defecto')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            table: 'Tabla',
            kanban: 'Kanban',
            gantt: 'Gantt',
            calendar: 'Calendario'
          })
          .setValue(settings.defaultView)
          .onChange((value) => {
            settings.defaultView = value as typeof settings.defaultView
            this.save()
          })
      )

    new Setting(containerEl)
      .setName('Reprogramar dependientes automáticamente')
      .setDesc(
        'Al mover una tarea en el Gantt, sus dependientes se desplazan para respetar el desfase. Los ciclos se rechazan sin aplicar nada.'
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSchedule).onChange((value) => {
          settings.autoSchedule = value
          this.save()
        })
      )
  }

  private renderGitHub(): void {
    const { containerEl } = this
    const github = this.plugin.settings.github

    new Setting(containerEl).setName('GitHub').setHeading()

    new Setting(containerEl)
      .setName('Activar sincronización')
      .addToggle((toggle) =>
        toggle.setValue(github.enabled).onChange((value) => {
          github.enabled = value
          this.save()
          this.plugin.restartGitHubPolling()
          this.display()
        })
      )

    if (!github.enabled) return

    new Setting(containerEl)
      .setName('Token')
      .setDesc(
        'Token de acceso personal de alcance reducido (fine-grained) con permiso de Issues: lectura y escritura. Se guarda en data.json dentro del vault, en texto plano: si sincronizas el vault, el token viaja con él.'
      )
      .addText((text) => {
        text.inputEl.type = 'password'
        text.setValue(github.token).onChange((value) => {
          github.token = value.trim()
          this.plugin.github?.setToken(github.token)
          this.save()
        })
      })
      .addButton((button) =>
        button.setButtonText('Verificar').onClick(async () => {
          try {
            const login = await this.plugin.github?.verifyToken()
            new Notice(`Token válido: ${login}`)
          } catch (error) {
            new Notice(`Token inválido: ${error instanceof Error ? error.message : error}`)
          }
        })
      )

    new Setting(containerEl)
      .setName('Repositorios')
      .setDesc('Uno por línea, en formato propietario/repo.')
      .addTextArea((area) => {
        area.inputEl.rows = 4
        area.setValue(github.repos.join('\n')).onChange((value) => {
          github.repos = value
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
          this.save()
        })
      })

    new Setting(containerEl)
      .setName('Dirección')
      .setDesc(
        'Bidireccional envía y recibe. Si solo quieres leer los issues sin tocar el repositorio, elige "solo recibir".'
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            both: 'Bidireccional',
            pull: 'Solo recibir (GitHub → Obsidian)',
            push: 'Solo enviar (Obsidian → GitHub)'
          })
          .setValue(github.direction)
          .onChange((value) => {
            github.direction = value as typeof github.direction
            this.save()
          })
      )

    new Setting(containerEl)
      .setName('Conflictos')
      .setDesc(
        'Qué hacer cuando la tarea y el issue han cambiado desde la última sincronización. "Marcar y no tocar" es lo seguro: la tarea queda listada y decides tú.'
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            manual: 'Marcar y no tocar',
            'prefer-remote': 'Gana GitHub',
            'prefer-local': 'Gana Obsidian'
          })
          .setValue(github.conflictPolicy)
          .onChange((value) => {
            github.conflictPolicy = value as typeof github.conflictPolicy
            this.save()
          })
      )

    new Setting(containerEl)
      .setName('Intervalo de sondeo (segundos)')
      .setDesc(
        'Las peticiones condicionales con ETag no consumen cuota cuando no hay cambios, así que 60 s es barato. 0 desactiva el temporizador y deja solo el comando manual.'
      )
      .addText((text) =>
        text.setValue(String(github.pollSeconds)).onChange((value) => {
          const seconds = Number(value)
          github.pollSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 60
          this.save()
          this.plugin.restartGitHubPolling()
        })
      )

    new Setting(containerEl)
      .setName('Sincronizar al abrir Obsidian')
      .addToggle((toggle) =>
        toggle.setValue(github.syncOnStartup).onChange((value) => {
          github.syncOnStartup = value
          this.save()
        })
      )

    new Setting(containerEl)
      .setName('Importar issues nuevos')
      .setDesc('Crea una nota de tarea para cada issue que aún no tenga una.')
      .addToggle((toggle) =>
        toggle.setValue(github.importNewIssues).onChange((value) => {
          github.importNewIssues = value
          this.save()
        })
      )

    new Setting(containerEl)
      .setName('Exportar tareas nuevas')
      .setDesc(
        'Abre un issue en el primer repositorio de la lista por cada tarea sin issue. Desactivado por defecto: escribe en un repositorio ajeno y eso no debería pasar de fondo sin que lo pidas.'
      )
      .addToggle((toggle) =>
        toggle.setValue(github.exportNewTasks).onChange((value) => {
          github.exportNewTasks = value
          this.save()
        })
      )

    new Setting(containerEl).setName('Mapeo de campos').setHeading()

    new Setting(containerEl)
      .setName('Estados que cierran el issue')
      .setDesc('Separados por comas. Cualquier otro estado deja el issue abierto.')
      .addText((text) =>
        text.setValue(github.mapping.closedStatuses.join(', ')).onChange((value) => {
          github.mapping.closedStatuses = value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
          this.save()
        })
      )

    new Setting(containerEl)
      .setName('Estado al cerrarse en GitHub')
      .addText((text) =>
        text.setValue(github.mapping.closeStatus).onChange((value) => {
          github.mapping.closeStatus = value.trim()
          this.save()
        })
      )

    new Setting(containerEl)
      .setName('Estado al reabrirse en GitHub')
      .setDesc('Solo se aplica si la tarea estaba en un estado de cierre.')
      .addText((text) =>
        text.setValue(github.mapping.reopenStatus).onChange((value) => {
          github.mapping.reopenStatus = value.trim()
          this.save()
        })
      )

    new Setting(containerEl)
      .setName('Prefijo de etiquetas de prioridad')
      .setDesc('Una etiqueta priority:high se convierte en prioridad "high" y no en tag.')
      .addText((text) =>
        text.setValue(github.mapping.priorityLabelPrefix).onChange((value) => {
          github.mapping.priorityLabelPrefix = value
          this.save()
        })
      )

    for (const [key, label] of [
      ['syncTitle', 'Sincronizar el título'],
      ['syncLabels', 'Sincronizar etiquetas'],
      ['syncAssignees', 'Sincronizar asignados']
    ] as const) {
      new Setting(containerEl).setName(label).addToggle((toggle) =>
        toggle.setValue(github.mapping[key]).onChange((value) => {
          github.mapping[key] = value
          this.save()
        })
      )
    }

    new Setting(containerEl)
      .setName('Sincronizar ahora')
      .setDesc('Ejecuta una pasada completa y muestra el resultado.')
      .addButton((button) =>
        button
          .setButtonText('Sincronizar')
          .setCta()
          .onClick(async () => {
            const report = await this.plugin.syncGitHub()
            if (!report) return
            new Notice(`GitHub: ${describeReport(report)}`)
            if (report.conflicts.length) {
              new Notice(`Conflictos:\n${report.conflicts.join('\n')}`, 10000)
            }
            if (report.errors.length) {
              new Notice(`Errores:\n${report.errors.join('\n')}`, 10000)
            }
          })
      )
  }
}
