import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const dataDir = process.env.FISHPI_WPS_DATA_DIR || join(homedir(), '.fishpi-wps')
export const defaultPort = 36796

export function originFor(port) {
  return `http://127.0.0.1:${port}`
}

export function addinUrl({ port, token }) {
  return `${originFor(port)}/${token}/`
}

const configPath = join(dataDir, 'bridge.json')

export async function readBridgeConfig() {
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    if (!/^[a-f0-9]{64}$/u.test(config?.token)
      || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
      throw Object.assign(new Error('本地摸鱼派服务配置无效'), { code: 'INVALID_BRIDGE_CONFIG' })
    }
    return config
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

export async function bridgeConfig() {
  const existing = await readBridgeConfig()
  if (existing) return existing
  const port = Number(process.env.FISHPI_WPS_PORT || defaultPort)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本地服务端口无效')
  const config = { port, token: randomBytes(32).toString('hex') }
  await mkdir(dataDir, { mode: 0o700, recursive: true })
  if (process.platform !== 'win32') await chmod(dataDir, 0o700)
  try {
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') {
      const concurrent = await readBridgeConfig()
      if (concurrent) return concurrent
    }
    throw error
  }
  return config
}
