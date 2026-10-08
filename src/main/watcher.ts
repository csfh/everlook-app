import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { worldFileKey } from './watched-files'

export type WorldFileWatcherOptions = {
  stabilityThreshold?: number
  pollInterval?: number
  usePolling?: boolean
  interval?: number
}

export function isWatchedWorldFile(filePath: string, selected: string[]): boolean {
  const resolved = path.resolve(filePath)
  if (path.basename(resolved).toLowerCase() !== 'everlook.lua') {
    return false
  }

  const key = worldFileKey(resolved)
  const directory = worldFileKey(path.dirname(resolved))
  return selected.some((candidate) => {
    const wanted = path.resolve(candidate)
    return worldFileKey(wanted) === key || worldFileKey(path.dirname(wanted)) === directory
  })
}

export class WorldFileWatcher {
  private watcher: FSWatcher | null = null
  private selected: string[] = []

  constructor(
    private readonly changed: (filePath: string) => Promise<void>,
    private readonly options: WorldFileWatcherOptions = {}
  ) {}

  async watch(paths: string[], enabled: boolean): Promise<void> {
    await this.close()
    this.selected = [...paths]
    if (!enabled || paths.length === 0) return

    const targets = [...new Set(paths.flatMap((filePath) => [filePath, path.dirname(filePath)]))]
    this.watcher = chokidar.watch(targets, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.options.stabilityThreshold ?? 1500,
        pollInterval: this.options.pollInterval ?? 200
      },
      usePolling: this.options.usePolling ?? true,
      interval: this.options.interval ?? 1000
    })
    const ready = new Promise<void>((resolve, reject) => {
      this.watcher?.once('ready', () => {
        resolve()
      })
      this.watcher?.once('error', reject)
    })
    this.watcher.on('add', (filePath) => {
      this.emit(filePath)
    })
    this.watcher.on('change', (filePath) => {
      this.emit(filePath)
    })
    this.watcher.on('error', (error) => {
      console.error('Everlook file watcher failed.', error)
    })
    await ready
  }

  async close(): Promise<void> {
    if (this.watcher !== null) {
      await this.watcher.close()
      this.watcher = null
    }
  }

  private emit(filePath: string): void {
    if (!isWatchedWorldFile(filePath, this.selected)) {
      return
    }
    void this.changed(filePath).catch((error: unknown) => {
      console.error('Everlook could not queue a world file change.', error)
    })
  }
}
