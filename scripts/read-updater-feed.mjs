import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
// Use the same YAML parser dependency as electron-updater, including quoted keys and aliases.
const require = createRequire(import.meta.url)
const updaterRequire = createRequire(require.resolve('electron-updater/package.json'))
const yaml = updaterRequire('js-yaml')
const feed = yaml.load(await readFile(process.argv[2], 'utf8'), { schema: yaml.JSON_SCHEMA })
process.stdout.write(JSON.stringify(feed))
