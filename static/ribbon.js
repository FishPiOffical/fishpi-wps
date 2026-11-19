(() => {
  const base = new URL('./', window.location.href)
  const paneKey = 'fishpi-wps.chat-pane'
  const application = () => window.Application ?? window.wps
  let pane

  window.OnAddinLoad = () => true
  window.GetFishPiIcon = () => 'assets/icon.png'
  window.VisitFishPi = () => {
    const assistant = application()?.OAAssist
    if (assistant?.ShellExecute) assistant.ShellExecute('https://fishpi.cn')
    else window.open('https://fishpi.cn', '_blank', 'noopener,noreferrer')
    return true
  }
  window.OpenFishPiChat = () => {
    const app = application()
    try {
      const id = app.PluginStorage?.getItem(paneKey)
      if (id) pane = app.GetTaskPane(id)
      if (pane) {
        pane.Visible = true
        return true
      }
    } catch {
      pane = undefined
    }
    try {
      pane = app.CreateTaskPane(new URL('taskpane.html', base).href)
      const position = app.Enum?.JSKsoEnum_msoCTPDockPositionRight ?? app.Enum?.msoCTPDockPositionRight
      if (position !== undefined) pane.DockPosition = position
      pane.Width = 420
      if (pane.ID !== undefined) app.PluginStorage?.setItem(paneKey, pane.ID)
      pane.Visible = true
      return true
    } catch {
      app?.alert?.('无法打开摸鱼派任务窗格，请检查本机摸鱼派服务。')
      return false
    }
  }
})()
