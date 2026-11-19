import { setTimeout } from 'node:timers/promises'

async function agentLoaded(run, target) {
  try {
    await run('print', target)
    return true
  } catch (error) {
    if (error.code !== 113) throw error
    return false
  }
}

export async function stopMacAgent({ command, domain, label, pause = setTimeout }) {
  const target = `${domain}/${label}`
  const run = (...args) => command('/bin/launchctl', args)
  if (await agentLoaded(run, target)) {
    await run('bootout', target).catch(error => {
      if (error.code !== 3 && error.code !== 113) throw error
    })
    for (let attempt = 0; await agentLoaded(run, target); attempt++) {
      if (attempt === 19) throw new Error('旧的摸鱼派后台服务未能及时卸载，请稍后再次运行安装器。')
      await pause(250)
    }
  }
}

export async function restartMacAgent({ command, domain, label, plistPath, updatePlist, pause = setTimeout }) {
  const target = `${domain}/${label}`
  const run = (...args) => command('/bin/launchctl', args)
  await stopMacAgent({ command, domain, label, pause })
  await updatePlist()

  for (let attempt = 0; ; attempt++) {
    try {
      await run('bootstrap', domain, plistPath)
      return
    } catch (error) {
      if (error.code !== 5) throw error
      if (await agentLoaded(run, target)) return
      if (attempt === 4) throw error
      await pause(250 * (attempt + 1))
    }
  }
}
