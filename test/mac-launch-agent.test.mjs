import assert from 'node:assert/strict'
import { test } from 'node:test'
import { restartMacAgent, stopMacAgent } from '../scripts/mac-launch-agent.mjs'

const domain = 'gui/501'
const label = 'com.fishpi.wps.bridge'
const plistPath = '/test/com.fishpi.wps.bridge.plist'
const missing = Object.assign(new Error('service not found'), { code: 113 })
const ioError = Object.assign(new Error('Input/output error'), { code: 5 })

test('waits for the old LaunchAgent to unload and retries a transient bootstrap failure', async () => {
  const steps = []
  const status = [true, true, false, false]
  let bootstraps = 0
  const command = async (bin, args) => {
    assert.equal(bin, '/bin/launchctl')
    steps.push(args.join(' '))
    if (args[0] === 'print' && !status.shift()) throw missing
    if (args[0] === 'bootstrap' && bootstraps++ === 0) throw ioError
  }
  await restartMacAgent({
    command, domain, label, plistPath,
    updatePlist: () => steps.push('update plist'),
    pause: ms => steps.push(`wait ${ms}`),
  })
  assert.deepEqual(steps, [
    `print ${domain}/${label}`, `bootout ${domain}/${label}`,
    `print ${domain}/${label}`, 'wait 250', `print ${domain}/${label}`, 'update plist',
    `bootstrap ${domain} ${plistPath}`, `print ${domain}/${label}`, 'wait 250',
    `bootstrap ${domain} ${plistPath}`,
  ])
})

test('reports a persistent bootstrap failure after bounded retries', async () => {
  let bootstraps = 0
  const command = async (_bin, [action]) => {
    if (action === 'print') throw missing
    assert.equal(action, 'bootstrap')
    bootstraps++
    throw ioError
  }
  await assert.rejects(restartMacAgent({
    command, domain, label, plistPath,
    updatePlist: () => {}, pause: () => {},
  }), ioError)
  assert.equal(bootstraps, 5)
})

test('stopping an agent is safe when launchd removes it between print and bootout', async () => {
  let statusChecks = 0
  const command = async (_bin, [action]) => {
    if (action === 'bootout') throw Object.assign(new Error('No such process'), { code: 3 })
    if (++statusChecks === 2) throw missing
  }
  await stopMacAgent({ command, domain, label })
  assert.equal(statusChecks, 2)
})
