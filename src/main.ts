import { Plugin, TFile, type CachedMetadata, type WorkspaceLeaf } from 'obsidian'
import { DEFAULT_SETTINGS, type TruelineSettings } from './settings'
import { TaskStore } from './store/TaskStore'
import { ProjectStore } from './store/ProjectStore'
import { ProjectView, PROJECT_VIEW_TYPE } from './views/ProjectView'
import { openTaskModal } from './modals/TaskModal'
import { createTask } from './store/create'
import { GitHubSync, notifyReport, type SyncReport } from './github/sync'
import { TimerService } from './ui/TimerService'
import { TruelineSettingTab } from './settings/SettingsTab'

export default class TruelinePlugin extends Plugin {
  override settings: TruelineSettings = DEFAULT_SETTINGS
  tasks!: TaskStore
  projects!: ProjectStore
  github: GitHubSync | null = null
  timer!: TimerService
  private pollHandle: number | null = null

  override async onload(): Promise<void> {
    await this.loadSettings()

    this.tasks = new TaskStore(this.app, {
      identification: this.settings.identification,
      tasksFolder: this.settings.tasksFolder
    })
    this.projects = new ProjectStore(this.app, () => this.settings)
    this.timer = new TimerService(this.app, this.tasks)

    // The metadata cache is not populated until layout is ready; scanning before that
    // yields an empty vault and a view that looks broken until the first edit.
    this.app.workspace.onLayoutReady(() => {
      this.projects.rebuild()
      this.tasks.rebuild()
      // A session left open by a crash or a force-quit is still recorded in the note,
      // so the timer picks up where it was rather than losing the afternoon.
      this.timer.adoptRunning()
    })

    this.timer.attachStatusBar(this.addStatusBarItem())

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

    this.addRibbonIcon('kanban-square', 'Trueline', () => {
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

    this.github = new GitHubSync(this.app, this.tasks, () => this.settings)

    this.addCommand({
      id: 'toggle-timer',
      name: 'Iniciar o pausar el cronómetro de la nota activa',
      callback: () => void this.timer.toggleActiveFile()
    })

    this.addCommand({
      id: 'stop-timer',
      name: 'Parar el cronómetro',
      callback: () => void this.timer.stop()
    })

    this.addCommand({
      id: 'sync-github',
      name: 'Sincronizar con GitHub',
      callback: () => void this.syncGitHub().then((report) => report && notifyReport(report))
    })

    this.addSettingTab(new TruelineSettingTab(this.app, this))

    this.app.workspace.onLayoutReady(() => {
      this.restartGitHubPolling()
      if (this.settings.github.enabled && this.settings.github.syncOnStartup) {
        void this.syncGitHub()
      }
    })
  }

  override onunload(): void {
    this.stopGitHubPolling()
    this.timer.dispose()
  }

  /**
   * Runs one sync pass. Returns null when GitHub is not configured, so callers can tell
   * "nothing happened because it is off" from "nothing happened because nothing changed".
   */
  async syncGitHub(): Promise<SyncReport | null> {
    const github = this.settings.github
    if (!this.github || !github.enabled) return null
    if (!github.token || github.repos.length === 0) return null

    return this.github.run({
      direction: github.direction,
      conflictPolicy: github.conflictPolicy,
      importNewIssues: github.importNewIssues,
      exportNewTasks: github.exportNewTasks,
      repos: github.repos,
      mapping: github.mapping
    })
  }

  restartGitHubPolling(): void {
    this.stopGitHubPolling()
    const github = this.settings.github
    if (!github.enabled || github.pollSeconds <= 0) return

    // registerInterval hands the timer to Obsidian's lifecycle, so disabling the plugin
    // cannot leave a poller running against someone's rate limit.
    this.pollHandle = window.setInterval(
      () => void this.syncGitHub(),
      Math.max(30, github.pollSeconds) * 1000
    )
    this.registerInterval(this.pollHandle)
  }

  private stopGitHubPolling(): void {
    if (this.pollHandle !== null) {
      window.clearInterval(this.pollHandle)
      this.pollHandle = null
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  /**
   * Reuses the open Trueline tab rather than stacking a new one on every call —
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
