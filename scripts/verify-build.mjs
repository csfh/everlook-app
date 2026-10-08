import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { stdout } from 'node:process'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererDirectory = path.join(projectRoot, 'out', 'renderer')
const rendererEntry = path.join(rendererDirectory, 'index.html')

const html = await readFile(rendererEntry, 'utf8')
const assetReferences = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1])

if (assetReferences.length === 0) {
  throw new Error('The packaged renderer entry does not reference any assets.')
}

for (const reference of assetReferences) {
  const assetUrl = new URL(reference, pathToFileURL(rendererEntry))
  if (assetUrl.protocol !== 'file:') {
    throw new Error(`Renderer asset does not resolve under file://: ${reference}`)
  }

  const assetPath = fileURLToPath(assetUrl)
  const relativeAssetPath = path.relative(rendererDirectory, assetPath)
  if (relativeAssetPath.startsWith('..') || path.isAbsolute(relativeAssetPath)) {
    throw new Error(`Renderer asset resolves outside the packaged renderer: ${reference}`)
  }

  await access(assetPath)
}

const preloadEntry = path.join(projectRoot, 'out', 'preload', 'index.cjs')
const preload = await readFile(preloadEntry, 'utf8')
if (/^\s*(?:import|export)\s/m.test(preload)) {
  throw new Error('The sandboxed preload entry contains unsupported ESM syntax.')
}

const mainEntry = await readFile(path.join(projectRoot, 'out', 'main', 'index.js'), 'utf8')
if (!mainEntry.includes('../preload/index.cjs')) {
  throw new Error('The main process does not load the packaged CommonJS preload entry.')
}
if (/import\s*\{[^}]*\bautoUpdater\b[^}]*\}\s*from\s*["']electron-updater["']/.test(mainEntry)) {
  throw new Error(
    'electron-updater is CommonJS. Named ESM imports of autoUpdater crash the packaged AppImage on launch.'
  )
}

stdout.write(`Verified ${assetReferences.length} renderer assets and the sandboxed preload entry.\n`)
