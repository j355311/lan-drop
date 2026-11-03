const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('lanDrop', {
  getState: () => ipcRenderer.invoke('lan-drop:get-state'),
  getNotes: () => ipcRenderer.invoke('lan-drop:get-notes'),
  getAppInfo: () => ipcRenderer.invoke('lan-drop:get-app-info'),
  checkForUpdates: () => ipcRenderer.invoke('lan-drop:check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('lan-drop:install-update'),
  selectFiles: () => ipcRenderer.invoke('lan-drop:select-files'),
  sendFiles: (deviceId, filePaths) => ipcRenderer.invoke('lan-drop:send-files', { deviceId, filePaths }),
  sendNote: (deviceId, text) => ipcRenderer.invoke('lan-drop:send-note', { deviceId, text }),
  readClipboardText: () => ipcRenderer.invoke('lan-drop:clipboard-read-text'),
  writeClipboardText: (text) => ipcRenderer.invoke('lan-drop:clipboard-write-text', text),
  respondToIncoming: (transferId, accepted) => ipcRenderer.invoke('lan-drop:respond-to-incoming', { transferId, accepted }),
  chooseReceiveFolder: () => ipcRenderer.invoke('lan-drop:choose-receive-folder'),
  openReceiveFolder: () => ipcRenderer.invoke('lan-drop:open-receive-folder'),
  setDeviceName: (value) => ipcRenderer.invoke('lan-drop:set-device-name', value),
  addPeer: (value) => ipcRenderer.invoke('lan-drop:add-peer', value),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onState: (callback) => ipcRenderer.on('lan-drop:state', (_event, state) => callback(state)),
  onNotes: (callback) => ipcRenderer.on('lan-drop:notes', (_event, notes) => callback(notes)),
  onUpdateStatus: (callback) => ipcRenderer.on('lan-drop:update-status', (_event, status) => callback(status)),
  onIncoming: (callback) => ipcRenderer.on('lan-drop:incoming', (_event, incoming) => callback(incoming)),
  onTransfer: (callback) => ipcRenderer.on('lan-drop:transfer', (_event, update) => callback(update))
})
