const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } = require('electron')
const crypto = require('node:crypto')
const dgram = require('node:dgram')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { autoUpdater } = require('electron-updater')

const APP_PROTOCOL = 'lan-drop'
const DEFAULT_TRANSFER_PORT = 48760
const DISCOVERY_PORT = 48761
const DISCOVERY_INTERVAL_MS = 3000
const PEER_TIMEOUT_MS = 12000
const INCOMING_APPROVAL_TIMEOUT_MS = 60000
const MAX_NOTE_BYTES = 256 * 1024
const MAX_NOTE_REQUEST_BYTES = MAX_NOTE_BYTES + 1024

const hasSingleInstance = app.requestSingleInstanceLock()

if (process.platform === 'win32') app.setAppUserModelId('local.landrop')

if (!hasSingleInstance) {
  app.quit()
} else {
  let mainWindow
  let transferServer
  let discoverySocket
  let discoveryTimer
  let peerCleanupTimer
  let transferPort = DEFAULT_TRANSFER_PORT
  let listenerReady = false
  let settings
  let notes = []
  let updateState = { status: 'idle' }
  let updateCheckRunning = false
  let updateRequested = false
  let updateDownloaded = false
  let updatePromptOpen = false
  const peers = new Map()
  const incomingApprovals = new Map()
  const receivedFiles = new Map()
  const clipboardImagePaths = new Set()

  function getSettingsPath() {
    return path.join(app.getPath('userData'), 'settings.json')
  }

  function getNotesPath() {
    return path.join(app.getPath('userData'), 'notes.json')
  }

  function readNotes() {
    try {
      const saved = JSON.parse(fs.readFileSync(getNotesPath(), 'utf8'))
      if (!Array.isArray(saved)) return []
      return saved.filter((note) => note
        && typeof note.id === 'string'
        && typeof note.text === 'string'
        && (note.direction === 'incoming' || note.direction === 'outgoing'))
        .map((note) => ({
          id: note.id,
          text: note.text,
          direction: note.direction,
          peerName: normalizeDeviceName(note.peerName),
          status: typeof note.status === 'string' ? note.status : 'saved',
          createdAt: Number.isFinite(note.createdAt) ? note.createdAt : Date.now()
        }))
    } catch {
      return []
    }
  }

  function writeNotes() {
    const notesPath = getNotesPath()
    fs.mkdirSync(path.dirname(notesPath), { recursive: true })
    fs.writeFileSync(notesPath, JSON.stringify(notes, null, 2), 'utf8')
  }

  function publishNotes() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lan-drop:notes', notes)
    }
  }

  function publishUpdateStatus(status) {
    updateState = status
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lan-drop:update-status', status)
    }
  }

  async function promptToRestartForUpdate(version) {
    if (!mainWindow || mainWindow.isDestroyed() || updatePromptOpen) return
    updatePromptOpen = true
    try {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'LAN Drop update ready',
        message: `LAN Drop ${version} is ready to install.`,
        detail: 'Restart LAN Drop now to install the update? The app will reopen automatically.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      if (result.response === 0) {
        autoUpdater.quitAndInstall(true, true)
      } else {
        updateRequested = false
      }
    } finally {
      updatePromptOpen = false
    }
  }

  function configureAutoUpdater() {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.on('checking-for-update', () => publishUpdateStatus({ status: 'checking' }))
    autoUpdater.on('update-available', (info) => {
      publishUpdateStatus({ status: 'downloading', version: info.version, percent: 0 })
    })
    autoUpdater.on('download-progress', (progress) => {
      publishUpdateStatus({ status: 'downloading', percent: Math.round(progress.percent || 0) })
    })
    autoUpdater.on('update-not-available', (info) => {
      updateRequested = false
      publishUpdateStatus({ status: 'current', version: info.version || app.getVersion() })
    })
    autoUpdater.on('update-downloaded', (info) => {
      updateDownloaded = true
      publishUpdateStatus({ status: 'downloaded', version: info.version })
      if (updateRequested) {
        promptToRestartForUpdate(info.version).catch((error) => {
          updateRequested = false
          publishUpdateStatus({ status: 'error', message: error.message || 'Could not show the restart prompt.' })
        })
      }
    })
    autoUpdater.on('error', (error) => {
      updateRequested = false
      publishUpdateStatus({ status: 'error', message: error.message || 'The update could not be downloaded.' })
    })
  }

  async function checkForUpdates() {
    if (!app.isPackaged) {
      return { ok: false, message: 'Automatic updates work in the installed app.' }
    }
    if (updateDownloaded) {
      return { ok: true, downloaded: true, version: updateState.version }
    }
    if (updateCheckRunning) return { ok: true, inProgress: true }

    updateCheckRunning = true
    updateRequested = true
    publishUpdateStatus({ status: 'checking' })
    try {
      const result = await autoUpdater.checkForUpdates()
      if (!result?.isUpdateAvailable) {
        updateRequested = false
        publishUpdateStatus({ status: 'current', version: app.getVersion() })
        return { ok: true, available: false }
      }
      return { ok: true, available: true, version: result.updateInfo.version }
    } catch (error) {
      updateRequested = false
      const message = error.message || 'Could not check for updates.'
      publishUpdateStatus({ status: 'error', message })
      return { ok: false, message }
    } finally {
      updateCheckRunning = false
    }
  }

  function storeNote(note) {
    notes.unshift(note)
    writeNotes()
    publishNotes()
    return note
  }

  function updateNote(noteId, updates) {
    const note = notes.find((entry) => entry.id === noteId)
    if (!note) return
    Object.assign(note, updates)
    writeNotes()
    publishNotes()
  }

  function normalizeNoteText(value) {
    const text = String(value || '').trim()
    if (!text) throw new Error('Write a note before sending it.')
    if (Buffer.byteLength(text, 'utf8') > MAX_NOTE_BYTES) {
      throw new Error('Notes must be 256 KB or smaller.')
    }
    return text
  }

  function readSettings() {
    const defaultReceiveDirectory = path.join(app.getPath('downloads'), 'LAN Drop')
    const defaults = {
      deviceId: crypto.randomUUID(),
      deviceName: os.hostname().slice(0, 32) || 'My computer',
      receiveDirectory: defaultReceiveDirectory,
      receiveLocations: [{ id: crypto.randomUUID(), path: defaultReceiveDirectory }],
      receivedHistory: []
    }

    try {
      const saved = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'))
      const receiveDirectory = typeof saved.receiveDirectory === 'string' && path.isAbsolute(saved.receiveDirectory)
        ? path.resolve(saved.receiveDirectory)
        : defaultReceiveDirectory
      const receiveLocations = []
      const seenPaths = new Set()
      const seenIds = new Set()
      for (const location of Array.isArray(saved.receiveLocations) ? saved.receiveLocations : []) {
        if (!location || typeof location.path !== 'string' || !path.isAbsolute(location.path)) continue
        const locationPath = path.resolve(location.path)
        const identity = normalizePathForComparison(locationPath)
        if (seenPaths.has(identity)) continue
        const id = typeof location.id === 'string' && location.id && !seenIds.has(location.id)
          ? location.id
          : crypto.randomUUID()
        receiveLocations.push({ id, path: locationPath })
        seenPaths.add(identity)
        seenIds.add(id)
      }
      if (!seenPaths.has(normalizePathForComparison(receiveDirectory))) {
        receiveLocations.unshift({ id: crypto.randomUUID(), path: receiveDirectory })
      }
      const receivedHistory = []
      const receivedTransferIds = new Set()
      for (const file of Array.isArray(saved.receivedHistory) ? saved.receivedHistory : []) {
        if (!file || typeof file.transferId !== 'string' || !file.transferId
          || typeof file.savedPath !== 'string' || !path.isAbsolute(file.savedPath)
          || receivedTransferIds.has(file.transferId)) continue
        const savedPath = path.resolve(file.savedPath)
        receivedHistory.push({
          transferId: file.transferId,
          fileName: path.basename(savedPath),
          savedPath,
          peerName: normalizeDeviceName(file.peerName),
          size: Number.isFinite(file.size) && file.size >= 0 ? file.size : 0,
          receivedAt: Number.isFinite(file.receivedAt) && file.receivedAt > 0 ? file.receivedAt : Date.now()
        })
        receivedTransferIds.add(file.transferId)
        if (receivedHistory.length === 30) break
      }

      return {
        ...defaults,
        ...saved,
        deviceId: typeof saved.deviceId === 'string' ? saved.deviceId : defaults.deviceId,
        deviceName: normalizeDeviceName(saved.deviceName || defaults.deviceName),
        receiveDirectory,
        receiveLocations,
        receivedHistory
      }
    } catch {
      return defaults
    }
  }

  function normalizePathForComparison(value) {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  function writeSettings() {
    fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true })
    fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf8')
  }

  function normalizeDeviceName(value) {
    const normalized = String(value || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32)
    return normalized || os.hostname().slice(0, 32) || 'My computer'
  }

  function decodeHeaderValue(value) {
    try {
      return decodeURIComponent(String(value || ''))
    } catch {
      return String(value || '')
    }
  }

  function isPrivateIPv4(address) {
    if (!net.isIPv4(address)) return false
    const octets = address.split('.').map(Number)
    return octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254)
  }

  function getLocalAddresses() {
    const addresses = new Set()
    for (const adapters of Object.values(os.networkInterfaces())) {
      for (const adapter of adapters || []) {
        if (adapter.family === 'IPv4' && !adapter.internal && isPrivateIPv4(adapter.address)) {
          addresses.add(adapter.address)
        }
      }
    }
    return Array.from(addresses).sort()
  }

  function getActivePeers() {
    const now = Date.now()
    return Array.from(peers.values())
      .filter((peer) => peer.manual || now - peer.lastSeen < PEER_TIMEOUT_MS)
      .sort((first, second) => first.deviceName.localeCompare(second.deviceName))
      .map((peer) => ({
        deviceId: peer.deviceId,
        deviceName: peer.deviceName,
        address: peer.address,
        port: peer.port,
        lastSeen: peer.lastSeen
      }))
  }

  function getAppState() {
    return {
      deviceId: settings.deviceId,
      deviceName: settings.deviceName,
      receiveDirectory: settings.receiveDirectory,
      receiveLocations: settings.receiveLocations.map((location) => ({
        ...location,
        enabled: normalizePathForComparison(location.path) === normalizePathForComparison(settings.receiveDirectory)
      })),
      receivedHistory: settings.receivedHistory.map((file) => ({ ...file })),
      localAddresses: getLocalAddresses(),
      transferPort,
      listenerReady,
      peers: getActivePeers()
    }
  }

  function publishState() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lan-drop:state', getAppState())
    }
  }

  function publishTransfer(update) {
    let historyChanged = false
    if (update.direction === 'incoming' && update.status === 'completed' && update.savedPath) {
      const file = {
        transferId: String(update.transferId),
        fileName: path.basename(update.savedPath),
        savedPath: path.resolve(update.savedPath),
        peerName: normalizeDeviceName(update.peerName),
        size: Number.isFinite(update.size) && update.size >= 0 ? update.size : 0,
        receivedAt: Date.now()
      }
      settings.receivedHistory = [file, ...settings.receivedHistory.filter((entry) => entry.transferId !== file.transferId)].slice(0, 30)
      receivedFiles.set(file.transferId, file.savedPath)
      const retainedTransferIds = new Set(settings.receivedHistory.map((entry) => entry.transferId))
      for (const transferId of receivedFiles.keys()) {
        if (!retainedTransferIds.has(transferId)) receivedFiles.delete(transferId)
      }
      try {
        writeSettings()
      } catch (error) {
        console.error('Could not save received-file history:', error)
      }
      historyChanged = true
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lan-drop:transfer', update)
    }
    if (historyChanged) publishState()
  }

  function sendDiscoveryBeacon() {
    if (!discoverySocket) return
    const message = Buffer.from(JSON.stringify({
      protocol: APP_PROTOCOL,
      type: 'discovery',
      deviceId: settings.deviceId,
      deviceName: settings.deviceName,
      port: transferPort
    }))

    const targets = new Set(['255.255.255.255'])
    for (const adapters of Object.values(os.networkInterfaces())) {
      for (const adapter of adapters || []) {
        if (adapter.family !== 'IPv4' || adapter.internal || !isPrivateIPv4(adapter.address)) continue
        const addressParts = adapter.address.split('.').map(Number)
        const maskParts = (adapter.netmask || '255.255.255.0').split('.').map(Number)
        const broadcast = addressParts.map((part, index) => ((part & maskParts[index]) | (~maskParts[index] & 255))).join('.')
        targets.add(broadcast)
      }
    }

    for (const target of targets) {
      discoverySocket.send(message, DISCOVERY_PORT, target, () => {})
    }
  }

  function startDiscovery() {
    discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    discoverySocket.on('error', () => {
      publishState()
    })
    discoverySocket.on('message', (message, remote) => {
      let beacon
      try {
        beacon = JSON.parse(message.toString('utf8'))
      } catch {
        return
      }

      if (beacon.protocol !== APP_PROTOCOL
        || beacon.type !== 'discovery'
        || typeof beacon.deviceId !== 'string'
        || beacon.deviceId === settings.deviceId
        || !net.isIPv4(remote.address)
        || !isPrivateIPv4(remote.address)
        || !Number.isInteger(beacon.port)
        || beacon.port < 1
        || beacon.port > 65535) {
        return
      }

      const peer = {
        deviceId: beacon.deviceId,
        deviceName: normalizeDeviceName(beacon.deviceName),
        address: remote.address,
        port: beacon.port,
        lastSeen: Date.now()
      }
      peers.set(peer.deviceId, peer)
      publishState()
    })
    discoverySocket.on('listening', () => {
      discoverySocket.setBroadcast(true)
      sendDiscoveryBeacon()
    })
    discoverySocket.bind(DISCOVERY_PORT, '0.0.0.0')
    discoveryTimer = setInterval(sendDiscoveryBeacon, DISCOVERY_INTERVAL_MS)
    peerCleanupTimer = setInterval(() => {
      const now = Date.now()
      let changed = false
      for (const [deviceId, peer] of peers) {
        if (now - peer.lastSeen >= PEER_TIMEOUT_MS) {
          peers.delete(deviceId)
          changed = true
        }
      }
      if (changed) publishState()
    }, 2000)
  }

  function writeJson(response, statusCode, payload) {
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(payload))
  }

  function requestIncomingApproval(requestDetails) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const pending = incomingApprovals.get(requestDetails.transferId)
        if (!pending) return
        incomingApprovals.delete(requestDetails.transferId)
        resolve(false)
      }, INCOMING_APPROVAL_TIMEOUT_MS)

      incomingApprovals.set(requestDetails.transferId, {
        resolve: (accepted) => {
          clearTimeout(timeout)
          incomingApprovals.delete(requestDetails.transferId)
          resolve(accepted)
        }
      })

      if (!mainWindow || mainWindow.isDestroyed()) {
        clearTimeout(timeout)
        incomingApprovals.delete(requestDetails.transferId)
        resolve(false)
        return
      }

      mainWindow.webContents.send('lan-drop:incoming', requestDetails)
    })
  }

  function readRequestBody(request, maxBytes) {
    return new Promise((resolve, reject) => {
      let received = 0
      const chunks = []
      let finished = false

      request.on('data', (chunk) => {
        if (finished) return
        received += chunk.length
        if (received > maxBytes) {
          finished = true
          request.destroy()
          reject(new Error('The incoming note is too large.'))
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        if (finished) return
        finished = true
        resolve(Buffer.concat(chunks))
      })
      request.on('error', (error) => {
        if (finished) return
        finished = true
        reject(error)
      })
    })
  }

  async function handleIncomingNote(request, response) {
    const senderId = request.headers['x-lan-drop-device-id']
    const senderName = normalizeDeviceName(decodeHeaderValue(request.headers['x-lan-drop-device-name']))
    const contentLength = Number(request.headers['content-length'])

    if (request.headers.origin || typeof senderId !== 'string' || !senderId || !Number.isSafeInteger(contentLength)
      || contentLength < 1 || contentLength > MAX_NOTE_REQUEST_BYTES) {
      request.resume()
      writeJson(response, 400, { error: 'Invalid note request.' })
      return
    }

    let noteText
    try {
      const payload = JSON.parse((await readRequestBody(request, MAX_NOTE_REQUEST_BYTES)).toString('utf8'))
      noteText = normalizeNoteText(payload.text)
    } catch (error) {
      if (!response.destroyed) writeJson(response, 400, { error: error.message || 'Invalid note content.' })
      return
    }

    const transferId = crypto.randomUUID()
    const accepted = await requestIncomingApproval({
      transferId,
      type: 'note',
      senderDeviceId: senderId,
      senderDeviceName: senderName,
      text: noteText,
      size: Buffer.byteLength(noteText, 'utf8')
    })

    if (!accepted) {
      writeJson(response, 403, { error: 'The note was declined or timed out.' })
      return
    }

    try {
      const note = storeNote({
        id: crypto.randomUUID(),
        text: noteText,
        direction: 'incoming',
        peerName: senderName,
        status: 'received',
        createdAt: Date.now()
      })
      writeJson(response, 200, { received: true, noteId: note.id })
    } catch {
      writeJson(response, 500, { error: 'The note could not be saved on this computer.' })
    }
  }

  function sanitizeFileName(value) {
    let fileName = path.basename(String(value || 'file'))
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '')
      .trim()

    if (!fileName || fileName === '.' || fileName === '..') fileName = 'file'
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(fileName)) fileName = `_${fileName}`
    return fileName.slice(0, 180)
  }

  function getUniqueDestination(directory, fileName) {
    const safeName = sanitizeFileName(fileName)
    const extension = path.extname(safeName)
    const stem = extension ? safeName.slice(0, -extension.length) : safeName
    let candidate = path.join(directory, safeName)
    let suffix = 1

    while (fs.existsSync(candidate)) {
      candidate = path.join(directory, `${stem} (${suffix})${extension}`)
      suffix += 1
    }
    return candidate
  }

  async function handleIncomingTransfer(request, response) {
    const senderId = request.headers['x-lan-drop-device-id']
    const senderName = normalizeDeviceName(decodeHeaderValue(request.headers['x-lan-drop-device-name']))
    const encodedName = request.headers['x-lan-drop-file-name']
    const contentLength = Number(request.headers['content-length'])

    if (request.headers.origin || typeof senderId !== 'string' || !senderId || typeof encodedName !== 'string') {
      request.resume()
      writeJson(response, 400, { error: 'Invalid transfer request.' })
      return
    }

    let fileName
    try {
      fileName = decodeURIComponent(encodedName)
    } catch {
      request.resume()
      writeJson(response, 400, { error: 'Invalid file name.' })
      return
    }

    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      request.resume()
      writeJson(response, 400, { error: 'Invalid file size.' })
      return
    }

    const transferId = crypto.randomUUID()
    const safeName = sanitizeFileName(fileName)
    const accepted = await requestIncomingApproval({
      transferId,
      senderDeviceId: senderId,
      senderDeviceName: senderName,
      fileName: safeName,
      size: contentLength
    })

    if (!accepted) {
      request.resume()
      writeJson(response, 403, { error: 'Transfer was declined or timed out.' })
      publishTransfer({
        transferId,
        direction: 'incoming',
        fileName: safeName,
        peerName: senderName,
        status: 'declined',
        size: contentLength
      })
      return
    }

    const finalPath = getUniqueDestination(settings.receiveDirectory, safeName)
    const temporaryPath = `${finalPath}.${transferId}.partial`
    let received = 0
    let lastProgressAt = 0

    try {
      await fs.promises.mkdir(settings.receiveDirectory, { recursive: true })
      publishTransfer({
        transferId,
        direction: 'incoming',
        fileName: safeName,
        peerName: senderName,
        status: 'receiving',
        size: contentLength,
        transferred: 0
      })
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length
          const now = Date.now()
          if (now - lastProgressAt >= 150 || received === contentLength) {
            lastProgressAt = now
            publishTransfer({
              transferId,
              direction: 'incoming',
              fileName: safeName,
              peerName: senderName,
              status: 'receiving',
              size: contentLength,
              transferred: received
            })
          }
          callback(null, chunk)
        }
      })
      request.resume()
      await pipeline(request, counter, fs.createWriteStream(temporaryPath, { flags: 'wx' }))

      if (received !== contentLength) {
        throw new Error('The transferred file size did not match the expected size.')
      }

      await fs.promises.rename(temporaryPath, finalPath)
      writeJson(response, 200, { received: true, fileName: path.basename(finalPath) })
      publishTransfer({
        transferId,
        direction: 'incoming',
        fileName: path.basename(finalPath),
        peerName: senderName,
        status: 'completed',
        size: contentLength,
        transferred: received,
        savedPath: finalPath
      })
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {})
      writeJson(response, 500, { error: 'The file could not be saved.' })
      publishTransfer({
        transferId,
        direction: 'incoming',
        fileName: safeName,
        peerName: senderName,
        status: 'failed',
        size: contentLength,
        transferred: received,
        error: error.message
      })
    }
  }

  function sendNote(peer, noteText) {
    const noteId = crypto.randomUUID()
    const body = Buffer.from(JSON.stringify({ text: noteText }), 'utf8')
    storeNote({
      id: noteId,
      text: noteText,
      direction: 'outgoing',
      peerName: peer.deviceName,
      status: 'waiting',
      createdAt: Date.now()
    })

    return new Promise((resolve, reject) => {
      let finished = false
      const finishWithError = (error, status) => {
        if (finished) return
        finished = true
        updateNote(noteId, { status })
        reject(error)
      }

      const outgoingRequest = http.request({
        hostname: peer.address,
        port: peer.port,
        path: '/receive-note',
        method: 'POST',
        timeout: INCOMING_APPROVAL_TIMEOUT_MS + 10000,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': body.length,
          'x-lan-drop-device-id': settings.deviceId,
          'x-lan-drop-device-name': encodeURIComponent(settings.deviceName)
        }
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          let payload = {}
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            payload = {}
          }

          if (response.statusCode >= 200 && response.statusCode < 300) {
            finished = true
            updateNote(noteId, { status: 'sent' })
            resolve({ noteId })
            return
          }

          const status = response.statusCode === 403 ? 'declined' : 'failed'
          finishWithError(new Error(payload.error || `The other computer returned ${response.statusCode}.`), status)
        })
      })

      outgoingRequest.on('error', (error) => finishWithError(error, 'failed'))
      outgoingRequest.on('timeout', () => outgoingRequest.destroy(new Error('The other computer did not respond.')))
      outgoingRequest.end(body)
    })
  }

  function createTransferServer() {
    return http.createServer(async (request, response) => {
      const requestUrl = new URL(request.url || '/', 'http://lan-drop.local')

      if (request.method === 'GET' && requestUrl.pathname === '/health') {
        writeJson(response, 200, {
          protocol: APP_PROTOCOL,
          deviceId: settings.deviceId,
          deviceName: settings.deviceName,
          port: transferPort
        })
        return
      }

      if (request.method === 'POST' && requestUrl.pathname === '/receive') {
        await handleIncomingTransfer(request, response)
        return
      }

      if (request.method === 'POST' && requestUrl.pathname === '/receive-note') {
        await handleIncomingNote(request, response)
        return
      }

      request.resume()
      writeJson(response, 404, { error: 'Not found.' })
    })
  }

  function listenOnPort(port) {
    return new Promise((resolve, reject) => {
      const handleError = (error) => {
        transferServer.removeListener('listening', handleListening)
        reject(error)
      }
      const handleListening = () => {
        transferServer.removeListener('error', handleError)
        resolve(transferServer.address().port)
      }

      transferServer.once('error', handleError)
      transferServer.once('listening', handleListening)
      transferServer.listen(port, '0.0.0.0')
    })
  }

  async function startTransferServer() {
    transferServer = createTransferServer()
    try {
      transferPort = await listenOnPort(DEFAULT_TRANSFER_PORT)
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
      transferServer.close(() => {})
      transferServer = createTransferServer()
      transferPort = await listenOnPort(0)
    }

    listenerReady = true
    transferServer.on('error', () => {
      listenerReady = false
      publishState()
    })
  }

  function sendFile(peer, filePath) {
    return new Promise((resolve, reject) => {
      fs.stat(filePath, (statError, stat) => {
        if (statError) {
          reject(statError)
          return
        }
        if (!stat.isFile()) {
          reject(new Error('Only files can be sent.'))
          return
        }

        const transferId = crypto.randomUUID()
        const fileName = path.basename(filePath)
        let transferred = 0
        let lastProgressAt = 0
        publishTransfer({
          transferId,
          direction: 'outgoing',
          fileName,
          peerName: peer.deviceName,
          status: 'waiting',
          size: stat.size,
          transferred: 0
        })

        let finished = false
        const failTransfer = (error, status = 'failed') => {
          if (finished) return
          finished = true
          error.transferStatusPublished = true
          publishTransfer({
            transferId,
            direction: 'outgoing',
            fileName,
            peerName: peer.deviceName,
            status,
            size: stat.size,
            transferred,
            error: error.message
          })
          reject(error)
        }

        const outgoingRequest = http.request({
          hostname: peer.address,
          port: peer.port,
          path: '/receive',
          method: 'POST',
          timeout: 0,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': stat.size,
            'x-lan-drop-device-id': settings.deviceId,
            'x-lan-drop-device-name': encodeURIComponent(settings.deviceName),
            'x-lan-drop-file-name': encodeURIComponent(fileName)
          }
        }, (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => {
            let payload = {}
            try {
              payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
              payload = {}
            }

            if (response.statusCode >= 200 && response.statusCode < 300) {
              finished = true
              publishTransfer({
                transferId,
                direction: 'outgoing',
                fileName,
                peerName: peer.deviceName,
                status: 'completed',
                size: stat.size,
                transferred: stat.size
              })
              resolve({ fileName, receivedName: payload.fileName || fileName })
            } else {
              const status = response.statusCode === 403 ? 'declined' : 'failed'
              failTransfer(new Error(payload.error || `The other computer returned ${response.statusCode}.`), status)
            }
          })
        })

        outgoingRequest.on('error', failTransfer)
        outgoingRequest.on('timeout', () => outgoingRequest.destroy(new Error('The other computer did not respond.')))

        const fileStream = fs.createReadStream(filePath)
        fileStream.on('data', (chunk) => {
          transferred += chunk.length
          const now = Date.now()
          if (now - lastProgressAt >= 150 || transferred === stat.size) {
            lastProgressAt = now
            publishTransfer({
              transferId,
              direction: 'outgoing',
              fileName,
              peerName: peer.deviceName,
              status: 'sending',
              size: stat.size,
              transferred
            })
          }
        })
        fileStream.on('error', (error) => outgoingRequest.destroy(error))
        fileStream.pipe(outgoingRequest)
      })
    })
  }

  function parsePeerAddress(value) {
    const match = String(value || '').trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/)
    if (!match || !net.isIPv4(match[1]) || !isPrivateIPv4(match[1])) {
      throw new Error('Enter the other computer’s private IPv4 address, with its port if shown.')
    }
    const port = match[2] ? Number(match[2]) : DEFAULT_TRANSFER_PORT
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Enter a valid port number.')
    }
    return { address: match[1], port }
  }

  function probePeer(address, port) {
    return new Promise((resolve, reject) => {
      const request = http.get({ hostname: address, port, path: '/health', timeout: 2500 }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          let payload
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            reject(new Error('That address did not return a LAN Drop response.'))
            return
          }
          if (response.statusCode !== 200 || payload.protocol !== APP_PROTOCOL || !payload.deviceId) {
            reject(new Error('No LAN Drop app was found at that address.'))
            return
          }
          resolve(payload)
        })
      })
      request.on('timeout', () => request.destroy(new Error('The other computer did not respond.')))
      request.on('error', (error) => reject(new Error(error.message || 'Could not reach the other computer.')))
    })
  }

  function createWindow() {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { type: 'separator' },
          { role: 'selectAll' }
        ]
      }
    ]))

    mainWindow = new BrowserWindow({
      width: 1040,
      height: 760,
      minWidth: 780,
      minHeight: 660,
      backgroundColor: '#0b111c',
      title: 'LAN Drop',
      icon: path.join(__dirname, 'assets', 'lan-drop-icon.ico'),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'))
    mainWindow.webContents.on('did-finish-load', () => {
      publishState()
      publishNotes()
      publishUpdateStatus(updateState)
    })
    mainWindow.on('closed', () => {
      mainWindow = null
    })
  }

  ipcMain.handle('lan-drop:get-state', () => getAppState())
  ipcMain.handle('lan-drop:get-notes', () => notes)
  ipcMain.handle('lan-drop:get-app-info', () => ({
    version: app.getVersion(),
    updatesSupported: app.isPackaged
  }))
  ipcMain.handle('lan-drop:check-for-updates', checkForUpdates)
  ipcMain.handle('lan-drop:install-update', () => {
    if (!updateDownloaded) return { ok: false, message: 'There is no downloaded update to install.' }
    autoUpdater.quitAndInstall(true, true)
    return { ok: true }
  })

  ipcMain.handle('lan-drop:clipboard-read-text', () => clipboard.readText())
  ipcMain.handle('lan-drop:clipboard-write-text', (_event, value) => {
    clipboard.writeText(String(value ?? ''))
    return true
  })
  ipcMain.handle('lan-drop:save-clipboard-image', async () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const imageBytes = image.toPNG()
    if (!imageBytes.length) return null
    const filePath = path.join(app.getPath('temp'), `LAN-Drop-clipboard-${crypto.randomUUID()}.png`)
    await fs.promises.writeFile(filePath, imageBytes, { flag: 'wx' })
    clipboardImagePaths.add(filePath)
    return { path: filePath, name: 'Pasted image.png', size: imageBytes.length, temporary: true }
  })
  ipcMain.handle('lan-drop:cleanup-clipboard-image', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !clipboardImagePaths.delete(filePath)) return false
    await fs.promises.unlink(filePath).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
    return true
  })

  ipcMain.handle('lan-drop:select-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return []
    const files = []
    for (const filePath of result.filePaths) {
      try {
        const stat = await fs.promises.stat(filePath)
        if (stat.isFile()) files.push({ path: filePath, name: path.basename(filePath), size: stat.size })
      } catch {}
    }
    return files
  })

  ipcMain.handle('lan-drop:send-files', async (_event, { deviceId, filePaths }) => {
    const peer = peers.get(deviceId)
    if (!peer || (!peer.manual && Date.now() - peer.lastSeen >= PEER_TIMEOUT_MS)) {
      throw new Error('That computer is no longer available. Check that both apps are open.')
    }
    const paths = Array.isArray(filePaths) ? filePaths.slice(0, 50) : []
    if (!paths.length) throw new Error('Add at least one file to send.')
    const successfulPaths = []
    for (const filePath of paths) {
      try {
        await sendFile(peer, filePath)
        successfulPaths.push(filePath)
      } catch (error) {
        if (!error.transferStatusPublished) {
          publishTransfer({
            transferId: crypto.randomUUID(),
            direction: 'outgoing',
            fileName: path.basename(String(filePath)),
            peerName: peer.deviceName,
            status: 'failed',
            error: error.message
          })
        }
      }
    }
    return { attempted: paths.length, succeeded: successfulPaths.length, successfulPaths }
  })

  ipcMain.handle('lan-drop:send-note', async (_event, { deviceId, text }) => {
    const peer = peers.get(deviceId)
    if (!peer || (!peer.manual && Date.now() - peer.lastSeen >= PEER_TIMEOUT_MS)) {
      throw new Error('That computer is no longer available. Check that both apps are open.')
    }
    return sendNote(peer, normalizeNoteText(text))
  })

  ipcMain.handle('lan-drop:respond-to-incoming', (_event, { transferId, accepted }) => {
    const pending = incomingApprovals.get(transferId)
    if (!pending) return false
    pending.resolve(Boolean(accepted))
    return true
  })

  ipcMain.handle('lan-drop:choose-receive-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.receiveDirectory
    })
    if (result.canceled || !result.filePaths[0]) return null
    const chosenPath = path.resolve(result.filePaths[0])
    let location = settings.receiveLocations.find((entry) => (
      normalizePathForComparison(entry.path) === normalizePathForComparison(chosenPath)
    ))
    if (!location) {
      location = { id: crypto.randomUUID(), path: chosenPath }
      settings.receiveLocations.push(location)
    }
    settings.receiveDirectory = location.path
    await fs.promises.mkdir(settings.receiveDirectory, { recursive: true })
    writeSettings()
    publishState()
    return settings.receiveDirectory
  })

  ipcMain.handle('lan-drop:set-receive-location', async (_event, locationId) => {
    const location = settings.receiveLocations.find((entry) => entry.id === String(locationId || ''))
    if (!location) throw new Error('That saved location is no longer available.')
    settings.receiveDirectory = location.path
    await fs.promises.mkdir(settings.receiveDirectory, { recursive: true })
    writeSettings()
    publishState()
    return getAppState()
  })

  async function removeReceiveLocation(locationId) {
    const index = settings.receiveLocations.findIndex((entry) => entry.id === locationId)
    if (index < 0) return false
    if (settings.receiveLocations.length <= 1) return false

    const [removed] = settings.receiveLocations.splice(index, 1)
    if (normalizePathForComparison(removed.path) === normalizePathForComparison(settings.receiveDirectory)) {
      settings.receiveDirectory = settings.receiveLocations[0].path
      await fs.promises.mkdir(settings.receiveDirectory, { recursive: true })
    }
    writeSettings()
    publishState()
    return true
  }

  ipcMain.handle('lan-drop:show-receive-location-menu', (event, locationId) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false
    const location = settings.receiveLocations.find((entry) => entry.id === String(locationId || ''))
    if (!location) return false
    const canRemove = settings.receiveLocations.length > 1
    const menu = Menu.buildFromTemplate([
      {
        label: canRemove ? 'Remove saved location' : 'At least one save location is required',
        enabled: canRemove,
        click: () => {
          removeReceiveLocation(location.id).catch((error) => {
            dialog.showErrorBox('Could not remove saved location', error.message)
          })
        }
      }
    ])
    menu.popup({ window: mainWindow })
    return true
  })

  ipcMain.handle('lan-drop:open-receive-folder', async () => {
    await fs.promises.mkdir(settings.receiveDirectory, { recursive: true })
    return shell.openPath(settings.receiveDirectory)
  })

  ipcMain.handle('lan-drop:show-received-file-menu', async (event, transferId) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false
    const filePath = receivedFiles.get(String(transferId || ''))
    if (!filePath) return false
    try {
      await fs.promises.access(filePath, fs.constants.F_OK)
    } catch {
      return false
    }
    const menu = Menu.buildFromTemplate([
      {
        label: 'Open downloaded file',
        click: async () => {
          const error = await shell.openPath(filePath)
          if (error) dialog.showErrorBox('Could not open file', error)
        }
      },
      { label: 'Open download location', click: () => shell.showItemInFolder(filePath) }
    ])
    menu.popup({ window: mainWindow })
    return true
  })

  ipcMain.handle('lan-drop:set-device-name', (_event, value) => {
    settings.deviceName = normalizeDeviceName(value)
    writeSettings()
    sendDiscoveryBeacon()
    publishState()
    return settings.deviceName
  })

  ipcMain.handle('lan-drop:add-peer', async (_event, value) => {
    const { address, port } = parsePeerAddress(value)
    const result = await probePeer(address, port)
    if (result.deviceId === settings.deviceId) throw new Error('That address points to this computer.')
      const peer = {
      deviceId: result.deviceId,
      deviceName: normalizeDeviceName(result.deviceName),
      address,
      port: result.port || port,
        lastSeen: Date.now(),
        manual: true
    }
    peers.set(peer.deviceId, peer)
    publishState()
    return peer
  })

  app.whenReady().then(async () => {
    settings = readSettings()
    for (const file of settings.receivedHistory) receivedFiles.set(file.transferId, file.savedPath)
    notes = readNotes()
    configureAutoUpdater()
    writeSettings()
    await fs.promises.mkdir(settings.receiveDirectory, { recursive: true })
    await startTransferServer()
    startDiscovery()
    createWindow()
    publishState()
  }).catch((error) => {
    dialog.showErrorBox('LAN Drop could not start', error.message)
    app.quit()
  })

  app.on('before-quit', () => {
    clearInterval(discoveryTimer)
    clearInterval(peerCleanupTimer)
    if (discoverySocket) discoverySocket.close()
    if (transferServer) transferServer.close()
    for (const pending of incomingApprovals.values()) pending.resolve(false)
    incomingApprovals.clear()
    for (const filePath of clipboardImagePaths) {
      try {
        fs.rmSync(filePath, { force: true })
      } catch {}
    }
    clipboardImagePaths.clear()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && listenerReady) createWindow()
  })
}
