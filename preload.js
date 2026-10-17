const { contextBridge, ipcRenderer } = require('electron');
ipcRenderer.send('diagnostics:log', 'preload.js started');

// If renderer initialization ever fails, replace the silent blank box with a
// useful diagnostic. This runs independently from renderer/app.js.
window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send('diagnostics:log', 'DOMContentLoaded reached in preload');
  setTimeout(() => {
    if (document.documentElement.dataset.sshNexusBooted === '1') {
      ipcRenderer.send('diagnostics:log', 'renderer boot marker detected');
      return;
    }
    ipcRenderer.send('diagnostics:log', 'renderer boot marker MISSING');
    const box = document.getElementById('unlockBox');
    if (box) box.innerHTML = '<h3>画面の起動に失敗しました</h3><div class="error">renderer/app.js を実行できませんでした。診断ログ: %APPDATA%\\ssh-nexus\\startup.log</div>';
  }, 2500);
});

contextBridge.exposeInMainWorld('api', {
  diagnostics: {
    log: (message) => ipcRenderer.send('diagnostics:log', message)
  },
  notification: {
    show: (title, body) => ipcRenderer.send('notification:show', title, body)
  },
  i18n: {
    settings: () => ipcRenderer.invoke('i18n:settings'),
    setLocale: (locale) => ipcRenderer.invoke('i18n:setLocale', locale)
  },
  recordings: {
    settings: () => ipcRenderer.invoke('recordings:settings'),
    chooseDirectory: () => ipcRenderer.invoke('recordings:chooseDirectory'),
    openDirectory: () => ipcRenderer.invoke('recordings:openDirectory'),
    save: (name, content) => ipcRenderer.invoke('recordings:save', name, content),
    list: () => ipcRenderer.invoke('recordings:list'),
    read: (name) => ipcRenderer.invoke('recordings:read', name),
    remove: (name) => ipcRenderer.invoke('recordings:delete', name),
    importFile: () => ipcRenderer.invoke('recordings:import')
  },
  security: {
    onLocked: (cb) => ipcRenderer.on('security:locked', (e, reason) => cb(reason))
  },
  external: {
    onConnectRequest: (cb) => ipcRenderer.on('external:connectRequest', (e, request) => cb(request))
  },
  audit: {
    list: (limit) => ipcRenderer.invoke('audit:list', limit),
    clear: () => ipcRenderer.invoke('audit:clear'),
    export: () => ipcRenderer.invoke('audit:export')
  },
  vault: {
    exists: () => ipcRenderer.invoke('vault:exists'),
    securityInfo: () => ipcRenderer.invoke('vault:securityInfo'),
    setup: (recoveryPassphrase) => ipcRenderer.invoke('vault:setup', recoveryPassphrase),
    unlock: (secret) => ipcRenderer.invoke('vault:unlock', secret),
    migrateSecurity: (recoveryPassphrase) => ipcRenderer.invoke('vault:migrateSecurity', recoveryPassphrase),
    lock: () => ipcRenderer.invoke('vault:lock'),
    isUnlocked: () => ipcRenderer.invoke('vault:isUnlocked'),
    list: () => ipcRenderer.invoke('vault:list'),
    get: (id) => ipcRenderer.invoke('vault:get', id),
    add: (conn) => ipcRenderer.invoke('vault:add', conn),
    update: (id, patch) => ipcRenderer.invoke('vault:update', id, patch),
    remove: (id) => ipcRenderer.invoke('vault:remove', id),
    changePin: (oldPin, newPin) => ipcRenderer.invoke('vault:changePin', oldPin, newPin),
    export: () => ipcRenderer.invoke('vault:export'),
    backup: () => ipcRenderer.invoke('vault:backup'),
    restore: () => ipcRenderer.invoke('vault:restore')
  },
  secureData: {
    get: (key) => ipcRenderer.invoke('secureData:get', key),
    set: (key, value) => ipcRenderer.invoke('secureData:set', key, value),
    remove: (key) => ipcRenderer.invoke('secureData:delete', key)
  },
  migration: {
    puttySessions: () => ipcRenderer.invoke('migration:puttySessions'),
    parseOpenSsh: (content) => ipcRenderer.invoke('migration:parseOpenSsh', content)
  },
  knownHosts: {
    list: () => ipcRenderer.invoke('knownHosts:list'),
    remove: (identity) => ipcRenderer.invoke('knownHosts:remove', identity)
  },
  sshConfig: {
    export: () => ipcRenderer.invoke('sshConfig:export')
  },
  dialog: {
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
    saveText: (defaultName, content) => ipcRenderer.invoke('dialog:saveText', defaultName, content)
  },
  fs: {
    readFile: (p) => ipcRenderer.invoke('fs:readFile', p)
  },
  ssh: {
    connect: (id) => ipcRenderer.invoke('ssh:connect', id),
    connectAdhoc: (opts) => ipcRenderer.invoke('ssh:connectAdhoc', opts),
    test: (request) => ipcRenderer.invoke('ssh:test', request),
    write: (id, data) => ipcRenderer.send('ssh:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('ssh:resize', id, cols, rows),
    disconnect: (id) => ipcRenderer.invoke('ssh:disconnect', id),
    list: () => ipcRenderer.invoke('ssh:list'),
    generateKeyPair: (options) => ipcRenderer.invoke('ssh:keygen', options),
    exec: (id, command, timeoutMs) => ipcRenderer.invoke('ssh:exec', id, command, timeoutMs),
    monitor: (id) => ipcRenderer.invoke('ssh:monitor', id),
    respondChallenge: (token, answers) => ipcRenderer.invoke('ssh:respondChallenge', token, answers),
    onData: (cb) => ipcRenderer.on('ssh:data', (e, id, data) => cb(id, data)),
    onExit: (cb) => ipcRenderer.on('ssh:exit', (e, id, code) => cb(id, code)),
    onError: (cb) => ipcRenderer.on('ssh:error', (e, id, msg) => cb(id, msg)),
    onStatus: (cb) => ipcRenderer.on('ssh:status', (e, id, stage, msg) => cb(id, stage, msg)),
    onChallenge: (cb) => ipcRenderer.on('ssh:challenge', (e, token, challenge) => cb(token, challenge))
  },
  sftp: {
    list: (id, remotePath) => ipcRenderer.invoke('sftp:list', id, remotePath),
    stat: (id, remotePath) => ipcRenderer.invoke('sftp:stat', id, remotePath),
    cancel: (id) => ipcRenderer.invoke('sftp:cancel', id),
    upload: (id, remoteDir, verify) => ipcRenderer.invoke('sftp:upload', id, remoteDir, !!verify),
    download: (id, remotePath, verify) => ipcRenderer.invoke('sftp:download', id, remotePath, !!verify),
    uploadDirectory: (id, remoteDir) => ipcRenderer.invoke('sftp:uploadDirectory', id, remoteDir),
    downloadDirectory: (id, remoteDir) => ipcRenderer.invoke('sftp:downloadDirectory', id, remoteDir),
    readText: (id, remotePath) => ipcRenderer.invoke('sftp:readText', id, remotePath),
    writeText: (id, remotePath, content) => ipcRenderer.invoke('sftp:writeText', id, remotePath, content),
    mkdir: (id, remotePath) => ipcRenderer.invoke('sftp:mkdir', id, remotePath),
    remove: (id, remotePath, isDirectory) => ipcRenderer.invoke('sftp:delete', id, remotePath, isDirectory),
    rename: (id, oldPath, newPath) => ipcRenderer.invoke('sftp:rename', id, oldPath, newPath),
    chmod: (id, remotePath, mode) => ipcRenderer.invoke('sftp:chmod', id, remotePath, mode),
    onProgress: (cb) => ipcRenderer.on('sftp:progress', (e, id, progress) => cb(id, progress))
  },
  tunnel: {
    start: (id, config) => ipcRenderer.invoke('tunnel:start', id, config),
    startRemote: (id, config) => ipcRenderer.invoke('tunnel:startRemote', id, config),
    startSocks: (id, config) => ipcRenderer.invoke('tunnel:startSocks', id, config),
    list: (id) => ipcRenderer.invoke('tunnel:list', id),
    stop: (id, tunnelId) => ipcRenderer.invoke('tunnel:stop', id, tunnelId)
  },
  winhello: {
    status: () => ipcRenderer.invoke('winhello:status'),
    enroll: () => ipcRenderer.invoke('winhello:enroll'),
    verify: () => ipcRenderer.invoke('winhello:verify'),
    unlock: () => ipcRenderer.invoke('winhello:unlock')
  },
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    openRelease: () => ipcRenderer.invoke('updates:openRelease'),
    onAvailable: (cb) => ipcRenderer.on('updates:available', (e, info) => cb(info))
  },
  menu: {
    onAction: (cb) => ipcRenderer.on('menu:action', (e, action) => cb(action))
  }
});
