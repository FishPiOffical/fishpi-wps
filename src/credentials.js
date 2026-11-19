import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import lockfile from 'proper-lockfile'

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

async function writeJson(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export function localCredentials(directory = process.env.FISHPI_WPS_DATA_DIR || join(homedir(), '.fishpi-wps')) {
  const dir = resolve(directory)
  const accountPath = join(dir, 'account.json')
  const preferencesPath = join(dir, 'preferences.json')

  async function exclusive(operation) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(dir, 0o700)
    // Lock the directory so the records can be replaced atomically.
    const release = await lockfile.lock(dir, {
      stale: 30_000,
      update: 5_000,
      retries: { retries: 40, minTimeout: 100, maxTimeout: 1_000 },
    })
    try {
      return await operation()
    } finally {
      await release()
    }
  }

  async function preferences() {
    const stored = await readJson(preferencesPath)
    return {
      mode: stored?.mode === 'plain' ? 'plain' : 'rich',
      notifications: stored?.notifications === true,
    }
  }

  return {
    async read() {
      const account = await readJson(accountPath)
      if (account?.remember === true && typeof account.sessionId === 'string'
        && typeof account.accessToken === 'string' && typeof account.refreshCookie === 'string'
        && typeof account.user?.id === 'string') return account
      return undefined
    },
    write: account => writeJson(accountPath, account),
    remove: () => rm(accountPath, { force: true }),
    exclusive,
    preferences,
    updatePreferences: patch => exclusive(async () => {
      const next = { ...await preferences(), ...patch }
      await writeJson(preferencesPath, next)
      return next
    }),
  }
}
