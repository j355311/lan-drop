const elements = {
  networkBadge: document.getElementById('networkBadge'),
  networkLabel: document.getElementById('networkLabel'),
  deviceNameDisplay: document.getElementById('deviceNameDisplay'),
  localAddressDisplay: document.getElementById('localAddressDisplay'),
  receiveDirectoryDisplay: document.getElementById('receiveDirectoryDisplay'),
  dropZone: document.getElementById('dropZone'),
  chooseFilesButton: document.getElementById('chooseFilesButton'),
  fileQueue: document.getElementById('fileQueue'),
  fileCount: document.getElementById('fileCount'),
  clearFilesButton: document.getElementById('clearFilesButton'),
  peerList: document.getElementById('peerList'),
  emptyPeers: document.getElementById('emptyPeers'),
  peerCount: document.getElementById('peerCount'),
  peerAddress: document.getElementById('peerAddress'),
  connectButton: document.getElementById('connectButton'),
  connectError: document.getElementById('connectError'),
  sendButton: document.getElementById('sendButton'),
  sendSummary: document.getElementById('sendSummary'),
  transferList: document.getElementById('transferList'),
  emptyActivity: document.getElementById('emptyActivity'),
  incomingRequests: document.getElementById('incomingRequests'),
  openFolderButton: document.getElementById('openFolderButton'),
  changeFolderButton: document.getElementById('changeFolderButton'),
  appVersionDisplay: document.getElementById('appVersionDisplay'),
  downloadLatestButton: document.getElementById('downloadLatestButton'),
  toast: document.getElementById('toast')
}

const files = new Map()
const transfers = new Map()
const incomingRequests = new Map()
let appState = null
let selectedPeerId = null
let sending = false
let toastTimer = null

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`
}

function showToast(message, isError = false) {
  elements.toast.textContent = message
  elements.toast.classList.toggle('toast-error', isError)
  elements.toast.classList.add('toast-visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => elements.toast.classList.remove('toast-visible'), 3500)
}

function setConnectError(message = '') {
  elements.connectError.textContent = message
  elements.connectError.hidden = !message
}

function renderNetwork() {
  if (!appState) return
  const online = Boolean(appState.listenerReady)
  elements.networkBadge.classList.toggle('network-badge-online', online)
  elements.networkBadge.classList.toggle('network-badge-offline', !online)
  elements.networkLabel.textContent = online ? 'Ready on your local network' : 'Local connection unavailable'
  elements.deviceNameDisplay.textContent = appState.deviceName
  const addresses = (appState.localAddresses || []).map((address) => `${address}:${appState.transferPort}`).join('  ·  ')
  elements.localAddressDisplay.textContent = addresses || 'No private IPv4 address found'
  elements.localAddressDisplay.title = addresses
  elements.receiveDirectoryDisplay.textContent = appState.receiveDirectory
  elements.receiveDirectoryDisplay.title = appState.receiveDirectory
  renderPeers()
  renderSendSummary()
}

function createPeerIcon() {
  const wrapper = document.createElement('span')
  wrapper.className = 'peer-device-icon'
  wrapper.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="4" width="17" height="12" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M8 20h8m-4-4v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
  return wrapper
}

function renderPeers() {
  if (!appState) return
  const peers = appState.peers || []
  elements.peerList.replaceChildren()
  elements.peerCount.textContent = `${peers.length} ${peers.length === 1 ? 'computer' : 'computers'}`
  elements.emptyPeers.hidden = peers.length > 0

  for (const peer of peers) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'peer-card'
    button.classList.toggle('peer-card-selected', peer.deviceId === selectedPeerId)
    button.setAttribute('aria-pressed', String(peer.deviceId === selectedPeerId))

    const deviceIcon = createPeerIcon()
    const details = document.createElement('span')
    details.className = 'peer-details'
    const name = document.createElement('strong')
    name.textContent = peer.deviceName
    const address = document.createElement('span')
    address.textContent = `${peer.address}:${peer.port}`
    details.append(name, address)

    const check = document.createElement('span')
    check.className = 'peer-check'
    check.setAttribute('aria-hidden', 'true')
    check.textContent = '✓'
    button.append(deviceIcon, details, check)
    button.addEventListener('click', () => {
      selectedPeerId = peer.deviceId
      renderPeers()
      renderSendSummary()
    })
    elements.peerList.append(button)
  }
}

function renderFiles() {
  elements.fileQueue.replaceChildren()
  const queued = Array.from(files.values())
  elements.fileCount.textContent = `${queued.length} ${queued.length === 1 ? 'file' : 'files'}`
  elements.clearFilesButton.hidden = queued.length === 0

  for (const file of queued) {
    const row = document.createElement('div')
    row.className = 'file-row'
    const icon = document.createElement('span')
    icon.className = 'file-type-icon'
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20V4.5a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 3.5V8h4M9 12h6m-6 3h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
    const details = document.createElement('span')
    details.className = 'file-details'
    const name = document.createElement('strong')
    name.textContent = file.name
    name.title = file.name
    const size = document.createElement('span')
    size.textContent = formatBytes(file.size)
    details.append(name, size)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'remove-file-button'
    remove.setAttribute('aria-label', `Remove ${file.name}`)
    remove.textContent = '×'
    remove.addEventListener('click', () => {
      files.delete(file.path)
      renderFiles()
      renderSendSummary()
    })
    row.append(icon, details, remove)
    elements.fileQueue.append(row)
  }

  renderSendSummary()
}

function renderSendSummary() {
  const peer = (appState?.peers || []).find((candidate) => candidate.deviceId === selectedPeerId)
  const fileCount = files.size
  if (sending) {
    elements.sendSummary.textContent = 'Sending your files…'
  } else if (fileCount && peer) {
    elements.sendSummary.textContent = `${fileCount} ${fileCount === 1 ? 'file' : 'files'} ready for ${peer.deviceName}`
  } else if (fileCount) {
    elements.sendSummary.textContent = 'Choose a computer to receive these files.'
  } else if (peer) {
    elements.sendSummary.textContent = `Choose files to send to ${peer.deviceName}.`
  } else {
    elements.sendSummary.textContent = 'Choose files and a computer to continue.'
  }
  elements.sendButton.disabled = sending || !peer || !fileCount
}

function transferStatusLabel(update) {
  if (update.status === 'waiting') return 'Waiting for them to accept'
  if (update.status === 'sending' || update.status === 'receiving') {
    const percent = update.size ? Math.min(100, Math.round((update.transferred / update.size) * 100)) : 100
    return `Transferring · ${percent}%`
  }
  if (update.status === 'completed') return update.direction === 'incoming' ? 'Received' : 'Sent'
  if (update.status === 'declined') return 'Declined'
  if (update.status === 'failed') return 'Transfer failed'
  return update.status || 'Transfer'
}

function renderTransfers() {
  const updates = Array.from(transfers.values()).slice(-8).reverse()
  elements.transferList.replaceChildren()
  if (!updates.length) {
    const empty = document.createElement('div')
    empty.className = 'empty-activity'
    empty.textContent = 'Your transfers will appear here.'
    elements.transferList.append(empty)
    return
  }

  for (const update of updates) {
    const row = document.createElement('div')
    row.className = 'transfer-row'
    const icon = document.createElement('span')
    icon.className = `transfer-icon transfer-icon-${update.status}`
    icon.textContent = update.status === 'completed' ? '✓' : update.status === 'failed' ? '!' : '↕'
    const details = document.createElement('span')
    details.className = 'transfer-details'
    const name = document.createElement('strong')
    name.textContent = update.fileName || 'File'
    name.title = update.fileName || ''
    const meta = document.createElement('span')
    const direction = update.direction === 'incoming' ? 'From' : 'To'
    meta.textContent = `${direction} ${update.peerName || 'computer'} · ${formatBytes(update.size)}`
    details.append(name, meta)
    const status = document.createElement('span')
    status.className = `transfer-status transfer-status-${update.status}`
    status.textContent = transferStatusLabel(update)
    row.append(icon, details, status)
    if (update.status === 'sending' || update.status === 'receiving') {
      const progress = document.createElement('div')
      progress.className = 'transfer-progress'
      const bar = document.createElement('span')
      const percent = update.size ? Math.min(100, (update.transferred / update.size) * 100) : 100
      bar.style.width = `${percent}%`
      progress.append(bar)
      row.append(progress)
    }
    elements.transferList.append(row)
  }
}

function addFiles(newFiles) {
  for (const file of newFiles) {
    if (!file?.path || !file.name) continue
    files.set(file.path, { path: file.path, name: file.name, size: Number(file.size) || 0 })
  }
  renderFiles()
}

async function addDroppedFiles(fileList) {
  const droppedFiles = []
  for (const file of Array.from(fileList || [])) {
    try {
      const filePath = window.lanDrop.getPathForFile(file)
      if (filePath) droppedFiles.push({ path: filePath, name: file.name, size: file.size })
    } catch {}
  }
  addFiles(droppedFiles)
  if (!droppedFiles.length && fileList.length) showToast('That item could not be added. Try choosing a file.', true)
}

async function selectFiles() {
  try {
    addFiles(await window.lanDrop.selectFiles())
  } catch (error) {
    showToast(error.message, true)
  }
}

async function sendQueuedFiles() {
  if (sending || !selectedPeerId || files.size === 0) return
  sending = true
  renderSendSummary()
  const filePaths = Array.from(files.keys())
  try {
    const result = await window.lanDrop.sendFiles(selectedPeerId, filePaths)
    if (result.succeeded === result.attempted) showToast('Files sent successfully.')
    else if (result.succeeded > 0) showToast(`${result.succeeded} of ${result.attempted} files sent.`)
    else showToast('No files were sent. Check the transfer status below.', true)
    if (result.successfulPaths?.length) {
      for (const filePath of result.successfulPaths) files.delete(filePath)
      renderFiles()
    }
  } catch (error) {
    showToast(error.message, true)
  } finally {
    sending = false
    renderSendSummary()
  }
}

function createIncomingCard(incoming) {
  const card = document.createElement('article')
  card.className = 'incoming-card'
  card.dataset.transferId = incoming.transferId
  const heading = document.createElement('div')
  heading.className = 'incoming-heading'
  const icon = document.createElement('span')
  icon.className = 'incoming-icon'
  icon.textContent = '↓'
  const copy = document.createElement('div')
  const title = document.createElement('strong')
  title.textContent = 'Incoming file'
  const sender = document.createElement('span')
  sender.textContent = `${incoming.senderDeviceName} wants to send a file`
  copy.append(title, sender)
  heading.append(icon, copy)
  const file = document.createElement('div')
  file.className = 'incoming-file'
  const fileName = document.createElement('strong')
  fileName.textContent = incoming.fileName
  const size = document.createElement('span')
  size.textContent = formatBytes(incoming.size)
  file.append(fileName, size)
  const actions = document.createElement('div')
  actions.className = 'incoming-actions'
  const decline = document.createElement('button')
  decline.type = 'button'
  decline.className = 'button button-secondary'
  decline.textContent = 'Decline'
  decline.addEventListener('click', () => respondToIncoming(incoming.transferId, false))
  const accept = document.createElement('button')
  accept.type = 'button'
  accept.className = 'button button-primary'
  accept.textContent = 'Accept file'
  accept.addEventListener('click', () => respondToIncoming(incoming.transferId, true))
  actions.append(decline, accept)
  card.append(heading, file, actions)
  return card
}

async function respondToIncoming(transferId, accepted) {
  const request = incomingRequests.get(transferId)
  if (!request) return
  incomingRequests.delete(transferId)
  request.remove()
  try {
    await window.lanDrop.respondToIncoming(transferId, accepted)
  } catch (error) {
    showToast(error.message, true)
  }
}

async function connectByAddress() {
  setConnectError('')
  const value = elements.peerAddress.value.trim()
  if (!value) {
    setConnectError('Enter the address shown on the other computer.')
    return
  }
  elements.connectButton.disabled = true
  elements.connectButton.textContent = 'Connecting…'
  try {
    const peer = await window.lanDrop.addPeer(value)
    selectedPeerId = peer.deviceId
    elements.peerAddress.value = ''
    showToast(`Connected to ${peer.deviceName}.`)
  } catch (error) {
    setConnectError(error.message)
  } finally {
    elements.connectButton.disabled = false
    elements.connectButton.textContent = 'Connect'
    renderNetwork()
  }
}

elements.chooseFilesButton.addEventListener('click', selectFiles)
elements.dropZone.addEventListener('click', (event) => {
  if (event.target.closest('button')) return
  selectFiles()
})
elements.dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    selectFiles()
  }
})
elements.dropZone.addEventListener('dragover', (event) => {
  event.preventDefault()
  elements.dropZone.classList.add('drop-zone-active')
})
elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('drop-zone-active'))
elements.dropZone.addEventListener('drop', (event) => {
  event.preventDefault()
  elements.dropZone.classList.remove('drop-zone-active')
  addDroppedFiles(event.dataTransfer.files)
})
elements.clearFilesButton.addEventListener('click', () => {
  files.clear()
  renderFiles()
})
elements.sendButton.addEventListener('click', sendQueuedFiles)
elements.connectButton.addEventListener('click', connectByAddress)
elements.peerAddress.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') connectByAddress()
})
elements.openFolderButton.addEventListener('click', async () => {
  const error = await window.lanDrop.openReceiveFolder()
  if (error) showToast(error, true)
})
elements.changeFolderButton.addEventListener('click', async () => {
  try {
    await window.lanDrop.chooseReceiveFolder()
  } catch (error) {
    showToast(error.message, true)
  }
})
elements.downloadLatestButton.addEventListener('click', async () => {
  try {
    const result = await window.lanDrop.downloadLatest()
    if (result.ok) {
      showToast('Opening the latest app download.')
    } else {
      showToast(result.message, true)
    }
  } catch (error) {
    showToast(error.message, true)
  }
})

window.lanDrop.onState((newState) => {
  appState = newState
  if (selectedPeerId && !(newState.peers || []).some((peer) => peer.deviceId === selectedPeerId)) {
    selectedPeerId = null
  }
  renderNetwork()
})

window.lanDrop.onIncoming((incoming) => {
  const card = createIncomingCard(incoming)
  incomingRequests.set(incoming.transferId, card)
  elements.incomingRequests.prepend(card)
})

window.lanDrop.onTransfer((update) => {
  transfers.set(update.transferId, { ...transfers.get(update.transferId), ...update })
  if (update.status === 'declined') {
    incomingRequests.get(update.transferId)?.remove()
    incomingRequests.delete(update.transferId)
  }
  renderTransfers()
})

window.lanDrop.getState().then((initialState) => {
  appState = initialState
  renderNetwork()
}).catch((error) => showToast(error.message, true))

window.lanDrop.getAppInfo().then((info) => {
  elements.appVersionDisplay.textContent = `Version ${info.version}`
  elements.downloadLatestButton.disabled = !info.latestDownloadAvailable
  if (!info.latestDownloadAvailable) {
    elements.downloadLatestButton.title = 'Update downloads will be enabled when the public release is configured.'
  }
}).catch((error) => showToast(error.message, true))

renderFiles()
