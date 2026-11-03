const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('lanDrop', {
  getState: () => ipcRenderer.invoke('lan-drop:get-state'),
  getAppInfo: () => ipcRenderer.invoke('lan-drop:get-app-info'),
  downloadLatest: () => ipcRenderer.invoke('lan-drop:download-latest'),
  selectFiles: () => ipcRenderer.invoke('lan-drop:select-files'),
  sendFiles: (deviceId, filePaths) => ipcRenderer.invoke('lan-drop:send-files', { deviceId, filePaths }),
  respondToIncoming: (transferId, accepted) => ipcRenderer.invoke('lan-drop:respond-to-incoming', { transferId, accepted }),
  chooseReceiveFolder: () => ipcRenderer.invoke('lan-drop:choose-receive-folder'),
  openReceiveFolder: () => ipcRenderer.invoke('lan-drop:open-receive-folder'),
  setDeviceName: (value) => ipcRenderer.invoke('lan-drop:set-device-name', value),
  addPeer: (value) => ipcRenderer.invoke('lan-drop:add-peer', value),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onState: (callback) => ipcRenderer.on('lan-drop:state', (_event, state) => callback(state)),
  onIncoming: (callback) => ipcRenderer.on('lan-drop:incoming', (_event, incoming) => callback(incoming)),
  onTransfer: (callback) => ipcRenderer.on('lan-drop:transfer', (_event, update) => callback(update))
})
