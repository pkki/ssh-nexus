const { app, BrowserWindow, ipcMain, dialog, safeStorage, Menu, Notification, powerMonitor, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const https = require('https');
const dns = require('dns').promises;
const { execFile } = require('child_process');
const { Vault } = require('./vault');
const { SshManager } = require('./sshManager');
const { parseExternalConnect } = require('./externalConnect');
const { buildJumpChain } = require('./jumpChain');
const { parseOpenSshConfig } = require('./openSshConfig');

let mainWindow = null;
let vault = null;
let ssh = null;
let pendingExternalConnect = null;
let latestUpdateInfo = null;

function dispatchExternalConnect(request){if(!request)return;pendingExternalConnect=request;if(mainWindow&&!mainWindow.isDestroyed()&&!mainWindow.webContents.isLoading()){mainWindow.webContents.send('external:connectRequest',request);pendingExternalConnect=null;mainWindow.show();mainWindow.focus();}}

const singleInstanceLock=app.requestSingleInstanceLock();
if(!singleInstanceLock)app.quit();
else app.on('second-instance',(event,argv)=>dispatchExternalConnect(parseExternalConnect(argv)));
app.on('open-url',(event,url)=>{event.preventDefault();dispatchExternalConnect(parseExternalConnect([url]));});

function userData() { return app.getPath('userData'); }
const supportedLocales=['ja','en','zh-CN','ko','es','fr','de','pt-BR'];
function normalizeUiLocale(raw){const v=String(raw||'').replace('_','-').toLowerCase();if(v.startsWith('ja'))return'ja';if(v.startsWith('zh'))return'zh-CN';if(v.startsWith('ko'))return'ko';if(v.startsWith('es'))return'es';if(v.startsWith('fr'))return'fr';if(v.startsWith('de'))return'de';if(v.startsWith('pt'))return'pt-BR';return'en';}
function uiLocalePath(){return path.join(userData(),'ui-language.json');}
function getUiLocalePreference(){try{const v=JSON.parse(fs.readFileSync(uiLocalePath(),'utf8')).locale;return v==='auto'||supportedLocales.includes(v)?v:'auto';}catch(e){return'auto';}}
function getUiLocale(){const preference=getUiLocalePreference();return preference==='auto'?normalizeUiLocale(app.getLocale()):preference;}
function setUiLocale(locale){const value=locale==='auto'?'auto':normalizeUiLocale(locale);const temp=uiLocalePath()+'.tmp';fs.writeFileSync(temp,JSON.stringify({locale:value},null,2),'utf8');fs.renameSync(temp,uiLocalePath());return{preference:value,locale:value==='auto'?normalizeUiLocale(app.getLocale()):value};}
const menuRows={
  file:['ファイル','File','文件','파일','Archivo','Fichier','Datei','Arquivo'],newTab:['新しいタブ','New tab','新建标签页','새 탭','Nueva pestaña','Nouvel onglet','Neuer Tab','Nova aba'],add:['接続先を追加','Add connection','添加连接','연결 추가','Añadir conexión','Ajouter une connexion','Verbindung hinzufügen','Adicionar conexão'],workspace:['ワークスペース','Workspace','工作区','워크스페이스','Espacio de trabajo','Espace de travail','Arbeitsbereich','Espaço de trabalho'],lock:['保管庫をロック','Lock vault','锁定保险库','보관소 잠금','Bloquear bóveda','Verrouiller le coffre','Tresor sperren','Bloquear cofre'],quit:['終了','Quit','退出','종료','Salir','Quitter','Beenden','Sair'],edit:['編集','Edit','编辑','편집','Editar','Édition','Bearbeiten','Editar'],copy:['コピー','Copy','复制','복사','Copiar','Copier','Kopieren','Copiar'],paste:['貼り付け','Paste','粘贴','붙여넣기','Pegar','Coller','Einfügen','Colar'],selectAll:['すべて選択','Select all','全选','모두 선택','Seleccionar todo','Tout sélectionner','Alles auswählen','Selecionar tudo'],view:['表示','View','视图','보기','Ver','Affichage','Ansicht','Exibir'],find:['ターミナル検索','Find in terminal','终端搜索','터미널 검색','Buscar en terminal','Rechercher dans le terminal','Im Terminal suchen','Pesquisar no terminal'],palette:['コマンドパレット','Command palette','命令面板','명령 팔레트','Paleta de comandos','Palette de commandes','Befehlspalette','Paleta de comandos'],fullscreen:['全画面表示','Full screen','全屏','전체 화면','Pantalla completa','Plein écran','Vollbild','Tela cheia'],reload:['再読み込み','Reload','重新加载','새로고침','Recargar','Recharger','Neu laden','Recarregar'],tools:['ツール','Tools','工具','도구','Herramientas','Outils','Werkzeuge','Ferramentas'],multi:['複数サーバーへ一括実行','Run on multiple servers','在多台服务器运行','여러 서버에서 실행','Ejecutar en varios servidores','Exécuter sur plusieurs serveurs','Auf mehreren Servern ausführen','Executar em vários servidores'],keygen:['SSH鍵生成','Generate SSH key','生成 SSH 密钥','SSH 키 생성','Generar clave SSH','Générer une clé SSH','SSH-Schlüssel erzeugen','Gerar chave SSH'],settings:['設定','Settings','设置','설정','Configuración','Paramètres','Einstellungen','Configurações'],help:['ヘルプ','Help','帮助','도움말','Ayuda','Aide','Hilfe','Ajuda'],about:['SSH Nexusについて','About SSH Nexus','关于 SSH Nexus','SSH Nexus 정보','Acerca de SSH Nexus','À propos de SSH Nexus','Über SSH Nexus','Sobre o SSH Nexus']
};
function menuText(key){const i=supportedLocales.indexOf(getUiLocale());return(menuRows[key]||[])[i<0?1:i]||key;}
function helloKeyPath() { return path.join(userData(), 'vault.hello-key'); }
function knownHostsPath() { return path.join(userData(), 'known-hosts.json'); }
function recordingSettingsPath(){return path.join(userData(),'recording-settings.json');}
function defaultRecordingsDir(){return path.join(app.getPath('documents'),'SSH Nexus','Recordings');}
function getRecordingsDir(){let dir='';try{const saved=JSON.parse(fs.readFileSync(recordingSettingsPath(),'utf8'));dir=typeof saved.directory==='string'?saved.directory:'';}catch(e){}if(!dir)dir=defaultRecordingsDir();try{fs.mkdirSync(dir,{recursive:true});return dir;}catch(e){const fallback=path.join(userData(),'Recordings');fs.mkdirSync(fallback,{recursive:true});return fallback;}}
function setRecordingsDir(dir){const resolved=path.resolve(String(dir));fs.mkdirSync(resolved,{recursive:true});const temp=recordingSettingsPath()+'.tmp';fs.writeFileSync(temp,JSON.stringify({directory:resolved},null,2),{mode:0o600});fs.renameSync(temp,recordingSettingsPath());return resolved;}
function safeRecordingName(name){const clean=path.basename(String(name||'recording.ssnrec')).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_');return (clean.toLowerCase().endsWith('.ssnrec')?clean:clean+'.ssnrec').slice(-180);}
function recordingPath(name){return path.join(getRecordingsDir(),safeRecordingName(name));}
function encodeRecording(data){return JSON.stringify({format:'ssh-nexus-recording-encrypted',version:2,payload:vault.seal(data,'recording')});}
function decodeRecordingText(text){const parsed=JSON.parse(String(text));if(parsed.format==='ssh-nexus-recording-encrypted'&&parsed.payload)return vault.unseal(parsed.payload,'recording');if(parsed.format==='ssh-nexus-recording'&&Array.isArray(parsed.events))return parsed;throw new Error('録画形式が不正です。');}
function readRecordingFile(full,migrate=true){const text=fs.readFileSync(full,'utf8'),parsed=JSON.parse(text),data=decodeRecordingText(text);if(migrate&&parsed.format==='ssh-nexus-recording'){const temp=full+'.tmp';fs.writeFileSync(temp,encodeRecording(data),{encoding:'utf8',mode:0o600});fs.renameSync(temp,full);}return data;}
function migrateAllRecordings(){try{if(!vault.isUnlocked()||vault.getVersion()<2)return 0;let count=0;for(const entry of fs.readdirSync(getRecordingsDir(),{withFileTypes:true})){if(!entry.isFile()||!entry.name.toLowerCase().endsWith('.ssnrec'))continue;const full=path.join(getRecordingsDir(),entry.name);if(fs.statSync(full).size>25*1024*1024)continue;const before=JSON.parse(fs.readFileSync(full,'utf8'));readRecordingFile(full,true);if(before.format==='ssh-nexus-recording')count++;}return count;}catch(e){return 0;}}

function readLegacyKnownHosts(){try{return JSON.parse(fs.readFileSync(knownHostsPath(),'utf8'));}catch(e){return{};}}
function readKnownHosts(){try{if(vault&&vault.isUnlocked()&&vault.getVersion()>=2)return vault.getKnownHosts();}catch(e){}return readLegacyKnownHosts();}
function deleteLegacyKnownHosts(){try{if(fs.existsSync(knownHostsPath())){const size=fs.statSync(knownHostsPath()).size;fs.writeFileSync(knownHostsPath(),crypto.randomBytes(Math.max(1,size)));fs.unlinkSync(knownHostsPath());}}catch(e){try{fs.unlinkSync(knownHostsPath());}catch(_){}}}

function readPuttySessions() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve, reject) => execFile('reg.exe', ['query', 'HKCU\\Software\\SimonTatham\\PuTTY\\Sessions', '/s'], { windowsHide:true, encoding:'utf8', maxBuffer:4*1024*1024 }, (err, stdout) => {
    if (err) return err.code === 1 ? resolve([]) : reject(err);
    const sessions=[]; let current=null;
    const finish=()=>{if(current&&current.host){current.port=Number(current.port)||22;current.authType=current.keyFile?'key':'password';current.notes=current.keyFile?`PuTTY秘密鍵: ${current.keyFile}`:'PuTTYからインポート（パスワードは未取込）';current.group='PuTTY';sessions.push(current);}};
    for(const raw of String(stdout).split(/\r?\n/)){
      const line=raw.trim();
      const key=line.match(/^HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\(.+)$/i);
      if(key){finish();let name=key[1];try{name=decodeURIComponent(name);}catch(e){}current={name,host:'',port:22,username:''};continue;}
      if(!current)continue;
      const value=line.match(/^(HostName|PortNumber|UserName|PublicKeyFile)\s+REG_(?:SZ|DWORD)\s+(.+)$/i);if(!value)continue;
      const k=value[1].toLowerCase(),v=value[2].trim();
      if(k==='hostname')current.host=v;else if(k==='username')current.username=v;else if(k==='publickeyfile')current.keyFile=v;else if(k==='portnumber')current.port=/^0x/i.test(v)?parseInt(v,16):parseInt(v,10);
    }
    finish();resolve(sessions);
  }));
}

async function probeSshEndpoint(host, port = 22, timeoutMs = 7000) {
  const started = Date.now();
  let address;
  try {
    const resolved = await dns.lookup(host);
    address = resolved.address;
  } catch (err) {
    return { ok: false, stage: 'dns', code: 'DNS_FAILED', host, port, message: `ホスト名を解決できません: ${err.message}` };
  }

  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    let buffer = '';
    let tcpMs = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ host, port, address, elapsedMs: Date.now() - started, tcpMs, ...result });
    };
    const timer = setTimeout(() => {
      if (tcpMs !== null) {
        finish({ ok: false, stage: 'banner', code: 'NO_SSH_BANNER', tcpOpen: true,
          message: `TCP ${port}番ポートには接続できましたが、SSHバナーが${Math.ceil(timeoutMs / 1000)}秒以内に返りません。接続先がSSHサーバーか、sshd・Fail2ban・接続元IP制限を確認してください。` });
      } else {
        finish({ ok: false, stage: 'tcp', code: 'TCP_TIMEOUT', tcpOpen: false,
          message: `TCP ${port}番ポートへの接続がタイムアウトしました。ファイアウォール、ポート番号、接続元IP制限を確認してください。` });
      }
    }, timeoutMs);
    socket.setNoDelay(true);
    socket.on('connect', () => { tcpMs = Date.now() - started; });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      const banner = lines.find(line => line.startsWith('SSH-'));
      if (banner) finish({ ok: true, stage: 'banner', code: 'SSH_BANNER_OK', tcpOpen: true, banner,
        message: `SSHサーバーを確認しました: ${banner}` });
      else if (buffer.length > 8192) finish({ ok: false, stage: 'banner', code: 'INVALID_BANNER', tcpOpen: true,
        message: '接続先から応答はありましたが、SSHプロトコルではありません。' });
    });
    socket.on('error', (err) => finish({ ok: false, stage: 'tcp', code: err.code || 'TCP_ERROR', tcpOpen: false,
      message: `TCP接続に失敗しました: ${err.message}` }));
    socket.on('end', () => {
      if (!settled) finish({ ok: false, stage: 'banner', code: 'CLOSED_BEFORE_BANNER', tcpOpen: true,
        message: 'SSHバナーを返す前にサーバーから切断されました。' });
    });
  });
}

function makeHostVerifier(conn) {
  const identity = `${conn.host}:${conn.port || 22}`;
  return (fingerprint, done) => {
    const known = readKnownHosts();
    if (known[identity]) {
      if (known[identity] === fingerprint) return done(true);
      dialog.showMessageBox(mainWindow, {
        type: 'error', title: 'SSH host key changed',
        message: `The host key for ${identity} has changed.`,
        detail: `Expected: ${known[identity]}\nReceived: ${fingerprint}\n\nConnection blocked to prevent a possible man-in-the-middle attack.`,
        buttons: ['Block connection']
      }).finally(() => done(false));
      return;
    }
    dialog.showMessageBox(mainWindow, {
      type: 'warning', title: 'Trust new SSH host?',
      message: `First connection to ${identity}`,
      detail: `SHA-256 fingerprint:\n${fingerprint}\n\nVerify this fingerprint with the server administrator before trusting it.`,
      buttons: ['Cancel', 'Trust and connect'], defaultId: 0, cancelId: 0, noLink: true
    }).then(({ response }) => {
      if (response !== 1) return done(false);
      try{vault.setKnownHost(identity,fingerprint);done(true);}catch(e){done(false);}
    }).catch(() => done(false));
  };
}

function hydrateConnection(conn) {
  conn.hostVerifier = makeHostVerifier(conn);
  if (conn.jumpHostId) {
    const chain=buildJumpChain(conn,id=>vault.get(id),5);
    chain.forEach(hop=>{hop.hostVerifier=makeHostVerifier(hop);});
    conn.jumpChain=chain;
    conn.jump=chain[chain.length-1]; // backwards compatibility for diagnostics
  }
  return conn;
}

async function focusMainWindowForHello() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    // Restore only a genuinely minimized window. Never toggle maximize/fullscreen
    // and never use a topmost pulse: both can break a user's full-screen state.
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.setSkipTaskbar(false);
    mainWindow.focus();
    mainWindow.webContents.focus();
    await new Promise(resolve => setTimeout(resolve, 150));
  } catch (e) { startupLog(`HELLO FOCUS WARNING: ${e.message}`); }
}
function mainWindowHwnd() {
  if (!mainWindow || mainWindow.isDestroyed() || process.platform !== 'win32') return '0';
  const handle=mainWindow.getNativeWindowHandle();
  return handle.length>=8?handle.readBigUInt64LE(0).toString():String(handle.readUInt32LE(0));
}

async function verifyWindowsHello() {
  if (process.platform !== 'win32') return { supported: false, verified: false };
  await focusMainWindowForHello();
  const hwnd=mainWindowHwnd();
  const { execFile } = require('child_process');
  // UserConsentVerifier shows the genuine Windows Hello dialog. The app never
  // receives or stores the Windows PIN itself.
  const ps = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$ownedPrompt = $false
try {
  $source = @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Foundation;
using Windows.Security.Credentials.UI;

[ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C")]
[InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
public interface IUserConsentVerifierInterop {
  IAsyncOperation<UserConsentVerificationResult> RequestVerificationForWindowAsync(
    IntPtr appWindow,
    [MarshalAs(UnmanagedType.HString)] string message,
    [In] ref Guid riid);
}
public static class SshNexusOwnedHello {
  public static IAsyncOperation<UserConsentVerificationResult> Request(IntPtr hwnd, string message) {
    var factory = WindowsRuntimeMarshal.GetActivationFactory(typeof(UserConsentVerifier));
    var interop = (IUserConsentVerifierInterop)factory;
    var iid = typeof(IAsyncOperation<UserConsentVerificationResult>).GUID;
    return interop.RequestVerificationForWindowAsync(hwnd, message, ref iid);
  }
}
'@
  $refs = @(
    [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal].Assembly.Location,
    "$env:windir\\System32\\WinMetadata\\Windows.Foundation.winmd",
    "$env:windir\\System32\\WinMetadata\\Windows.Security.winmd"
  ) | Where-Object { $_ -and (Test-Path $_) }
  Add-Type -TypeDefinition $source -ReferencedAssemblies $refs -ErrorAction Stop
  $op = [SshNexusOwnedHello]::Request([IntPtr]([Int64]${hwnd}), "Unlock SSH Nexus")
  $ownedPrompt = $true
} catch {
  # Windows 10 does not expose the HWND interop API. Keep the old API only as
  # a compatibility fallback; Windows 11 uses the correctly owned prompt.
  $op = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync("Unlock SSH Nexus")
}
$m = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
$gm = $m.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerificationResult])
$task = $gm.Invoke($null, @($op))
$task.Wait()
Write-Output ("SSH_NEXUS_HELLO_MODE=" + $(if ($ownedPrompt) { "owned" } else { "fallback" }))
Write-Output $task.Result.ToString()
`;
  return await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      const lines=(stdout||'').trim().split(/\r?\n/),result=lines.pop()||'';
      const modeLine=lines.find(line=>line.startsWith('SSH_NEXUS_HELLO_MODE='));
      startupLog(`WINDOWS HELLO ${modeLine||'mode=unknown'} result=${result||'none'}`);
      resolve({
        supported: true,
        verified: result === 'Verified',
        result,
        error: err ? err.message : (stderr || '').trim()
      });
    });
  });
}

function enrollWindowsHelloKey() {
  if (process.platform !== 'win32' || !safeStorage.isEncryptionAvailable()) return false;
  const encrypted = safeStorage.encryptString(vault.exportKeyForOsProtection());
  fs.writeFileSync(helloKeyPath(), encrypted, { mode: 0o600 });
  return true;
}

function startupLog(message) {
  try {
    fs.mkdirSync(userData(), { recursive: true });
    fs.appendFileSync(path.join(userData(), 'startup.log'), `${new Date().toISOString()} ${message}\n`);
  } catch (e) {}
}
function auditLog(event, details = {}) {
  try {
    if(!vault||!vault.isUnlocked()||vault.getVersion()<2)return;
    const file=path.join(userData(),'audit.log.enc');
    if(fs.existsSync(file)&&fs.statSync(file).size>8*1024*1024)fs.renameSync(file,path.join(userData(),'audit.previous.log.enc'));
    const safe={time:new Date().toISOString(),event,...details};delete safe.password;delete safe.privateKey;delete safe.passphrase;
    fs.appendFileSync(file,'ENC2:'+vault.seal(safe,'audit')+'\n',{encoding:'utf8',mode:0o600});
  } catch(e) {}
}
function readAuditLog(limit=500){try{const file=path.join(userData(),'audit.log.enc');if(!fs.existsSync(file))return[];const lines=fs.readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean);return lines.slice(-limit).map(line=>{try{return line.startsWith('ENC2:')?vault.unseal(line.slice(5),'audit'):null;}catch(e){return null;}}).filter(Boolean).reverse();}catch(e){return[];}}
function migrateLegacyAuditLog(){try{const old=path.join(userData(),'audit.log');if(!fs.existsSync(old)||!vault.isUnlocked()||vault.getVersion()<2)return;for(const line of fs.readFileSync(old,'utf8').split(/\r?\n/)){if(!line.trim())continue;try{const entry=JSON.parse(line);auditLog(entry.event||'legacy-import',entry);}catch(e){}}const size=fs.statSync(old).size;fs.writeFileSync(old,crypto.randomBytes(Math.max(1,size)));fs.unlinkSync(old);}catch(e){}}

function sendMenuAction(action) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu:action', action); }
function installAppMenu() {
  const template = [
    { label:menuText('file'), submenu:[
      { label:menuText('newTab'), accelerator:'CmdOrCtrl+T', click:()=>sendMenuAction('newTab') },
      { label:menuText('add'), accelerator:'CmdOrCtrl+N', click:()=>sendMenuAction('addConnection') },
      { label:menuText('workspace'), accelerator:'CmdOrCtrl+Shift+W', click:()=>sendMenuAction('workspace') },
      { type:'separator' }, { label:menuText('lock'), accelerator:'CmdOrCtrl+L', click:()=>sendMenuAction('lock') },
      { type:'separator' }, { role:'quit', label:menuText('quit') }
    ]},
    { label:menuText('edit'), submenu:[{role:'copy',label:menuText('copy')},{role:'paste',label:menuText('paste')},{role:'selectAll',label:menuText('selectAll')}] },
    { label:menuText('view'), submenu:[
      { label:menuText('find'), accelerator:'CmdOrCtrl+F', click:()=>sendMenuAction('find') },
      { label:menuText('palette'), accelerator:'CmdOrCtrl+Shift+P', click:()=>sendMenuAction('palette') },
      { type:'separator' }, {role:'togglefullscreen',label:menuText('fullscreen'),accelerator:'F11'}, {role:'reload',label:menuText('reload')}
    ]},
    { label:menuText('tools'), submenu:[
      {label:menuText('multi'),click:()=>sendMenuAction('multiExec')},
      {label:menuText('keygen'),click:()=>sendMenuAction('keygen')},
      {label:menuText('settings'),accelerator:'CmdOrCtrl+,',click:()=>sendMenuAction('settings')}
    ]},
    { label:menuText('help'), submenu:[{label:menuText('about'),click:()=>dialog.showMessageBox(mainWindow,{type:'info',title:'SSH Nexus',message:`SSH Nexus ${app.getVersion()}`,detail:'Secure multi-session SSH client for Windows'})}] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function readWindowState(){try{return JSON.parse(fs.readFileSync(path.join(userData(),'window-state.json'),'utf8'));}catch(e){return{};}}
function saveWindowState(){if(!mainWindow||mainWindow.isDestroyed())return;try{fs.writeFileSync(path.join(userData(),'window-state.json'),JSON.stringify({bounds:mainWindow.getBounds(),maximized:mainWindow.isMaximized()}));}catch(e){}}
function githubReleaseConfig(){try{const value=JSON.parse(fs.readFileSync(path.join(__dirname,'github-release.json'),'utf8'));const owner=String(value.owner||'').trim(),repo=String(value.repo||'').trim();return{owner:/^[A-Za-z0-9_.-]+$/.test(owner)?owner:'',repo:/^[A-Za-z0-9_.-]+$/.test(repo)?repo:'',checkOnStartup:value.checkOnStartup!==false};}catch(e){return{owner:'',repo:'',checkOnStartup:false};}}
function versionParts(value){return String(value||'').replace(/^v/i,'').split(/[.+-]/).slice(0,3).map(x=>Number.parseInt(x,10)||0);}
function isNewerVersion(candidate,current){const a=versionParts(candidate),b=versionParts(current);for(let i=0;i<3;i++){if(a[i]>b[i])return true;if(a[i]<b[i])return false;}return false;}
function githubJson(url){return new Promise((resolve,reject)=>{const request=https.get(url,{headers:{'User-Agent':`SSH-Nexus/${app.getVersion()}`,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}},response=>{let body='';response.setEncoding('utf8');response.on('data',chunk=>{body+=chunk;if(body.length>2*1024*1024)request.destroy(new Error('GitHub response is too large'));});response.on('end',()=>{if(response.statusCode!==200){reject(new Error(`GitHub returned HTTP ${response.statusCode}`));return;}try{resolve(JSON.parse(body));}catch(e){reject(new Error('GitHub returned invalid JSON'));}});});request.setTimeout(12000,()=>request.destroy(new Error('GitHub update check timed out')));request.on('error',reject);});}
async function checkGithubUpdate(){const config=githubReleaseConfig();if(!config.owner||!config.repo)return{configured:false,currentVersion:app.getVersion(),message:'GitHub release repository is not configured'};const release=await githubJson(`https://api.github.com/repos/${config.owner}/${config.repo}/releases/latest`),version=String(release.tag_name||'').replace(/^v/i,''),asset=(release.assets||[]).find(item=>/^SSH-Nexus-Setup-.*\.exe$/i.test(String(item.name||'')));const info={configured:true,available:isNewerVersion(version,app.getVersion()),currentVersion:app.getVersion(),version,tag:String(release.tag_name||''),name:String(release.name||''),notes:String(release.body||'').slice(0,12000),publishedAt:release.published_at||null,pageUrl:`https://github.com/${config.owner}/${config.repo}/releases/latest`,downloadUrl:asset?String(asset.browser_download_url):'',assetName:asset?String(asset.name):''};latestUpdateInfo=info;return info;}

function createWindow() {
  startupLog(`Starting SSH Nexus ${app.getVersion()} on ${process.platform} ${process.arch}`);
  const windowState=readWindowState();
  mainWindow = new BrowserWindow({
    width: windowState.bounds?.width || 1280,
    height: windowState.bounds?.height || 820,
    x: windowState.bounds?.x,
    y: windowState.bounds?.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1e1e',
    title: 'SSH Nexus',
    icon: path.join(__dirname, 'assets', 'ssh-nexus-icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged,
      spellcheck: false,
      // Sandboxed preload behaves differently between Electron/Windows builds.
      // Node remains disabled in the renderer and only the narrow contextBridge
      // API is exposed, while disabling this avoids a blank first-run screen.
      sandbox: false
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('preload-error', (event, preloadPath, error) => startupLog(`PRELOAD ERROR ${preloadPath}: ${error && error.stack || error}`));
  mainWindow.webContents.on('did-fail-load', (event, code, description, url) => startupLog(`LOAD ERROR ${code} ${description} ${url}`));
  // Electron 44 uses the legacy positional console-message arguments.
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    startupLog(`RENDERER level=${level} message=${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => startupLog(`RENDERER GONE: ${JSON.stringify(details)}`));
  mainWindow.webContents.on('did-finish-load',()=>{if(pendingExternalConnect){mainWindow.webContents.send('external:connectRequest',pendingExternalConnect);pendingExternalConnect=null;}});
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch(err => startupLog(`loadFile failed: ${err.stack || err}`));
  installAppMenu();
  if (windowState.maximized) mainWindow.maximize();
  mainWindow.on('close', saveWindowState);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  if(process.platform==='win32')app.setAppUserModelId('com.sshnexus.app');
  if(app.isPackaged)app.setAsDefaultProtocolClient('sshnexus');
  pendingExternalConnect=pendingExternalConnect||parseExternalConnect(process.argv);
  vault = new Vault(userData());
  ssh = new SshManager();
  const allowedRendererPermissions=new Set(['clipboard-read','clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((webContents,permission,callback)=>callback(allowedRendererPermissions.has(permission)));
  session.defaultSession.setPermissionCheckHandler((webContents,permission)=>allowedRendererPermissions.has(permission));

  ipcMain.on('diagnostics:log', (event, message) => startupLog(`DIAGNOSTIC ${String(message)}`));
  const secureSystemLock = (reason) => {
    if (!vault.isUnlocked()) return;
    auditLog('vault-auto-lock', { reason });
    vault.lock(); ssh.disconnectAll();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('security:locked', reason);
  };
  powerMonitor.on('lock-screen', () => secureSystemLock('windows-lock'));
  powerMonitor.on('suspend', () => secureSystemLock('system-suspend'));
  ipcMain.on('notification:show', (event, title, body) => { if(Notification.isSupported())new Notification({title:String(title).slice(0,120),body:String(body).slice(0,500)}).show(); });
  ipcMain.handle('updates:check',()=>checkGithubUpdate());
  ipcMain.handle('updates:download',async()=>{if(!latestUpdateInfo?.available||!latestUpdateInfo.downloadUrl)throw new Error('ダウンロード可能な更新はありません。');const url=new URL(latestUpdateInfo.downloadUrl);if(url.protocol!=='https:'||url.hostname!=='github.com')throw new Error('更新URLを検証できません。');await shell.openExternal(url.toString());return true;});
  ipcMain.handle('updates:openRelease',async()=>{const url=latestUpdateInfo?.pageUrl;if(!url)throw new Error('リリースページがありません。');await shell.openExternal(url);return true;});
  ipcMain.handle('audit:list', (e, limit) => readAuditLog(Number(limit)||500));
  ipcMain.handle('audit:clear', () => { try{fs.writeFileSync(path.join(userData(),'audit.log.enc'),'',{mode:0o600});}catch(e){} return true; });
  ipcMain.handle('audit:export', async () => { const r=await dialog.showSaveDialog(mainWindow,{defaultPath:'SSH-Nexus-Audit.log'});if(r.canceled||!r.filePath)return null;const text=readAuditLog(100000).reverse().map(x=>JSON.stringify(x)).join('\n')+'\n';fs.writeFileSync(r.filePath,text,'utf8');return r.filePath; });

  // Vault IPC
  ipcMain.handle('vault:exists', () => vault.exists());
  ipcMain.handle('vault:securityInfo', () => vault.securityInfo());
  ipcMain.handle('vault:setup', (e, recoveryPassphrase) => {vault.setup(recoveryPassphrase);return vault.securityInfo();});
  ipcMain.handle('vault:unlock', (e, secret) => {const result=vault.unlock(secret);if(vault.getVersion()>=2){migrateLegacyAuditLog();migrateAllRecordings();}return result;});
  ipcMain.handle('vault:migrateSecurity', (e, recoveryPassphrase) => {
    const oldMeta=fs.readFileSync(path.join(userData(),'vault.meta.json')),oldStore=fs.readFileSync(path.join(userData(),'vault.json')),oldHello=fs.existsSync(helloKeyPath())?fs.readFileSync(helloKeyPath()):null,legacyHosts=readLegacyKnownHosts();
    try{
      const result=vault.migrateLegacy(recoveryPassphrase,legacyHosts);enrollWindowsHelloKey();
      const backupDir=path.join(app.getPath('documents'),'SSH Nexus','Backups');fs.mkdirSync(backupDir,{recursive:true});const backupPath=path.join(backupDir,`Security-Migration-${new Date().toISOString().replace(/[:.]/g,'-')}.ssnbak`);
      fs.writeFileSync(backupPath,JSON.stringify({format:'ssh-nexus-backup',version:2,createdAt:new Date().toISOString(),meta:JSON.parse(fs.readFileSync(path.join(userData(),'vault.meta.json'),'utf8')),store:JSON.parse(fs.readFileSync(path.join(userData(),'vault.json'),'utf8'))},null,2),{encoding:'utf8',mode:0o600});
      deleteLegacyKnownHosts();migrateLegacyAuditLog();const migratedRecordings=migrateAllRecordings();return{...result,backupPath,migratedRecordings};
    }catch(err){fs.writeFileSync(path.join(userData(),'vault.meta.json'),oldMeta);fs.writeFileSync(path.join(userData(),'vault.json'),oldStore);if(oldHello)fs.writeFileSync(helloKeyPath(),oldHello);else try{fs.unlinkSync(helloKeyPath());}catch(e){}vault=new Vault(userData());throw err;}
  });
  ipcMain.handle('vault:lock', () => { vault.lock(); ssh.disconnectAll(); return true; });
  ipcMain.handle('vault:isUnlocked', () => vault.isUnlocked());
  ipcMain.handle('vault:list', () => vault.list());
  ipcMain.handle('vault:get', (e, id) => vault.get(id));
  ipcMain.handle('vault:add', (e, conn) => vault.add(conn));
  ipcMain.handle('vault:update', (e, id, patch) => { vault.update(id, patch); return true; });
  ipcMain.handle('vault:remove', (e, id) => { vault.remove(id); return true; });
  ipcMain.handle('vault:changePin', (e, oldPin, newPin) => {
    vault.changePin(oldPin, newPin);
    // Keep the DPAPI-wrapped Hello key in sync after key rotation.
    if (fs.existsSync(helloKeyPath())) enrollWindowsHelloKey();
    return true;
  });
  ipcMain.handle('vault:export', () => vault.exportJson());
  ipcMain.handle('secureData:get',(e,key)=>vault.getAppData(String(key).slice(0,100)));
  ipcMain.handle('secureData:set',(e,key,value)=>vault.setAppData(String(key).slice(0,100),value));
  ipcMain.handle('secureData:delete',(e,key)=>vault.deleteAppData(String(key).slice(0,100)));
  ipcMain.handle('vault:backup', async () => {
    const r = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `SSH-Nexus-Backup-${new Date().toISOString().slice(0, 10)}.ssnbak`,
      filters: [{ name: 'SSH Nexus encrypted backup', extensions: ['ssnbak'] }]
    });
    if (r.canceled || !r.filePath) return null;
    const payload = {
      format: 'ssh-nexus-backup', version: 2, createdAt: new Date().toISOString(),
      meta: JSON.parse(fs.readFileSync(path.join(userData(), 'vault.meta.json'), 'utf8')),
      store: JSON.parse(fs.readFileSync(path.join(userData(), 'vault.json'), 'utf8'))
    };
    fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return r.filePath;
  });
  ipcMain.handle('vault:restore', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'SSH Nexus backup', extensions: ['ssnbak'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    const payload = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (payload.format !== 'ssh-nexus-backup' || !payload.meta || !payload.store) throw new Error('有効なSSH Nexusバックアップではありません。');
    // Validate either the fully encrypted v2 format or a legacy backup that
    // will require one-time security migration after restore.
    const validV2=Number(payload.meta.version)>=2&&payload.meta.kdf?.salt&&payload.meta.wrappedKey&&payload.store.version===2&&payload.store.payload;
    const validV1=payload.meta.salt&&payload.meta.verifier&&Array.isArray(payload.store.connections);
    if(!validV2&&!validV1)throw new Error('バックアップが破損しています。');
    const backupDir = path.join(userData(), 'before-restore-' + Date.now());
    fs.mkdirSync(backupDir, { recursive: true });
    for (const name of ['vault.meta.json', 'vault.json', 'known-hosts.json']) {
      const src = path.join(userData(), name); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, name));
    }
    fs.writeFileSync(path.join(userData(), 'vault.meta.json'), JSON.stringify(payload.meta, null, 2));
    fs.writeFileSync(path.join(userData(), 'vault.json'), JSON.stringify(payload.store, null, 2));
    if(validV1&&payload.knownHosts)fs.writeFileSync(knownHostsPath(),JSON.stringify(payload.knownHosts,null,2));else deleteLegacyKnownHosts();
    // A DPAPI-wrapped key belongs to the previous vault; require the restored
    // backup PIN once, then Windows Hello is enrolled again on next setup flow.
    if (fs.existsSync(helloKeyPath())) fs.unlinkSync(helloKeyPath());
    setTimeout(() => { app.relaunch(); app.exit(0); }, 400);
    return { restored: true, safetyBackup: backupDir };
  });
  ipcMain.handle('sshConfig:export', async () => {
    const connections=vault.list();const aliases=new Map(connections.map(c=>[c.id,(c.name||c.host).trim().replace(/\s+/g,'-').replace(/[^A-Za-z0-9._-]/g,'_')]));
    const blocks=connections.map(summary=>{const c=vault.get(summary.id);const lines=[`Host ${aliases.get(c.id)}`,`  HostName ${c.host}`,`  User ${c.username}`,`  Port ${c.port||22}`,`  ConnectTimeout ${c.timeoutSeconds||8}`,`  ServerAliveInterval ${c.keepaliveIntervalSeconds==null?10:c.keepaliveIntervalSeconds}`,`  ServerAliveCountMax ${c.keepaliveCountMax||3}`];if(c.compression)lines.push('  Compression yes');if(c.jumpHostId){try{const chain=buildJumpChain(c,id=>vault.get(id),5).map(x=>aliases.get(x.id)).filter(Boolean);if(chain.length)lines.push(`  ProxyJump ${chain.join(',')}`);}catch(e){lines.push(`  # ProxyJump error: ${e.message}`);}}if(c.authType==='agent')lines.push('  IdentitiesOnly no');if(c.agentForward)lines.push('  ForwardAgent yes');if(c.encoding&&c.encoding!=='utf8')lines.push(`  # SSH Nexus terminal encoding: ${c.encoding}`);if(c.authType==='key')lines.push('  # Private key is stored encrypted inside SSH Nexus');return lines.join('\n');});
    const content='# Exported by SSH Nexus '+app.getVersion()+' on '+new Date().toISOString()+'\n\n'+blocks.join('\n\n')+'\n';
    const r=await dialog.showSaveDialog(mainWindow,{defaultPath:'ssh-nexus-config',filters:[{name:'OpenSSH config',extensions:['txt','config']}]});if(r.canceled||!r.filePath)return null;fs.writeFileSync(r.filePath,content,'utf8');return r.filePath;
  });
  ipcMain.handle('migration:puttySessions', () => readPuttySessions());
  ipcMain.handle('migration:parseOpenSsh', (e, content) => parseOpenSshConfig(String(content||'').slice(0,2*1024*1024)));
  ipcMain.handle('knownHosts:list', () => vault.getKnownHosts());
  ipcMain.handle('knownHosts:remove', (e, identity) => {vault.removeKnownHost(identity);return true;});

  // Import from file
  ipcMain.handle('dialog:openFile', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });
  ipcMain.handle('fs:readFile', (e, p) => fs.readFileSync(p, 'utf8'));
  ipcMain.handle('dialog:saveText', async (e, defaultName, content) => {
    const r = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName || 'ssh-session.log' });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, content, 'utf8');
    return r.filePath;
  });
  ipcMain.handle('i18n:settings',()=>({preference:getUiLocalePreference(),locale:getUiLocale(),supported:supportedLocales}));
  ipcMain.handle('i18n:setLocale',(e,locale)=>{const result=setUiLocale(locale);installAppMenu();return result;});
  ipcMain.handle('recordings:settings',()=>({directory:getRecordingsDir()}));
  ipcMain.handle('recordings:chooseDirectory',async()=>{const r=await dialog.showOpenDialog(mainWindow,{defaultPath:getRecordingsDir(),properties:['openDirectory','createDirectory']});if(r.canceled||!r.filePaths.length)return null;return{directory:setRecordingsDir(r.filePaths[0])};});
  ipcMain.handle('recordings:openDirectory',async()=>{const directory=getRecordingsDir();const error=await shell.openPath(directory);if(error)throw new Error(error);return directory;});
  ipcMain.handle('recordings:save',(e,name,content)=>{const text=String(content||'');if(Buffer.byteLength(text)>25*1024*1024)throw new Error('録画サイズが25MBを超えています。');const data=JSON.parse(text);if(data.format!=='ssh-nexus-recording'||!Array.isArray(data.events))throw new Error('録画形式が不正です。');const dir=getRecordingsDir(),base=safeRecordingName(name),ext='.ssnrec',stem=base.slice(0,-ext.length);let target=path.join(dir,base),n=2;while(fs.existsSync(target))target=path.join(dir,`${stem}-${n++}${ext}`);const temp=target+'.tmp';fs.writeFileSync(temp,encodeRecording(data),{encoding:'utf8',mode:0o600});fs.renameSync(temp,target);auditLog('recording-saved',{file:path.basename(target),events:data.events.length});return{path:target,name:path.basename(target)};});
  ipcMain.handle('recordings:list',()=>{const dir=getRecordingsDir();const result=[];for(const entry of fs.readdirSync(dir,{withFileTypes:true}).filter(x=>x.isFile()&&x.name.toLowerCase().endsWith('.ssnrec')).slice(0,1000)){try{const full=path.join(dir,entry.name),stat=fs.statSync(full);if(stat.size>25*1024*1024)continue;const data=readRecordingFile(full,true);result.push({name:entry.name,connection:String(data.connection||'SSH').slice(0,200),createdAt:data.createdAt||stat.birthtime.toISOString(),durationMs:data.events.length?Number(data.events[data.events.length-1][0])||0:0,events:data.events.length,size:stat.size,mtime:stat.mtimeMs});}catch(err){}}return result.sort((a,b)=>b.mtime-a.mtime);});
  ipcMain.handle('recordings:read',(e,name)=>{if(String(name)!==path.basename(String(name))||!String(name).toLowerCase().endsWith('.ssnrec'))throw new Error('録画ファイル名が不正です。');const full=path.join(getRecordingsDir(),String(name)),stat=fs.statSync(full);if(stat.size>25*1024*1024)throw new Error('録画サイズが25MBを超えています。');return JSON.stringify(readRecordingFile(full,true));});
  ipcMain.handle('recordings:delete',(e,name)=>{if(String(name)!==path.basename(String(name))||!String(name).toLowerCase().endsWith('.ssnrec'))throw new Error('録画ファイル名が不正です。');fs.unlinkSync(path.join(getRecordingsDir(),String(name)));auditLog('recording-deleted',{file:String(name)});return true;});
  ipcMain.handle('recordings:import',async()=>{const r=await dialog.showOpenDialog(mainWindow,{properties:['openFile'],filters:[{name:'SSH Nexus recording',extensions:['ssnrec']}]});if(r.canceled||!r.filePaths.length)return null;const source=r.filePaths[0],stat=fs.statSync(source);if(stat.size>25*1024*1024)throw new Error('録画サイズが25MBを超えています。');const data=decodeRecordingText(fs.readFileSync(source,'utf8'));const base=safeRecordingName(path.basename(source));let target=path.join(getRecordingsDir(),base),n=2,stem=base.slice(0,-7);while(fs.existsSync(target))target=path.join(getRecordingsDir(),`${stem}-${n++}.ssnrec`);fs.writeFileSync(target,encodeRecording(data),{encoding:'utf8',mode:0o600});return{name:path.basename(target),path:target};});

  // SSH IPC
  ipcMain.handle('ssh:connect', (e, connId) => {
    const conn = hydrateConnection(vault.get(connId));
    auditLog('connect-attempt',{connectionId:connId,name:conn.name,host:conn.host,port:conn.port,username:conn.username,jump:conn.jump?.host,jumpChain:(conn.jumpChain||[]).map(x=>x.host)});
    const sessId = ssh.connect(conn, (id, data) => {
      if (mainWindow) mainWindow.webContents.send('ssh:data', id, data);
    }, (id, code) => {
      auditLog('disconnect',{connectionId:connId,host:conn.host,code});
      if (mainWindow) mainWindow.webContents.send('ssh:exit', id, code);
    }, (id, msg) => {
      auditLog('connection-error',{connectionId:connId,host:conn.host,message:msg});
      if (mainWindow) mainWindow.webContents.send('ssh:error', id, msg);
    }, (id, stage, message) => {
      if(stage==='ready')auditLog('connected',{connectionId:connId,host:conn.host,username:conn.username});
      if (mainWindow) mainWindow.webContents.send('ssh:status', id, stage, message);
    }, (token, challenge) => {
      if (mainWindow) mainWindow.webContents.send('ssh:challenge', token, challenge);
    });
    return sessId;
  });
  ipcMain.handle('ssh:connectAdhoc', (e, opts) => {
    opts = hydrateConnection(opts);
    auditLog('connect-attempt',{host:opts.host,port:opts.port,username:opts.username,adhoc:true});
    const sessId = ssh.connect(opts, (id, data) => {
      if (mainWindow) mainWindow.webContents.send('ssh:data', id, data);
    }, (id, code) => {
      auditLog('disconnect',{host:opts.host,code,adhoc:true});
      if (mainWindow) mainWindow.webContents.send('ssh:exit', id, code);
    }, (id, msg) => {
      auditLog('connection-error',{host:opts.host,message:msg,adhoc:true});
      if (mainWindow) mainWindow.webContents.send('ssh:error', id, msg);
    }, (id, stage, message) => {
      if(stage==='ready')auditLog('connected',{host:opts.host,username:opts.username,adhoc:true});
      if (mainWindow) mainWindow.webContents.send('ssh:status', id, stage, message);
    }, (token, challenge) => {
      if (mainWindow) mainWindow.webContents.send('ssh:challenge', token, challenge);
    });
    return sessId;
  });

  ipcMain.handle('ssh:test', async (e, request) => {
    let conn = request && request.connectionId ? vault.get(request.connectionId) : { ...(request && request.options || {}) };
    conn.port = Number(conn.port) || 22;
    conn = hydrateConnection(conn);
    const timeoutMs = Math.min(30000, Math.max(3000, (Number(conn.timeoutSeconds) || 8) * 1000));
    const network = conn.jump
      ? { ok:true, stage:'jump', code:'PROXY_JUMP', host:conn.host, port:conn.port, address:'踏み台経由', tcpOpen:true, message:`踏み台 ${conn.jump.host} 経由で検証します。` }
      : await probeSshEndpoint(conn.host, conn.port, timeoutMs);
    if (!network.ok || request.authenticate === false) return { ok: network.ok, network, authentication: null };
    const authentication = await ssh.test(conn, null, (token, challenge) => {
      if (mainWindow) mainWindow.webContents.send('ssh:challenge', token, challenge);
    });
    return { ok: authentication.ok, network, authentication };
  });

  ipcMain.handle('ssh:respondChallenge', (e, token, answers) => ssh.respondChallenge(token, answers));
  ipcMain.on('ssh:write', (e, id, data) => { ssh.write(id, data); });
  ipcMain.on('ssh:resize', (e, id, cols, rows) => { ssh.resize(id, cols, rows); });
  ipcMain.handle('ssh:disconnect', (e, id) => { ssh.disconnect(id); return true; });
  ipcMain.handle('ssh:list', () => ssh.list());
  ipcMain.handle('ssh:keygen', (e, options) => ssh.generateKeyPair(options));
  ipcMain.handle('ssh:exec', (e, id, command, timeoutMs) => ssh.exec(id, command, timeoutMs));
  ipcMain.handle('ssh:monitor', (e, id) => ssh.monitorSnapshot(id));

  // SFTP file operations use native dialogs; arbitrary renderer filesystem
  // access is never exposed.
  ipcMain.handle('sftp:list', (e, id, remotePath) => ssh.sftpList(id, remotePath));
  ipcMain.handle('sftp:stat', (e, id, remotePath) => ssh.sftpStat(id, remotePath));
  ipcMain.handle('sftp:cancel', (e,id) => {const cancelled=ssh.cancelSftpTransfers(id);if(cancelled)auditLog('sftp-transfer-cancelled',{sessionId:id});return cancelled;});
  ipcMain.handle('sftp:upload', async (e, id, remoteDir, verify = false) => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
    if (r.canceled || !r.filePaths.length) return null;
    const localPath = r.filePaths[0];
    const remotePath = path.posix.join(remoteDir, path.basename(localPath));
    const localSize=fs.statSync(localPath).size;let resumeFrom=0;
    try{const existing=await ssh.sftpStat(id,remotePath);if(existing.size>0){const partial=existing.size<localSize;const choice=await dialog.showMessageBox(mainWindow,{type:'question',title:'アップロード先に同名ファイルがあります',message:partial?'途中のファイルからアップロードを再開しますか？':'同名ファイルを上書きしますか？',detail:`リモート: ${existing.size} bytes / ローカル: ${localSize} bytes\n再開は両方が同じファイルの場合だけ使用してください。`,buttons:partial?['再開','上書き','キャンセル']:['上書き','キャンセル'],defaultId:partial?0:1,cancelId:partial?2:1});if((partial&&choice.response===2)||(!partial&&choice.response===1))return null;if(partial&&choice.response===0)resumeFrom=existing.size;}}catch(err){if(!/no such|not exist/i.test(err.message||''))throw err;}
    const progress=value=>{if(mainWindow)mainWindow.webContents.send('sftp:progress',id,value);};
    const result=await ssh.sftpUpload(id,localPath,remotePath,progress,resumeFrom);
    let verification=null;if(verify||resumeFrom>0){verification=await ssh.verifySftpFile(id,remotePath,localPath,progress);if(!verification.ok){auditLog('sftp-verify-failed',{remotePath,direction:'upload'});throw new Error('SHA-256検証に失敗しました。リモートファイルとローカルファイルが一致しません。');}}
    auditLog('sftp-upload',{remotePath,bytes:localSize,resumedFrom:resumeFrom,verified:!!verification});
    return { localPath, remotePath, ...result, verified:verification&&verification.ok, sha256:verification&&verification.localHash };
  });
  ipcMain.handle('sftp:download', async (e, id, remotePath, verify = false) => {
    const r = await dialog.showSaveDialog(mainWindow, { defaultPath: path.posix.basename(remotePath) });
    if (r.canceled || !r.filePath) return null;
    const remote=await ssh.sftpStat(id,remotePath);let resumeFrom=0;
    if(fs.existsSync(r.filePath)){const localSize=fs.statSync(r.filePath).size;if(localSize>0){const partial=localSize<remote.size;const choice=await dialog.showMessageBox(mainWindow,{type:'question',title:'保存先に同名ファイルがあります',message:partial?'途中のファイルからダウンロードを再開しますか？':'既存ファイルを上書きしますか？',detail:`ローカル: ${localSize} bytes / リモート: ${remote.size} bytes\n再開は両方が同じファイルの場合だけ使用してください。`,buttons:partial?['再開','上書き','キャンセル']:['上書き','キャンセル'],defaultId:partial?0:1,cancelId:partial?2:1});if((partial&&choice.response===2)||(!partial&&choice.response===1))return null;if(partial&&choice.response===0)resumeFrom=localSize;}}
    const progress=value=>{if(mainWindow)mainWindow.webContents.send('sftp:progress',id,value);};
    const result=await ssh.sftpDownload(id,remotePath,r.filePath,progress,resumeFrom);
    let verification=null;if(verify||resumeFrom>0){verification=await ssh.verifySftpFile(id,remotePath,r.filePath,progress);if(!verification.ok){auditLog('sftp-verify-failed',{remotePath,direction:'download'});throw new Error('SHA-256検証に失敗しました。ダウンロードファイルとリモートファイルが一致しません。');}}
    auditLog('sftp-download',{remotePath,bytes:remote.size,resumedFrom:resumeFrom,verified:!!verification});
    return { remotePath, localPath:r.filePath, ...result, verified:verification&&verification.ok, sha256:verification&&verification.localHash };
  });
  ipcMain.handle('sftp:uploadDirectory', async (e, id, remoteDir) => {
    const r=await dialog.showOpenDialog(mainWindow,{properties:['openDirectory']});if(r.canceled||!r.filePaths.length)return null;
    const localDir=r.filePaths[0],remoteRoot=path.posix.join(remoteDir,path.basename(localDir));
    return await ssh.sftpUploadDirectory(id,localDir,remoteRoot,progress=>{if(mainWindow)mainWindow.webContents.send('sftp:progress',id,progress);});
  });
  ipcMain.handle('sftp:downloadDirectory', async (e,id,remoteRoot) => {
    const r=await dialog.showOpenDialog(mainWindow,{properties:['openDirectory','createDirectory']});if(r.canceled||!r.filePaths.length)return null;
    const localRoot=path.join(r.filePaths[0],path.posix.basename(remoteRoot)||'server-root');
    return await ssh.sftpDownloadDirectory(id,remoteRoot,localRoot,progress=>{if(mainWindow)mainWindow.webContents.send('sftp:progress',id,progress);});
  });
  ipcMain.handle('sftp:readText', (e, id, remotePath) => ssh.sftpReadText(id, remotePath));
  ipcMain.handle('sftp:writeText', async (e, id, remotePath, content) => {const result=await ssh.sftpWriteText(id,remotePath,content);auditLog('sftp-atomic-save',{remotePath,bytes:result.bytes});return result;});
  ipcMain.handle('sftp:mkdir', (e, id, remotePath) => ssh.sftpMkdir(id, remotePath));
  ipcMain.handle('sftp:delete', (e, id, remotePath, isDirectory) => ssh.sftpDelete(id, remotePath, isDirectory));
  ipcMain.handle('sftp:rename', (e, id, oldPath, newPath) => ssh.sftpRename(id, oldPath, newPath));
  ipcMain.handle('sftp:chmod', (e, id, remotePath, mode) => ssh.sftpChmod(id, remotePath, mode));

  ipcMain.handle('tunnel:start', (e, id, config) => ssh.startTunnel(id, config));
  ipcMain.handle('tunnel:startRemote', (e, id, config) => ssh.startRemoteTunnel(id, config));
  ipcMain.handle('tunnel:startSocks', (e, id, config) => ssh.startSocksProxy(id, config));
  ipcMain.handle('tunnel:list', (e, id) => ssh.listTunnels(id));
  ipcMain.handle('tunnel:stop', (e, id, tunnelId) => ssh.stopTunnel(id, tunnelId));

  // Windows Hello unlock: Hello authenticates the user, then DPAPI unwraps
  // the random vault key. The Windows PIN is handled only by Windows.
  ipcMain.handle('winhello:status', () => ({
    supported: process.platform === 'win32' && safeStorage.isEncryptionAvailable(),
    enrolled: fs.existsSync(helloKeyPath()),
    migrationRequired: vault.exists() && vault.getVersion() < 2
  }));
  ipcMain.handle('winhello:enroll', () => ({ enrolled: enrollWindowsHelloKey() }));
  ipcMain.handle('winhello:verify', () => verifyWindowsHello());
  ipcMain.handle('winhello:unlock', async () => {
    if (process.platform !== 'win32' || !safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'Windows Hello is not available' };
    }
    if (!fs.existsSync(helloKeyPath())) {
      return { ok: false, error: 'Windows Hello is not enrolled for this vault' };
    }
    if(vault.getVersion()<2)return{ok:false,error:'Enter the previous PIN once to complete the security migration'};
    const verification = await verifyWindowsHello();
    if (!verification.verified) {
      return { ok: false, error: verification.error || verification.result || 'Verification cancelled' };
    }
    try {
      const wrapped = fs.readFileSync(helloKeyPath());
      const key = safeStorage.decryptString(wrapped);
      vault.unlockWithKey(key);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  createWindow();
  const releaseConfig=githubReleaseConfig();
  if(releaseConfig.checkOnStartup&&releaseConfig.owner&&releaseConfig.repo)setTimeout(()=>{checkGithubUpdate().then(info=>{if(info.available&&mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('updates:available',info);}).catch(err=>startupLog(`UPDATE CHECK WARNING: ${err.message}`));},5000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (vault) vault.lock();
  if (ssh) ssh.disconnectAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (vault) vault.lock();
  if (ssh) ssh.disconnectAll();
});
