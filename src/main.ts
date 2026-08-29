import { Plugin, TFile, type CachedMetadata, type WorkspaceLeaf } from 'obsidian'
import { DEFAULT_SETTINGS, type ProjectNotesSettings } from './settings'
import { TaskStore } from './store/TaskStore'
import { ProjectStore } from './store/ProjectStore'
import { ProjectView, PROJECT_VIEW_TYPE } from './views/ProjectView'
import { openTaskModal } from './modals/TaskModal'
import { createTask } from './store/create'

export default class ProjectNotesPlugin extends Plugin {
  override settings: ProjectNotesSettings = DEFAULT_SETTINGS
  tasks!: TaskStore
  projects!: ProjectStore

  override async onload(): Promise<void> {
    await this.loadSettings()

    this.tasks = new TaskStore(this.app, {
      identification: this.settings.identification,
      tasksFolder: this.settings.tasksFolder
    })
    this.projects = new ProjectStore(this.app, () => this.settings)

    // The metadata cache is not populated until layout is ready; scanning before that
    // yields an empty vault and a view that looks broken until the first edit.
    this.app.workspace.onLayoutReady(() => {
      this.projects.rebuild()
      this.tasks.rebuild()
    })

    this.registerEvent(
      this.app.metadataCache.on('changed', (file: TFile, data: string, cache: CachedMetadata) => {
        this.tasks.onFileChanged(file, data, cache)
        this.projects.rebuild()
      })
    )
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        this.tasks.onFileDeleted(file.path)
        this.projects.rebuild()
      })
    )
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) this.tasks.onFileRenamed(file, oldPath)
        this.projects.rebuild()
      })
    )

    this.registerView(PROJECT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ProjectView(leaf, this))

    this.addRibbonIcon('kanban-square', 'ProjectNotes', () => {
      void this.activateProjectView()
    })

    this.addCommand({
      id: 'open-project-view',
      name: 'Abrir vista de proyectos',
      callback: () => void this.activateProjectView()
    })

    this.addCommand({
      id: 'create-task',
      name: 'Crear tarea',
      callback: () => void this.createAndOpenTask()
    })
  }

  override onunload(): void {
    // Views are torn down by Obsidian; the store holds no resources of its own.
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  /**
   * Reuses the open ProjectNotes tab rather than stacking a new one on every call —
   * the behaviour Obsidian only gives you if you ask for it explicitly.
   */
  async activateProjectView(): Promise<void> {
    const { workspace } = this.app
    const existing = workspace.getLeavesOfType(PROJECT_VIEW_TYPE)[0]
    if (existing) {
      workspace.setActiveLeaf(existing, { focus: true })
      await workspace.revealLeaf(existing)
      return
    }
    const leaf = workspace.getLeaf('tab')
    await leaf.setViewState({ type: PROJECT_VIEW_TYPE, active: true })
    await workspace.revealLeaf(leaf)
  }

  private async createAndOpenTask(): Promise<void> {
    const file = await createTask(this.app, this.settings, {})
    const task = this.tasks.get(file.path)
    if (!task) return
    if (this.settings.openTasksIn === 'tab') {
      await this.app.workspace.getLeaf(false).openFile(file)
    } else {
      openTaskModal(this, task)
    }
  }
}
