/* global Terminal, FitAddon, SearchAddon */

const i18n=window.I18n||{t:x=>x,locale:'ja',preference:'auto',locales:['ja'],names:{ja:'日本語'},setLocale:()=>{},localizeDocument:()=>{},observe:()=>{}};
const t=value=>i18n.t(value);
i18n.localizeDocument();i18n.observe();
const nativeConfirm=window.confirm.bind(window),nativeAlert=window.alert.bind(window),nativePrompt=window.prompt.bind(window);
window.confirm=message=>nativeConfirm(t(message));window.alert=message=>nativeAlert(t(message));window.prompt=(message,defaultValue='')=>nativePrompt(t(message),defaultValue);

const apiAvailable = !!window.api;
// Keep the renderer alive long enough to show a useful diagnostic if the
// preload bridge failed instead of leaving an empty rectangle.
const bridgeApi = window.api || {};
// Automatically invoke Hello once when a newly opened app window reaches the
// unlock screen. Reloads caused by manual/automatic/system locking retain the
// fallback button without unexpectedly opening another Windows prompt.
const autoHelloOnLaunch=sessionStorage.getItem('sshNexusHelloAttempted')!=='1';
if(autoHelloOnLaunch)sessionStorage.setItem('sshNexusHelloAttempted','1');
if(bridgeApi.i18n)bridgeApi.i18n.settings().then(remote=>{if(remote&&remote.preference&&remote.preference!==i18n.preference){i18n.setLocale(remote.preference);location.reload();}}).catch(()=>{});
const sshEventApi = bridgeApi.ssh || { onData: () => {}, onExit: () => {}, onError: () => {}, onStatus: () => {} };
document.documentElement.dataset.sshNexusBooted = '1';
if (bridgeApi.diagnostics) bridgeApi.diagnostics.log('renderer/app.js started');

// ---------- State ----------
const state = {
  unlocked: false,
  connections: [],
  tabs: [],          // {id, title, root}
  activeTabId: null,
  panes: {},         // paneId -> {sessionId, terminal, fitAddon, hostEl, connected}
  activePaneId: null,
  maximizedPaneId: null,
  fontSize: 13,
  scrollback: 10000,
  terminalThemeName: 'dark',
  autoLockMinutes: 0,
  customSnippets: [],
  broadcastMode: false,
  sftpSessionId: null,
  sftpPath: '/',
  verifySftpTransfers: false,
  terminalClipboardShortcuts: true,
  sftpTransferActive: false,
  sftpCancelRequested: false,
  sftpSortKey: 'name',
  sftpSortDirection: 1,
  monitorTimer: null,
  paletteItems: [],
  paletteIndex: 0,
  authChallengeToken: null,
  replay: null,
  notifyOnDisconnect: true,
  pendingExternalConnect: null,
  pendingUpdateInfo: null,
  connModal: null,
  workspaces: []
};
const terminalThemes = {
  dark: { background:'#000000', foreground:'#d4d4d4', cursor:'#ffffff', selectionBackground:'#264f78' },
  solarized: { background:'#002b36', foreground:'#839496', cursor:'#93a1a1', selectionBackground:'#075b6b' },
  light: { background:'#ffffff', foreground:'#202020', cursor:'#000000', selectionBackground:'#add6ff' },
  matrix: { background:'#020b05', foreground:'#65f58a', cursor:'#b7ffc8', selectionBackground:'#145c2c' }
};

let paneCounter = 0;
function newPaneId() { return 'p_' + (++paneCounter); }
let tabCounter = 0;
function newTabId() { return 't_' + (++tabCounter); }
let sessionToPane = {};
const orphanSessionData = new Map();
const orphanSessionStatus = new Map();
const orphanSessionEnd = new Map();

// ---------- Utilities ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = t(text);
  return e;
}

function setStatus(msg) { document.getElementById('statusbar').textContent = 'SSH Nexus — ' + t(msg); }
function toast(message, ms = 4500) {
  const box = document.getElementById('toast');
  box.textContent = t(message); box.style.display = 'block';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { box.style.display = 'none'; }, ms);
}

// Resizable connection sidebar
const sidebar=document.getElementById('sidebar');sidebar.style.width=(localStorage.getItem('sshNexusSidebarWidth')||260)+'px';
document.getElementById('sidebarResize').addEventListener('mousedown',e=>{e.preventDefault();const start=e.clientX,startWidth=sidebar.getBoundingClientRect().width;const move=ev=>{const w=Math.max(190,Math.min(520,startWidth+ev.clientX-start));sidebar.style.width=w+'px';};const up=()=>{document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',up);localStorage.setItem('sshNexusSidebarWidth',Math.round(sidebar.getBoundingClientRect().width));fitAllTerminals();};document.addEventListener('mousemove',move);document.addEventListener('mouseup',up);});
bridgeApi.security.onLocked(reason=>{saveRecoveryState();bridgeApi.notification.show('SSH Nexusをロックしました',reason==='system-suspend'?'PCのスリープを検出しました。':'Windowsの画面ロックを検出しました。');location.reload();});
function handlePendingExternalConnect(){const request=state.pendingExternalConnect;if(!request||!state.unlocked)return;if(document.getElementById('modalBackdrop')){setTimeout(handlePendingExternalConnect,750);return;}state.pendingExternalConnect=null;let paneId=state.activePaneId,pane=paneId&&state.panes[paneId];if(!pane||pane.sessionId){newTab(null);const tab=getActiveTab();paneId=tab&&tab.root.type==='leaf'?tab.root.paneId:state.activePaneId;}window.pickConnectionForPane(paneId,request);}
bridgeApi.external.onConnectRequest(request=>{if(!request||!request.host)return;state.pendingExternalConnect={host:String(request.host).slice(0,255),username:String(request.username||'').slice(0,128),port:Number(request.port)||22};if(state.unlocked)handlePendingExternalConnect();else toast('外部からの接続要求を受信しました。保管庫を解除すると確認画面を表示します。',7000);});
if(bridgeApi.updates)bridgeApi.updates.onAvailable(info=>{if(state.unlocked)showAvailableUpdate(info);else state.pendingUpdateInfo=info;});

// ---------- Unlock / Setup ----------
function showUnlock() {
  if (bridgeApi.diagnostics) bridgeApi.diagnostics.log('showUnlock entered');
  const box=document.getElementById('unlockBox');box.innerHTML='';
  if(!apiAvailable||!bridgeApi.vault){box.appendChild(el('h3',null,'起動エラー'));box.appendChild(el('div','error','Windows連携モジュールを読み込めませんでした。修正版を再展開して起動してください。'));const retry=el('button',null,'再読み込み');retry.style.marginTop='12px';retry.onclick=()=>location.reload();box.appendChild(retry);return;}
  Promise.all([bridgeApi.vault.exists(),bridgeApi.vault.securityInfo()]).then(([exists,security])=>{
    if(!exists){
      box.appendChild(el('h3',null,'安全な保管庫を作成'));
      box.appendChild(el('div','hint','通常はWindows Helloで解除します。Windowsの故障時に使う16文字以上の回復パスフレーズを設定してください。短い数字PINは使用できません。'));
      box.appendChild(field('回復パスフレーズ（16文字以上）','password','pin'));box.appendChild(field('回復パスフレーズを確認','password','pin2'));
      const err=el('div','error',''),actions=el('div','modal-actions'),btn=el('button',null,'安全な保管庫を作成');box.appendChild(err);
      btn.onclick=async()=>{const p=document.getElementById('pin').value,p2=document.getElementById('pin2').value;if(p.length<16){err.textContent='回復パスフレーズは16文字以上必要です';return;}if(p!==p2){err.textContent='回復パスフレーズが一致しません';return;}try{await bridgeApi.vault.setup(p);const hs=await bridgeApi.winhello.status();if(hs.supported)await bridgeApi.winhello.enroll();await completeUnlock('新しい暗号化保管庫を作成しました');}catch(e){err.textContent=e.message;}};
      actions.appendChild(btn);box.appendChild(actions);return;
    }
    const legacy=!!security.migrationRequired;box.appendChild(el('h3',null,legacy?'セキュリティ移行が必要です':'保管庫を解除'));
    if(legacy)box.appendChild(el('div','hint','すべての接続情報を完全暗号化するため、現在のPINを一度だけ入力してください。続けて新しい回復パスフレーズを設定します。'));
    box.appendChild(field(legacy?'現在のPIN':'回復パスフレーズ','password','pin'));
    const err=el('div','error',''),actions=el('div','modal-actions'),btn=el('button',null,legacy?'確認して移行':'解除');box.appendChild(err);
    btn.onclick=async()=>{try{await doUnlock(document.getElementById('pin').value,box,err);}catch(e){err.textContent=e.message||'解除できませんでした';}};
    document.getElementById('pin').addEventListener('keydown',e=>{if(e.key==='Enter')btn.click();});actions.appendChild(btn);box.appendChild(actions);addWinHello(box,err,!legacy&&autoHelloOnLaunch).catch(e=>{err.textContent='Windows Hello: '+e.message;});
  }).catch(e=>{box.innerHTML='';box.appendChild(el('h3',null,'保管庫の初期化エラー'));box.appendChild(el('div','error',e?.message||String(e)));const retry=el('button',null,'再試行');retry.style.marginTop='12px';retry.onclick=showUnlock;box.appendChild(retry);});
}

function field(label, type, id, value) {
  const wrap=el('div','field'),l=el('label',null,label);l.setAttribute('for',id);const input=document.createElement('input');input.type=type;input.id=id;if(value!=null)input.value=value;wrap.appendChild(l);wrap.appendChild(input);return wrap;
}
async function loadSecureUiData(){
  const migrations=[['sshNexusSettings','settings'],['sshNexusRecovery','recovery'],['sshNexusWorkspaces','workspaces']];
  for(const [oldKey,newKey] of migrations){try{const raw=localStorage.getItem(oldKey);if(raw&&await bridgeApi.secureData.get(newKey)==null)await bridgeApi.secureData.set(newKey,JSON.parse(raw));localStorage.removeItem(oldKey);}catch(e){}}
  const settings=await bridgeApi.secureData.get('settings');if(settings&&typeof settings==='object')Object.assign(state,settings);
  state.workspaces=await bridgeApi.secureData.get('workspaces')||[];
}
async function completeUnlock(statusText='unlocked'){
  state.unlocked=true;await loadSecureUiData();resetAutoLockTimer();document.getElementById('unlockScreen').style.display='none';await refreshConnections();const restored=state.tabs.length?false:await maybeRestoreRecovery();if(state.tabs.length===0&&!restored)newTab(null);renderTabs();renderActiveTab();setStatus(statusText);handlePendingExternalConnect();if(state.pendingUpdateInfo){const info=state.pendingUpdateInfo;state.pendingUpdateInfo=null;setTimeout(()=>showAvailableUpdate(info),500);}
}
function showSecurityMigration(box,err){
  box.innerHTML='';box.appendChild(el('h3',null,'完全暗号化へ移行'));
  box.appendChild(el('div','hint','接続先、ユーザー名、メモ、ホスト鍵を含む保管庫全体を、ランダムな256ビット鍵で暗号化します。移行後はWindows Helloで解除し、この回復パスフレーズは緊急時だけ使用します。'));
  box.appendChild(field('新しい回復パスフレーズ（16文字以上）','password','migrationPass'));box.appendChild(field('回復パスフレーズを確認','password','migrationPass2'));
  const migrationError=el('div','error',''),actions=el('div','modal-actions'),run=el('button',null,'バックアップして完全暗号化へ移行');box.appendChild(migrationError);
  run.onclick=async()=>{const p=document.getElementById('migrationPass').value,p2=document.getElementById('migrationPass2').value;if(p.length<16){migrationError.textContent='16文字以上必要です';return;}if(p!==p2){migrationError.textContent='回復パスフレーズが一致しません';return;}run.disabled=true;migrationError.textContent='暗号化とバックアップを実行しています…';try{const result=await bridgeApi.vault.migrateSecurity(p);await completeUnlock(`完全暗号化へ移行しました — バックアップ: ${result.backupPath}`);}catch(e){migrationError.textContent=e.message;run.disabled=false;}};
  actions.appendChild(run);box.appendChild(actions);
}
async function addWinHello(box,err,autoStart=false){
  const status=await bridgeApi.winhello.status();if(!status.supported||!status.enrolled||status.migrationRequired)return;
  const btn=el('button','secondary','Windows Hello / PINで解除');btn.style.cssText='margin-top:8px;width:100%;';btn.onclick=async()=>{if(btn.disabled||state.unlocked)return;btn.disabled=true;err.textContent='Windows Helloを待っています…';try{const r=await bridgeApi.winhello.unlock();if(r.ok)await completeUnlock('Windows Helloで解除しました');else{err.textContent=r.error||'Windows Hello認証に失敗しました';btn.disabled=false;}}catch(e){err.textContent=e.message||'Windows Hello認証に失敗しました';btn.disabled=false;}};box.appendChild(btn);
  if(autoStart)setTimeout(()=>{if(!state.unlocked&&btn.isConnected&&!btn.disabled)btn.click();},300);
}
async function doUnlock(secret,box,err){
  const result=await bridgeApi.vault.unlock(secret);if(result?.migrationRequired){showSecurityMigration(box,err);return;}
  const helloStatus=await bridgeApi.winhello.status();if(helloStatus.supported&&!helloStatus.enrolled)await bridgeApi.winhello.enroll();await completeUnlock();
}

// ---------- Connections ----------
async function refreshConnections() {
  state.connections = await bridgeApi.vault.list();
  renderConnections();
}

function renderConnections() {
  const list = document.getElementById('connList');
  list.innerHTML = '';
  const query = (document.getElementById('connSearch').value || '').trim().toLowerCase();
  const visible = state.connections.filter(c => !query || [c.name,c.host,c.username,c.group].join(' ').toLowerCase().includes(query)).sort((a,b)=>Number(b.favorite)-Number(a.favorite)||(b.lastConnectedAt||0)-(a.lastConnectedAt||0)||(a.name||'').localeCompare(b.name||''));
  if (!visible.length) {
    list.appendChild(el('div', 'empty-list', state.connections.length ? '一致する接続先がありません' : '接続先がありません\n「＋ 追加」から登録してください'));
    return;
  }
  const groups = {};
  visible.forEach(c => { const g = c.group || '未分類'; (groups[g] = groups[g] || []).push(c); });
  Object.keys(groups).sort().forEach(g => {
    if (g !== '未分類' || Object.keys(groups).length > 1) {
      const h = el('div', null, g);
      h.style.cssText = 'font-size:11px;color:#888;margin:8px 4px 2px;text-transform:uppercase;';
      list.appendChild(h);
    }
    groups[g].forEach(c => {
      const item = el('div', 'conn-item' + (state.selectedConnId === c.id ? ' active' : ''));
      const panesForConn = Object.values(state.panes).filter(p => p.connId === c.id);
      const dot = el('span', 'conn-status' + (panesForConn.some(p=>p.connected) ? ' connected' : panesForConn.some(p=>p.sessionId) ? ' connecting' : ''));
      const info = el('div', 'conn-info');
      info.innerHTML = `<div class="conn-name">${c.favorite?'★ ':''}${escapeHtml(c.name)}</div><div class="conn-meta">${escapeHtml(c.username)}@${escapeHtml(c.host)}:${c.port}</div>`;
      info.onclick = () => { state.selectedConnId = c.id; renderConnections(); openConnection(c.id); };
      const quick = el('div', 'conn-quick');
      const actions = [
        [c.favorite?'★':'☆', c.favorite?'お気に入り解除':'お気に入り', () => toggleFavorite(c.id,!c.favorite)],
        ['✓', '接続テスト', () => testSavedConnection(c.id)],
        ['✎', '編集', () => editConnection(c.id)],
        ['⧉', '複製', () => duplicateConnection(c.id)],
        ['🗑', '削除', () => deleteConnection(c.id)]
      ];
      actions.forEach(([label,title,fn]) => { const b=el('button','secondary',label); b.title=title; b.onclick=(e)=>{e.stopPropagation();fn();}; quick.appendChild(b); });
      item.appendChild(dot); item.appendChild(info); item.appendChild(quick);
      item.oncontextmenu = (e) => { e.preventDefault(); editConnection(c.id); };
      list.appendChild(item);
    });
  });
}

function escapeHtml(s) { return String(s||'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function formatTestResult(result) {
  const n = result.network;
  let text = n.stage==='jump' ? `経路: ${n.address}\n接続先: ${n.host}:${n.port}` : `DNS: ${n.address || '失敗'}\nTCP ${n.port}: ${n.tcpOpen ? `接続成功 (${n.tcpMs} ms)` : '失敗'}\nSSHバナー: ${n.banner || '取得できません'}`;
  if (n.message) text += `\n\n${n.message}`;
  if (result.authentication) text += `\n\n認証: ${result.authentication.ok ? '成功' : '失敗'}\n${result.authentication.message}`;
  return text;
}

async function testSavedConnection(id) {
  const c = state.connections.find(x => x.id === id);
  setStatus(`${c ? c.name : ''} を接続テスト中…`);
  showModal('SSH 接続テスト', body => {
    const r = el('div', 'test-result', 'DNS → TCP → SSHバナー → 認証 の順に確認しています…');
    r.id = 'liveTestResult'; body.appendChild(r);
  }, hideModal, '閉じる');
  try {
    const result = await bridgeApi.ssh.test({ connectionId: id, authenticate: true });
    const box = document.getElementById('liveTestResult');
    if(box){box.textContent=formatTestResult(result)+(result.ok?'\n\nこれは診断のみです。ターミナル接続は開始していません。左の接続先名をクリックすると新しいタブで接続します。':'');box.classList.add(result.ok?'ok':'fail');}
    setStatus(result.ok?'接続テスト成功（診断のみ・未接続）':'接続テスト失敗');
  } catch (e) {
    const box = document.getElementById('liveTestResult');
    if (box) { box.textContent = e.message; box.classList.add('fail'); }
    setStatus('接続テスト失敗');
  }
}

async function toggleFavorite(id, favorite) {
  await bridgeApi.vault.update(id,{favorite}); await refreshConnections();
}

async function duplicateConnection(id) {
  const full=await bridgeApi.vault.get(id);
  delete full.id; full.name=(full.name||full.host)+' のコピー';
  await bridgeApi.vault.add(full); await refreshConnections(); toast('接続先を複製しました');
}

async function deleteConnection(id) {
  const c = state.connections.find(x => x.id === id);
  if (!confirm(`「${c ? c.name : id}」を削除しますか？`)) return;
  await bridgeApi.vault.remove(id);
  await refreshConnections();
  toast('接続先を削除しました');
}

// ---------- Command palette ----------
function paletteActions(){return[
  {icon:'＋',label:'新しいタブ',sub:'Ctrl+T',run:()=>newTab(null)},
  {icon:'＋',label:'接続先を追加',sub:'Ctrl+N',run:()=>addConnectionModal()},
  {icon:'WS',label:'ワークスペース',run:showWorkspaceModal},
  {icon:'▦',label:'複数サーバーへ一括実行',run:showMultiExec},
  {icon:'🔑',label:'SSH鍵を生成',run:showKeyGenerator},
  {icon:'⚙',label:'設定を開く',sub:'Ctrl+,',run:showSettings},
  {icon:'1',label:'選択ペインだけの1画面表示',run:keepOnlyActivePane},
  {icon:'🔒',label:'保管庫をロック',sub:'Ctrl+L',run:async()=>{await bridgeApi.vault.lock();location.reload();}}
];}
function openCommandPalette(){if(!state.unlocked)return;document.getElementById('commandPalette').classList.add('open');const input=document.getElementById('paletteInput');input.value='';state.paletteIndex=0;renderPalette();setTimeout(()=>input.focus(),0);}
function closeCommandPalette(){document.getElementById('commandPalette').classList.remove('open');const p=state.panes[state.activePaneId];p&&p.terminal&&p.terminal.focus();}
function renderPalette(){const q=document.getElementById('paletteInput').value.toLowerCase().trim();const conns=state.connections.map(c=>({icon:c.favorite?'★':'⇥',label:c.name,sub:`${c.username}@${c.host}:${c.port}`,run:()=>openConnection(c.id)}));state.paletteItems=[...conns,...paletteActions()].filter(x=>!q||(x.label+' '+(x.sub||'')).toLowerCase().includes(q)).slice(0,40);state.paletteIndex=Math.max(0,Math.min(state.paletteIndex,state.paletteItems.length-1));const box=document.getElementById('paletteResults');box.innerHTML='';state.paletteItems.forEach((item,i)=>{const row=el('div','palette-item'+(i===state.paletteIndex?' selected':''));row.appendChild(el('span',null,item.icon),el('span',null,item.label));if(item.sub)row.appendChild(el('span','palette-sub',item.sub));row.onmouseenter=()=>{state.paletteIndex=i;box.querySelectorAll('.palette-item').forEach((x,j)=>x.classList.toggle('selected',j===i));};row.onclick=()=>{closeCommandPalette();item.run();};box.appendChild(row);});}
document.getElementById('paletteInput').addEventListener('input',()=>{state.paletteIndex=0;renderPalette();});
document.getElementById('paletteInput').addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();state.paletteIndex=Math.min(state.paletteIndex+1,state.paletteItems.length-1);renderPalette();}else if(e.key==='ArrowUp'){e.preventDefault();state.paletteIndex=Math.max(0,state.paletteIndex-1);renderPalette();}else if(e.key==='Enter'){e.preventDefault();const item=state.paletteItems[state.paletteIndex];if(item){closeCommandPalette();item.run();}}else if(e.key==='Escape')closeCommandPalette();});
document.getElementById('commandPalette').addEventListener('mousedown',e=>{if(e.target.id==='commandPalette')closeCommandPalette();});

function openConnection(connId) {
  // A connection selected from the sidebar/palette always gets its own tab.
  // This makes connection progress visible and never replaces an existing blank/work tab.
  newTab(connId);
}

function setPaneTabTitle(paneId,title){const tab=state.tabs.find(t=>{let found=false;forEachPane(t.root,id=>{if(id===paneId)found=true;});return found;});if(tab&&title){tab.title=title;renderTabs();}}
function attachSessionToPane(sid,paneId){const pane=state.panes[paneId];if(!pane)return;pane.sessionId=sid;sessionToPane[sid]=paneId;ensureTerminal(paneId);const status=orphanSessionStatus.get(sid);if(status){orphanSessionStatus.delete(sid);handleSshStatus(sid,status.stage,status.msg);}const pending=orphanSessionData.get(sid);if(pending){orphanSessionData.delete(sid);handleSshData(sid,pending);}const ended=orphanSessionEnd.get(sid);if(ended){orphanSessionEnd.delete(sid);ended.type==='error'?handleSshError(sid,ended.value):handleSshExit(sid,ended.value);}}

async function connectPane(paneId, connId, isRetry = false) {
  const pane = state.panes[paneId];
  if (!pane) return;
  clearTimeout(pane.reconnectTimer);
  pane.manualClose = false;
  if (!isRetry) pane.reconnectAttempts = 0;
  if (pane.sessionId) { bridgeApi.ssh.disconnect(pane.sessionId); pane.sessionId = null; }
  pane.connId = connId;
  pane.connected = false;
  pane.connecting = true;
  saveRecoveryState();
  const target = state.connections.find(c => c.id === connId);
  setPaneTabTitle(paneId,`${target?target.name:'SSH'} • 接続中`);
  if(getActiveTab()&&state.activePaneId===paneId)renderActiveTab();
  setStatus(`${target ? target.name : 'SSH'} に接続しています…`);
  try {
    const sid = await bridgeApi.ssh.connect(connId);
    attachSessionToPane(sid,paneId);
    const current=state.panes[paneId];if(current&&current.terminal&&current.connecting){current.terminal.write(t(`\x1b[36m[接続中]\x1b[0m ${target?target.name:'SSH'} へ接続しています…\r\n`));current.terminal.focus();}
    renderConnections();
  } catch (e) {
    pane.connecting=false;setPaneTabTitle(paneId,`${target?target.name:'SSH'} • 失敗`);renderActiveTab();
    setStatus('接続失敗: ' + e.message);
    toast(e.message,8000);
    scheduleReconnect(paneId);
  }
}

async function startAutoTunnels(sessionId, connection){const profiles=connection&&Array.isArray(connection.autoTunnels)?connection.autoTunnels:[];if(!profiles.length)return;let started=0;const failures=[];for(const t of profiles){try{if(t.type==='local')await bridgeApi.tunnel.start(sessionId,t);else if(t.type==='remote')await bridgeApi.tunnel.startRemote(sessionId,t);else if(t.type==='socks5')await bridgeApi.tunnel.startSocks(sessionId,t);else throw new Error('未対応の転送形式');started++;}catch(e){failures.push(e.message);}}if(started)toast(`${connection.name}: 自動ポート転送を${started}件開始しました`,6000);if(failures.length)toast(`${connection.name}: 自動転送${failures.length}件に失敗 — ${failures[0]}`,9000);}

function scheduleReconnect(paneId) {
  const pane=state.panes[paneId]; if(!pane||pane.manualClose||!pane.connId)return;
  const conn=state.connections.find(c=>c.id===pane.connId); if(!conn||!conn.autoReconnect)return;
  pane.reconnectAttempts=(pane.reconnectAttempts||0)+1;
  if(pane.reconnectAttempts>5){toast(`${conn.name}: 自動再接続を5回試行しましたが失敗しました`,8000);return;}
  const delay=Math.min(30,(conn.reconnectDelay||3)*Math.pow(2,pane.reconnectAttempts-1));
  setStatus(`${conn.name}: ${delay}秒後に自動再接続 (${pane.reconnectAttempts}/5)`);
  pane.reconnectTimer=setTimeout(()=>{if(state.panes[paneId])connectPane(paneId,pane.connId,true);},delay*1000);
}

async function connectAdhocPane(paneId, opts) {
  const pane = state.panes[paneId];
  if (!pane) return;
  if (pane.sessionId) { bridgeApi.ssh.disconnect(pane.sessionId); pane.sessionId = null; }
  pane.adhocOpts = opts;
  pane.connected = false;pane.connecting=true;
  setPaneTabTitle(paneId,`${opts.host} • 接続中`);renderActiveTab();
  setStatus(`${opts.host}:${opts.port || 22} に接続しています…`);
  try {
    const sid = await bridgeApi.ssh.connectAdhoc(opts);
    attachSessionToPane(sid,paneId);
    if(pane.terminal&&pane.connecting){pane.terminal.write(t(`\x1b[36m[接続中]\x1b[0m ${opts.host} へ接続しています…\r\n`));pane.terminal.focus();}
    renderConnections();
  } catch (e) {
    pane.connecting=false;setPaneTabTitle(paneId,`${opts.host} • 失敗`);renderActiveTab();
    setStatus('connect failed: ' + e.message);
    alert('Connect failed: ' + e.message);
  }
}

// ---------- Workspaces / crash recovery ----------
function createSessionSnapshot(name='Recovery'){const panes={};Object.entries(state.panes).forEach(([id,p])=>{panes[id]={connId:p.connId||null};});return{name,createdAt:Date.now(),activeTabId:state.activeTabId,tabs:JSON.parse(JSON.stringify(state.tabs)),panes};}
function saveRecoveryState(){if(!state.unlocked||!state.tabs.length)return;bridgeApi.secureData.set('recovery',createSessionSnapshot('前回のセッション')).catch(()=>{});}
async function maybeRestoreRecovery(){try{const snapshot=await bridgeApi.secureData.get('recovery');if(!snapshot)return false;if(!snapshot.tabs?.length||Date.now()-(snapshot.createdAt||0)>30*86400000){await bridgeApi.secureData.remove('recovery');return false;}if(!confirm(`前回のセッション（${snapshot.tabs.length}タブ）を復元しますか？`)){await bridgeApi.secureData.remove('recovery');return false;}restoreWorkspace(snapshot);return true;}catch(e){return false;}}
window.addEventListener('beforeunload',saveRecoveryState);
function getWorkspaces(){return Array.isArray(state.workspaces)?state.workspaces:[];}
async function saveCurrentWorkspace(){const name=prompt('ワークスペース名');if(!name)return;const panes={};Object.entries(state.panes).forEach(([id,p])=>{panes[id]={connId:p.connId||null};});const snapshot={name,createdAt:Date.now(),activeTabId:state.activeTabId,tabs:JSON.parse(JSON.stringify(state.tabs)),panes};state.workspaces=getWorkspaces().filter(x=>x.name!==name);state.workspaces.unshift(snapshot);state.workspaces=state.workspaces.slice(0,20);await bridgeApi.secureData.set('workspaces',state.workspaces);toast('ワークスペースを保存しました');showWorkspaceModal();}
function showWorkspaceModal(){showModal('ワークスペース',body=>{const save=el('button',null,'現在のタブと分割を保存');save.onclick=saveCurrentWorkspace;body.appendChild(save);const list=el('div','test-result');const items=getWorkspaces();if(!items.length)list.appendChild(el('div','hint','保存済みワークスペースはありません'));items.forEach((w,index)=>{const row=el('div');row.style.cssText='display:flex;align-items:center;gap:6px;margin:7px 0';const text=el('span',null,`${w.name} — ${w.tabs.length}タブ`);text.style.flex='1';const load=el('button','secondary','開く');load.onclick=()=>restoreWorkspace(w);const del=el('button','danger','削除');del.onclick=async()=>{state.workspaces=getWorkspaces().filter((x,i)=>i!==index);await bridgeApi.secureData.set('workspaces',state.workspaces);showWorkspaceModal();};row.append(text,load,del);list.appendChild(row);});body.appendChild(list);},hideModal,'閉じる');}
function restoreWorkspace(snapshot){
  Object.values(state.panes).forEach(p=>{p.manualClose=true;clearTimeout(p.reconnectTimer);if(p.recording)finishPaneRecording(p,'workspace-change');if(p.sessionId)bridgeApi.ssh.disconnect(p.sessionId);if(p.terminal)try{p.terminal.dispose();}catch(e){}});
  state.tabs=JSON.parse(JSON.stringify(snapshot.tabs));state.panes={};state.maximizedPaneId=null;state.activePaneId=null;
  state.tabs.forEach(tab=>forEachPane(tab.root,id=>{const saved=snapshot.panes[id]||{};state.panes[id]={sessionId:null,terminal:null,fitAddon:null,hostEl:null,termHost:null,connected:false,history:'',connId:saved.connId||null};}));
  state.activeTabId=state.tabs.some(t=>t.id===snapshot.activeTabId)?snapshot.activeTabId:(state.tabs[0]&&state.tabs[0].id);
  paneCounter=Math.max(0,...Object.keys(state.panes).map(id=>parseInt(id.split('_')[1])||0));tabCounter=Math.max(0,...state.tabs.map(t=>parseInt(t.id.split('_')[1])||0));
  hideModal();renderTabs();renderActiveTab();
  if(confirm('保存されている接続先へ自動接続しますか？'))setTimeout(()=>Object.entries(state.panes).forEach(([id,p])=>{if(p.connId&&state.connections.some(c=>c.id===p.connId))connectPane(id,p.connId);}),100);
}

// ---------- Tabs ----------
function newTab(connId) {
  const tabId = newTabId();
  const rootPaneId = newPaneId();
  const targetName=connId?(state.connections.find(c=>c.id===connId)?.name||'SSH'):'';
  state.panes[rootPaneId] = { sessionId:null,terminal:null,fitAddon:null,hostEl:null,termHost:null,connected:false,connecting:!!connId,connId:connId||null,history:'' };
  const tab = { id:tabId,title:connId?`${targetName} • 接続中`:'New Tab',root:{type:'leaf',paneId:rootPaneId} };
  state.tabs.push(tab);
  state.activeTabId = tabId;
  state.activePaneId = rootPaneId;
  renderTabs();
  renderActiveTab();
  if (connId) {
    // connect after render
    setTimeout(() => connectPane(rootPaneId, connId), 50);
  }
}

function closeTab(tabId) {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return;
  // disconnect sessions in tree
  forEachPane(tab.root, (pid) => {
    const p = state.panes[pid];
    if (p) { p.manualClose=true; clearTimeout(p.reconnectTimer); if(p.recording)finishPaneRecording(p,'tab-close'); }
    if (p && p.sessionId) bridgeApi.ssh.disconnect(p.sessionId);
    if (p && p.terminal) { try { p.terminal.dispose(); } catch(e){} }
    delete state.panes[pid];
  });
  state.tabs = state.tabs.filter(t => t.id !== tabId);
  if (state.activeTabId === tabId) {
    state.activeTabId = state.tabs.length ? state.tabs[state.tabs.length-1].id : null;
  }
  if (state.tabs.length === 0) newTab(null);
  renderTabs();
  renderActiveTab();
}

function forEachPane(node, fn) {
  if (!node) return;
  if (node.type === 'leaf') fn(node.paneId);
  else if (node.type === 'split') node.children.forEach(c => forEachPane(c, fn));
}

let tabHoldGesture=null,suppressTabClickId=null;
function firstPaneId(node){if(!node)return null;if(node.type==='leaf')return node.paneId;for(const child of node.children||[]){const id=firstPaneId(child);if(id)return id;}return null;}
function nodeHasPane(node,paneId){if(!node)return false;if(node.type==='leaf')return node.paneId===paneId;return(node.children||[]).some(child=>nodeHasPane(child,paneId));}
function showTabSplitOverlay(sourceTabId){
  const area=document.getElementById('termArea');let overlay=document.getElementById('tabSplitOverlay');if(overlay)overlay.remove();
  overlay=el('div');overlay.id='tabSplitOverlay';overlay.dataset.sourceTabId=sourceTabId;overlay.appendChild(el('div','tab-split-preview'));
  [['left','← 左半分へ'],['right','右半分へ →'],['top','↑ 上半分へ'],['bottom','↓ 下半分へ']].forEach(([side,label])=>{const zone=el('div','tab-split-zone '+side,label);zone.dataset.side=side;zone.onclick=event=>{event.stopPropagation();const source=overlay.dataset.sourceTabId;overlay.remove();splitDraggedTab(source,side);};overlay.appendChild(zone);});
  overlay.appendChild(el('div','tab-split-hint','方向をクリック、またはそのままドラッグして離してください'));
  overlay.onclick=event=>{if(event.target===overlay)overlay.remove();};
  area.appendChild(overlay);return overlay;
}
function tabSplitSideAt(clientX,clientY){const area=document.getElementById('termArea'),r=area.getBoundingClientRect();if(clientX<r.left||clientX>r.right||clientY<r.top||clientY>r.bottom)return null;const x=(clientX-r.left)/r.width,y=(clientY-r.top)/r.height,dist={left:x,right:1-x,top:y,bottom:1-y};const side=Object.keys(dist).sort((a,b)=>dist[a]-dist[b])[0];return dist[side]<=.42?side:null;}
function updateTabSplitOverlay(side){const overlay=document.getElementById('tabSplitOverlay');if(!overlay)return;overlay.classList.remove('preview-left','preview-right','preview-top','preview-bottom');if(side)overlay.classList.add('preview-'+side);}
function discardPaneForSnap(paneId){
  const pane=state.panes[paneId];if(!pane)return;
  pane.manualClose=true;clearTimeout(pane.reconnectTimer);if(pane.recording)finishPaneRecording(pane,'snap-layout');
  if(pane.sessionId){delete sessionToPane[pane.sessionId];bridgeApi.ssh.disconnect(pane.sessionId);}
  if(pane._ro)try{pane._ro.disconnect();}catch(e){}if(pane._fitRaf)cancelAnimationFrame(pane._fitRaf);
  if(pane.terminal)try{pane.terminal.dispose();}catch(e){}delete state.panes[paneId];
}
function snapCurrentTabToEdge(tab,side){
  const ids=[];forEachPane(tab.root,id=>ids.push(id));if(!ids.length)return false;
  const activeValid=ids.includes(state.activePaneId),activePane=activeValid&&state.panes[state.activePaneId];
  const connectedIds=ids.filter(id=>state.panes[id]?.sessionId||state.panes[id]?.connected);
  const primaryId=(activePane&&(activePane.sessionId||activePane.connected)?state.activePaneId:null)||connectedIds[0]||(activeValid?state.activePaneId:ids[0]);
  const otherConnected=connectedIds.filter(id=>id!==primaryId);
  if(otherConnected.length&&!confirm(`ほかに接続中のペインが${otherConnected.length}個あります。切断して2画面のスナップ配置にしますか？`))return false;
  ids.filter(id=>id!==primaryId).forEach(discardPaneForSnap);
  const blankId=newPaneId();state.panes[blankId]={sessionId:null,terminal:null,fitAddon:null,hostEl:null,termHost:null,connected:false,history:''};
  const primary={type:'leaf',paneId:primaryId},blank={type:'leaf',paneId:blankId};
  const dir=(side==='left'||side==='right')?'h':'v',primaryFirst=(side==='left'||side==='top');
  tab.root={type:'split',dir,children:primaryFirst?[primary,blank]:[blank,primary],sizes:[1,1]};
  state.maximizedPaneId=null;state.activePaneId=primaryId;renderTabs();renderActiveTab();saveRecoveryState();toast(t('タブを2画面にスナップしました'));return true;
}
function splitDraggedTab(sourceTabId,side){
  const source=state.tabs.find(tab=>tab.id===sourceTabId),target=getActiveTab();if(!source||!target||!side)return false;
  const dir=(side==='left'||side==='right')?'h':'v',before=(side==='left'||side==='top');state.maximizedPaneId=null;
  if(source.id===target.id)return snapCurrentTabToEdge(target,side);
  const sourceIndex=state.tabs.findIndex(tab=>tab.id===source.id);state.tabs.splice(sourceIndex,1);
  target.root={type:'split',dir,children:before?[source.root,target.root]:[target.root,source.root],sizes:[1,1]};
  state.activeTabId=target.id;state.activePaneId=firstPaneId(source.root)||firstPaneId(target.root);renderTabs();renderActiveTab();saveRecoveryState();toast(t('タブを分割画面へ移動しました'));return true;
}
function beginTabHoldGesture(event,tab,tabEl){
  if(event.button!==0||event.target.classList.contains('close'))return;
  const startX=event.clientX,startY=event.clientY,pointerId=event.pointerId;
  const gesture={tabId:tab.id,tabEl,pointerId,startX,startY,active:false,side:null,timer:null};tabHoldGesture=gesture;
  const detach=()=>{document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',finish,true);document.removeEventListener('pointercancel',cancel,true);};
  const cleanup=(removeOverlay=true)=>{clearTimeout(gesture.timer);if(removeOverlay)document.getElementById('tabSplitOverlay')?.remove();tabEl.classList.remove('tab-hold-ready');tabEl.draggable=true;try{tabEl.releasePointerCapture(pointerId);}catch(e){}if(tabHoldGesture===gesture)tabHoldGesture=null;};
  gesture.timer=setTimeout(()=>{if(tabHoldGesture!==gesture)return;gesture.active=true;tabEl.draggable=false;tabEl.classList.add('tab-hold-ready');try{tabEl.setPointerCapture(pointerId);}catch(e){}showTabSplitOverlay(tab.id);if(navigator.vibrate)navigator.vibrate(25);},350);
  const move=ev=>{if(tabHoldGesture!==gesture||ev.pointerId!==pointerId)return;if(!gesture.active){if(Math.hypot(ev.clientX-startX,ev.clientY-startY)>7){clearTimeout(gesture.timer);tabHoldGesture=null;detach();}}else{gesture.side=tabSplitSideAt(ev.clientX,ev.clientY);updateTabSplitOverlay(gesture.side);}};
  const finish=ev=>{if(ev.pointerId!==pointerId)return;detach();if(gesture.active){ev.preventDefault();suppressTabClickId=tab.id;const side=gesture.side;if(side){cleanup(true);splitDraggedTab(tab.id,side);}else{cleanup(false);const overlay=document.getElementById('tabSplitOverlay');if(overlay){overlay.classList.add('chooser');setTimeout(()=>{if(document.getElementById('tabSplitOverlay')===overlay)overlay.remove();},10000);}}setTimeout(()=>{if(suppressTabClickId===tab.id)suppressTabClickId=null;},0);}else cleanup();};
  const cancel=ev=>{if(ev.pointerId!==pointerId)return;detach();cleanup();};
  document.addEventListener('pointermove',move,true);document.addEventListener('pointerup',finish,true);document.addEventListener('pointercancel',cancel,true);
}

function renderTabs() {
  const tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = '';
  tabsEl.onwheel=e=>{if(Math.abs(e.deltaY)>Math.abs(e.deltaX)){tabsEl.scrollLeft+=e.deltaY;e.preventDefault();}};
  state.tabs.forEach(tab => {
    const tabEl = el('div', 'tab' + (tab.id === state.activeTabId ? ' active' : ''));
    tabEl.title=t('長押ししてターミナルの端へドラッグすると分割できます');
    tabEl.innerHTML = `<span>${escapeHtml(tab.title)}</span><span class="close">✕</span>`;
    tabEl.draggable=true;
    tabEl.ondragstart=e=>{e.dataTransfer.setData('text/tab-id',tab.id);e.dataTransfer.effectAllowed='move';};
    tabEl.ondragover=e=>{e.preventDefault();e.dataTransfer.dropEffect='move';};
    tabEl.ondrop=e=>{e.preventDefault();const from=e.dataTransfer.getData('text/tab-id');if(!from||from===tab.id)return;const fromIndex=state.tabs.findIndex(x=>x.id===from),toIndex=state.tabs.findIndex(x=>x.id===tab.id);const [moved]=state.tabs.splice(fromIndex,1);state.tabs.splice(toIndex,0,moved);renderTabs();};
    tabEl.addEventListener('pointerdown',e=>beginTabHoldGesture(e,tab,tabEl));
    tabEl.onclick = (e) => {
      if (e.target.classList.contains('close')||suppressTabClickId===tab.id) return;
      state.activeTabId = tab.id;
      renderTabs();
      renderActiveTab();
    };
    tabEl.querySelector('.close').onclick = (e) => { e.stopPropagation(); closeTab(tab.id); };
    tabsEl.appendChild(tabEl);
  });
  const activeTab=tabsEl.querySelector('.tab.active');if(activeTab)activeTab.scrollIntoView({block:'nearest',inline:'nearest'});
  saveRecoveryState();
}

function getActiveTab() { return state.tabs.find(t => t.id === state.activeTabId); }

function renderActiveTab() {
  const area = document.getElementById('termArea');
  area.innerHTML = '';
  const tab = getActiveTab();
  if (!tab) return;
  const renderRoot = state.maximizedPaneId ? { type:'leaf', paneId:state.maximizedPaneId } : tab.root;
  renderNode(renderRoot, area);
  // fit all terminals after layout
  setTimeout(fitAllTerminals, 50);
}

// ---------- Pane tree rendering ----------
function renderNode(node, container) {
  if (node.type === 'leaf') {
    const pane = state.panes[node.paneId];
    const paneEl = el('div', 'pane' + (state.activePaneId === node.paneId ? ' focused' : ''));
    paneEl.dataset.paneId = node.paneId;
    // toolbar
    const tb = el('div', 'pane-toolbar');
    const btnReconnect = el('button', null, '↻ 再接続');
    btnReconnect.title = 'このペインを再接続';
    btnReconnect.onclick = () => {
      if (pane.connId) connectPane(node.paneId, pane.connId);
      else if (pane.adhocOpts) connectAdhocPane(node.paneId, pane.adhocOpts);
      else window.pickConnectionForPane(node.paneId);
    };
    const btnSftp = el('button', null, '⇅ SFTP');
    btnSftp.title = 'SFTPファイルブラウザー';
    btnSftp.onclick = () => pane.connected && pane.sessionId ? openSftp(pane.sessionId) : toast('SSH接続後にSFTPを開けます');
    const btnTunnel = el('button', null, '⇆ 転送');
    btnTunnel.title = 'ローカルポートフォワード';
    btnTunnel.onclick = () => pane.connected && pane.sessionId ? showTunnelModal(pane.sessionId) : toast('SSH接続後にポート転送を設定できます');
    const btnMonitor = el('button', null, '▦ 監視');
    btnMonitor.title = 'サーバー監視ダッシュボード';
    btnMonitor.onclick = () => pane.connected && pane.sessionId ? showMonitor(pane.sessionId, pane.connId) : toast('SSH接続後に監視画面を開けます');
    const btnMax = el('button', null, state.maximizedPaneId === node.paneId ? '❐ 戻す' : '□ 最大化');
    btnMax.title = 'ペイン最大化を切り替え';
    btnMax.onclick = () => { state.maximizedPaneId = state.maximizedPaneId === node.paneId ? null : node.paneId; renderActiveTab(); };
    const btnClose = el('button', null, '✕');
    btnClose.title = 'ペインを閉じる';
    btnClose.onclick = () => closePane(node.paneId);
    tb.appendChild(btnReconnect);
    tb.appendChild(btnSftp);
    tb.appendChild(btnTunnel);
    tb.appendChild(btnMonitor);
    tb.appendChild(btnMax);
    tb.appendChild(btnClose);
    paneEl.appendChild(tb);

    const host = el('div', 'terminal-host');
    paneEl.appendChild(host);
    pane.hostEl = host;

    if (pane.sessionId) {
      ensureTerminal(node.paneId);
    } else {
      const ph = el('div', 'placeholder');
      ph.appendChild(el('div', null, pane.connecting?'接続中…':pane.connId||pane.adhocOpts?'切断されています':'未接続'));
      const connectButton = el('button','secondary',pane.connecting?'接続しています…':pane.connId||pane.adhocOpts?'↻ 再接続':'接続先を選択');connectButton.disabled=!!pane.connecting;
      connectButton.onclick = () => {
        if (pane.connId) connectPane(node.paneId, pane.connId);
        else if (pane.adhocOpts) connectAdhocPane(node.paneId, pane.adhocOpts);
        else window.pickConnectionForPane(node.paneId);
      };
      ph.appendChild(connectButton);
      host.appendChild(ph);
    }

    paneEl.addEventListener('mousedown', () => {
      state.activePaneId = node.paneId;
      document.querySelectorAll('.pane.focused').forEach(x => x.classList.remove('focused'));
      paneEl.classList.add('focused');
      updateRecordButton();
    });
    container.appendChild(paneEl);
    state.activePaneId = state.activePaneId || node.paneId;
  } else if (node.type === 'split') {
    const c = el('div', 'pane-container ' + node.dir);
    node.children.forEach((child, idx) => {
      const wrapper = el('div', null);
      wrapper.style.flex = (node.sizes[idx] || 1) + ' 1 0';
      wrapper.style.minWidth = '0';
      wrapper.style.minHeight = '0';
      wrapper.style.display = 'flex';
      wrapper.style.flexDirection = 'column';
      renderNode(child, wrapper);
      c.appendChild(wrapper);
      if (idx < node.children.length - 1) {
        const splitter = el('div', 'splitter');
        c.appendChild(splitter);
        attachSplitter(splitter, c, node, idx);
      }
    });
    container.appendChild(c);
  }
}

function attachSplitter(splitter, container, node, idx) {
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const isH = node.dir === 'h';
    const startPos = isH ? e.clientX : e.clientY;
    const startSizes = [...node.sizes];
    const totalSize = isH ? container.clientWidth : container.clientHeight;
    // find adjacent wrappers: children idx and idx+1 (accounting for splitters)
    const onMove = (ev) => {
      const cur = isH ? ev.clientX : ev.clientY;
      const delta = cur - startPos;
      const deltaWeight = (delta / totalSize) * startSizes.reduce((a,b)=>a+b,0);
      const newA = Math.max(0.5, startSizes[idx] + deltaWeight);
      const newB = Math.max(0.5, startSizes[idx+1] - deltaWeight);
      node.sizes[idx] = newA;
      node.sizes[idx+1] = newB;
      // update flex
      const wrappers = [...container.children].filter(x => !x.classList.contains('splitter'));
      wrappers[idx].style.flex = newA + ' 1 0';
      wrappers[idx+1].style.flex = newB + ' 1 0';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      fitAllTerminals();
      saveRecoveryState();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

async function copyTerminalSelection(pane){
  const text=pane?.terminal?.getSelection()||'';
  if(!text){toast('コピーする文字を選択してください');return false;}
  try{await navigator.clipboard.writeText(text);pane.terminal.clearSelection();pane.terminal.focus();toast('コピーしました');return true;}catch(e){toast('コピーに失敗しました: '+e.message);return false;}
}
function approveTerminalPaste(text){
  const value=String(text||'');if(!value)return false;
  const lines=value.split(/\r?\n/),hasControl=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
  if((lines.length>1||value.length>500||hasControl)&&!confirm(`複数行または長い内容（${lines.length}行、${value.length}文字）をターミナルへ貼り付けますか？\n\n先頭: ${lines[0].slice(0,100)}`))return false;
  return true;
}
async function pasteTerminalClipboard(pane){
  if(!pane?.terminal)return false;
  try{const text=await navigator.clipboard.readText();if(!approveTerminalPaste(text))return false;pane.terminal.paste(text);pane.terminal.focus();return true;}catch(e){toast('貼り付けに失敗しました: '+e.message);return false;}
}

function fitAndResizePane(pane, force=false) {
  if(!pane||!pane.fitAddon||!pane.terminal||!pane.hostEl)return;
  const rect=pane.hostEl.getBoundingClientRect();
  if(rect.width<10||rect.height<10)return;
  try{pane.fitAddon.fit();}catch(e){return;}
  const cols=pane.terminal.cols,rows=pane.terminal.rows;
  if(pane.recording&&(pane.recording.lastCols!==cols||pane.recording.lastRows!==rows)){
    pane.recording.events.push([Date.now()-pane.recording.startedAt,'resize',cols,rows]);
    pane.recording.lastCols=cols;pane.recording.lastRows=rows;
  }
  if(pane.sessionId&&(force||pane._sentCols!==cols||pane._sentRows!==rows)){
    pane._sentCols=cols;pane._sentRows=rows;
    bridgeApi.ssh.resize(pane.sessionId,cols,rows);
  }
}
function schedulePaneFit(pane,force=false){
  if(!pane)return;
  pane._fitForce=!!(pane._fitForce||force);
  if(pane._fitRaf)return;
  pane._fitRaf=requestAnimationFrame(()=>{pane._fitRaf=0;const mustForce=!!pane._fitForce;pane._fitForce=false;fitAndResizePane(pane,mustForce);});
}

function ensureTerminal(paneId) {
  const pane = state.panes[paneId];
  if (!pane || !pane.hostEl) return;
  if (pane.terminal && pane.termHost === pane.hostEl) return;
  // A tab/split re-render creates a new host element. Recreate xterm there and
  // replay a bounded ANSI history so switching layouts never produces a blank pane.
  if (pane._ro) { try { pane._ro.disconnect(); } catch (e) {} }
  if(pane._fitRaf){cancelAnimationFrame(pane._fitRaf);pane._fitRaf=0;}
  if (pane.terminal) { try { pane.terminal.dispose(); } catch (e) {} }
  const term = new Terminal({ theme: terminalThemes[state.terminalThemeName] || terminalThemes.dark, fontSize: state.fontSize, cursorBlink: true, scrollback: state.scrollback || 10000, allowTransparency: false });
  const FitAddonClass = (typeof FitAddon === 'function') ? FitAddon : (FitAddon && FitAddon.FitAddon);
  const fitAddon = new FitAddonClass();
  term.loadAddon(fitAddon);
  const SearchAddonClass = (typeof SearchAddon === 'function') ? SearchAddon : (SearchAddon && SearchAddon.SearchAddon);
  const searchAddon = new SearchAddonClass(); term.loadAddon(searchAddon);
  pane.terminal = term;
  pane.fitAddon = fitAddon; pane.searchAddon = searchAddon;
  pane.termHost = pane.hostEl;
  // clear host
  pane.hostEl.innerHTML = '';
  term.open(pane.hostEl);
  pane.hostEl.addEventListener('paste',e=>{const text=e.clipboardData&&e.clipboardData.getData('text/plain');if(text&&!approveTerminalPaste(text)){e.preventDefault();e.stopImmediatePropagation();}},true);
  term.attachCustomKeyEventHandler(event=>{
    if(!state.terminalClipboardShortcuts||!event.ctrlKey||event.altKey||event.shiftKey)return true;
    const key=String(event.key||'').toLowerCase();
    if(key==='c'&&term.hasSelection()){if(event.type==='keydown')copyTerminalSelection(pane);return false;}
    if(key==='v'){if(event.type==='keydown')pasteTerminalClipboard(pane);return false;}
    return true;
  });
  pane.hostEl.addEventListener('contextmenu',event=>{if(!state.terminalClipboardShortcuts)return;event.preventDefault();state.activePaneId=paneId;pasteTerminalClipboard(pane);});
  if (pane.history) term.write(pane.history);
  // Fit after layout has committed. The forced resize is intentionally sent
  // even during SSH startup; the backend retains it until the PTY is created.
  schedulePaneFit(pane,true);
  // wire
  term.onData((data) => {
    if (state.broadcastMode) {
      const sent = new Set();
      Object.values(state.panes).forEach(p => { if (p.connected && p.sessionId && !sent.has(p.sessionId)) { sent.add(p.sessionId); bridgeApi.ssh.write(p.sessionId, data); } });
    } else if (pane.sessionId) bridgeApi.ssh.write(pane.sessionId, data);
  });
  // resize observer
  const ro = new ResizeObserver(() => schedulePaneFit(pane));
  ro.observe(pane.hostEl);
  pane._ro = ro;
}

function fitAllTerminals(force=false) {
  Object.values(state.panes).forEach(p=>schedulePaneFit(p,force));
}
window.addEventListener('resize',()=>fitAllTerminals());
document.addEventListener('visibilitychange',()=>{if(!document.hidden)fitAllTerminals(true);});

// global for inline onclick
window.pickConnectionForPane = function(paneId, prefill = {}) {
  // show simple prompt with list
  const names = state.connections.map(c => c.name + ' (' + c.username + '@' + c.host + ')').join('\n');
  // Use modal
  showModal('Connect', (body) => {
    const sel = document.createElement('select');
    sel.id = 'connSelect';
    state.connections.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.name + ' — ' + c.username + '@' + c.host;
      sel.appendChild(o);
    });
    body.appendChild(fieldWrap('Connection', sel));
    const orLabel = el('div', null, '— or ad-hoc —');
    orLabel.style.cssText = 'margin:10px 0 6px;color:#888;font-size:12px;';
    body.appendChild(orLabel);
    if(prefill.host)body.appendChild(el('div','test-result','外部アプリ／リンクから接続要求を受信しました。内容を確認してから接続してください。パスワードはURLから受け取りません。'));
    body.appendChild(field('Host', 'text', 'adhocHost',prefill.host||''));
    body.appendChild(field('Port', 'number', 'adhocPort', prefill.port||22));
    body.appendChild(field('Username', 'text', 'adhocUser',prefill.username||''));
    body.appendChild(field('Password', 'password', 'adhocPass'));
  }, async () => {
    const sel = document.getElementById('connSelect');
    const host = document.getElementById('adhocHost').value.trim();
    if (host) {
      await connectAdhocPane(paneId, {
        host, port: parseInt(document.getElementById('adhocPort').value) || 22,
        username: document.getElementById('adhocUser').value,
        password: document.getElementById('adhocPass').value,
        authType: 'password'
      });
    } else if (sel && sel.value) {
      await connectPane(paneId, sel.value);
    }
    hideModal();
    renderActiveTab();
  });
};

function checkboxField(label, id, checked, hint) {
  const wrap=el('div','field');
  const row=el('label');row.style.cssText='display:flex;align-items:center;gap:8px;color:#ddd;cursor:pointer';
  const input=document.createElement('input');input.type='checkbox';input.id=id;input.checked=!!checked;input.style.width='auto';
  row.appendChild(input);row.appendChild(document.createTextNode(label));wrap.appendChild(row);
  if(hint)wrap.appendChild(el('div','hint',hint));return wrap;
}

function fieldWrap(label, input) {
  const wrap = el('div', 'field');
  const l = el('label', null, label);
  wrap.appendChild(l); wrap.appendChild(input);
  return wrap;
}

// ---------- Split / close pane ----------
function splitPane(paneId, dir, before=false) {
  state.maximizedPaneId = null;
  const tab = getActiveTab();
  if (!tab) return;
  const createdPaneId = newPaneId();
  const newLeaf={type:'leaf',paneId:createdPaneId};
  state.panes[createdPaneId] = { sessionId: null, terminal: null, fitAddon: null, hostEl: null, termHost: null, connected: false, history: '' };
  tab.root = transformNode(tab.root, paneId, (node) => ({
    type: 'split',
    dir: dir,
    children: before?[newLeaf,node]:[node,newLeaf],
    sizes: [1, 1]
  }));
  renderTabs();
  renderActiveTab();
}

function keepOnlyActivePane() {
  const tab = getActiveTab();
  const keepId = state.activePaneId;
  if (!tab || !keepId) return;
  const ids = []; forEachPane(tab.root, id => ids.push(id));
  if (ids.length <= 1) { state.maximizedPaneId = null; renderActiveTab(); return; }
  if (!confirm('選択中以外のペインを閉じて1画面に戻しますか？')) return;
  ids.filter(id => id !== keepId).forEach(id => {
    const p=state.panes[id]; if(!p)return;
    p.manualClose=true;clearTimeout(p.reconnectTimer);if(p.recording)finishPaneRecording(p,'pane-close');
    if(p.sessionId) bridgeApi.ssh.disconnect(p.sessionId);
    if(p._ro) try{p._ro.disconnect();}catch(e){}
    if(p.terminal) try{p.terminal.dispose();}catch(e){}
    delete state.panes[id];
  });
  tab.root = {type:'leaf', paneId:keepId};
  state.maximizedPaneId = null;
  renderActiveTab();
  saveRecoveryState();
  toast('1画面表示に戻しました');
}

function transformNode(node, targetPaneId, fn) {
  if (node.type === 'leaf' && node.paneId === targetPaneId) return fn(node);
  if (node.type === 'split') {
    return { ...node, children: node.children.map(c => transformNode(c, targetPaneId, fn)) };
  }
  return node;
}

function closePane(paneId) {
  const tab = getActiveTab();
  if (!tab) return;
  // if root leaf, close tab
  if (tab.root.type === 'leaf' && tab.root.paneId === paneId) {
    closeTab(tab.id);
    return;
  }
  // remove pane from tree: find parent split and remove child; if one child left, unwrap
  const p = state.panes[paneId];
  if (p) {
    p.manualClose=true; clearTimeout(p.reconnectTimer); if(p.recording)finishPaneRecording(p,'pane-close');
    if (p.sessionId) bridgeApi.ssh.disconnect(p.sessionId);
    if (p.terminal) { try { p.terminal.dispose(); } catch(e){} }
    delete state.panes[paneId];
  }
  tab.root = removePaneNode(tab.root, paneId);
  renderActiveTab();
  saveRecoveryState();
}

function removePaneNode(node, paneId) {
  if (node.type === 'leaf') return node;
  if (node.type === 'split') {
    const newChildren = [];
    const newSizes = [];
    node.children.forEach((c, i) => {
      if (c.type === 'leaf' && c.paneId === paneId) return;
      newChildren.push(removePaneNode(c, paneId));
      newSizes.push(node.sizes[i]);
    });
    if (newChildren.length === 1) return newChildren[0];
    return { ...node, children: newChildren, sizes: newSizes };
  }
  return node;
}

// ---------- SFTP ----------
function normalizeRemotePath(p) {
  const parts=[];
  String(p||'/').split('/').forEach(x=>{if(!x||x==='.')return;if(x==='..')parts.pop();else parts.push(x);});
  return '/'+parts.join('/');
}
function remoteJoin(base,name){ return normalizeRemotePath((base==='/'?'':base)+'/'+name); }
function formatBytes(n){ if(n<1024)return n+' B'; if(n<1048576)return (n/1024).toFixed(1)+' KB'; if(n<1073741824)return (n/1048576).toFixed(1)+' MB'; return (n/1073741824).toFixed(1)+' GB'; }
let sftpDragDepth=0;

function setSftpTransferActive(active){state.sftpTransferActive=active;const button=document.getElementById('sftpCancel');if(button)button.disabled=!active;['sftpUpload','sftpUploadDir','sftpDownloadDir'].forEach(id=>{const b=document.getElementById(id);if(b)b.disabled=active;});}
async function runSftpTransfer(task){if(state.sftpTransferActive){toast('別のSFTP転送が実行中です。完了または中止してから実行してください。',6000);return null;}state.sftpCancelRequested=false;setSftpTransferActive(true);try{return await task();}catch(e){if(state.sftpCancelRequested){toast('SFTP転送を中止しました',6000);return null;}toast('SFTP転送失敗: '+e.message,9000);return null;}finally{state.sftpCancelRequested=false;setSftpTransferActive(false);}}
function renderSftpBreadcrumbs(remotePath){const nav=document.getElementById('sftpBreadcrumbs');nav.innerHTML='';const root=el('button',null,'/');root.type='button';root.onclick=()=>loadSftpPath('/');nav.appendChild(root);let current='';normalizeRemotePath(remotePath).split('/').filter(Boolean).forEach(part=>{nav.appendChild(el('span',null,'›'));current+='/'+part;const target=current,b=el('button',null,part);b.type='button';b.onclick=()=>loadSftpPath(target);nav.appendChild(b);});requestAnimationFrame(()=>{nav.scrollLeft=nav.scrollWidth;});}
async function uploadDroppedSftpItems(files,targetPath){if(!files?.length)return;if(state.sftpTransferActive){toast('転送中です。完了または中止してからドロップしてください。',6000);return;}const droppedFiles=Array.from(files),names=droppedFiles.slice(0,5).map(file=>file.name).join('\n'),extra=droppedFiles.length>5?`\nほか ${droppedFiles.length-5}件`:'';if(!confirm(`${droppedFiles.length}件を ${targetPath} へアップロードしますか？\n\n${names}${extra}\n\nフォルダは再帰的にアップロードされ、既存フォルダへ統合されます。同名ファイルは上書きされます。`))return;const result=await runSftpTransfer(()=>bridgeApi.sftp.uploadDropped(state.sftpSessionId,targetPath,droppedFiles,state.verifySftpTransfers));if(result){const skipped=result.skipped?`・${result.skipped}件スキップ`:'';toast(`${result.files}ファイル・${result.directories}フォルダをアップロードしました${skipped}`,9000);await loadSftpPath(state.sftpPath);}}
async function openSftp(sessionId) {
  if(state.sftpSessionId!==sessionId)state.sftpPath='/';
  state.sftpSessionId=sessionId; state.sftpPath=state.sftpPath||'/';
  document.getElementById('sftpPanel').classList.add('open');
  document.getElementById('sftpSession').textContent=sessionId.slice(-6);
  await loadSftpPath(state.sftpPath);
}
async function loadSftpPath(remotePath) {
  const listEl=document.getElementById('sftpList');
  const normalized=normalizeRemotePath(remotePath); state.sftpPath=normalized;
  document.getElementById('sftpPath').value=normalized;renderSftpBreadcrumbs(normalized);
  document.getElementById('sftpSummary').textContent='読み込み中…';
  listEl.innerHTML='<div class="sftp-empty">読み込み中…</div>';
  try {
    const items=await bridgeApi.sftp.list(state.sftpSessionId,normalized),direction=state.sftpSortDirection;
    const compare=(a,b)=>{if(a.isDirectory!==b.isDirectory)return Number(b.isDirectory)-Number(a.isDirectory);if(state.sftpSortKey==='size')return ((a.size||0)-(b.size||0))*direction||a.name.localeCompare(b.name);if(state.sftpSortKey==='mtime')return ((a.mtime||0)-(b.mtime||0))*direction||a.name.localeCompare(b.name);return a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'})*direction;};items.sort(compare);
    listEl.innerHTML='';
    if(!items.length) listEl.appendChild(el('div','sftp-empty','このフォルダは空です'));
    items.filter(x=>x.name!=='.'&&x.name!=='..').forEach(item=>{
      const row=el('div','sftp-row');
      row.title=item.isDirectory?'ダブルクリックで開く・右クリックで削除':'ダブルクリックでダウンロード・右クリックで削除';
      row.appendChild(el('span',null,item.isDirectory?'📁':item.isSymlink?'🔗':'📄'));
      row.appendChild(el('span','sftp-name',item.name));
      row.appendChild(el('span','sftp-size',item.isDirectory?'':formatBytes(item.size||0)));
      row.appendChild(el('span','sftp-date',item.mtime?new Date(item.mtime*1000).toLocaleDateString():''));
      const more=el('button','secondary sftp-more','⋯');more.title='操作メニュー';more.setAttribute('aria-label',`${item.name} の操作メニュー`);more.onclick=e=>{e.stopPropagation();showSftpActions(item,normalized);};row.appendChild(more);
      if(item.isDirectory){const folderTarget=remoteJoin(normalized,item.name);row.addEventListener('dragenter',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();row.classList.add('drop-target');document.getElementById('sftpPanel').classList.add('folder-target');document.getElementById('sftpDropTarget').textContent=`${item.name} へアップロード`;}});row.addEventListener('dragover',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';}});row.addEventListener('dragleave',e=>{if(!row.contains(e.relatedTarget))row.classList.remove('drop-target');});row.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();row.classList.remove('drop-target');sftpDragDepth=0;document.getElementById('sftpPanel').classList.remove('dragging','folder-target');uploadDroppedSftpItems(e.dataTransfer.files,folderTarget);});}
      row.ondblclick=async()=>{
        const full=remoteJoin(normalized,item.name);
        if(item.isDirectory) loadSftpPath(full);
        else { const r=await runSftpTransfer(()=>bridgeApi.sftp.download(state.sftpSessionId,full,state.verifySftpTransfers)); if(r)toast((r.resumed?'ダウンロードを再開して完了しました: ':'ダウンロードしました: ')+r.localPath+(r.verified?'（SHA-256検証済み）':'')); }
      };
      row.oncontextmenu=e=>{e.preventDefault();showSftpActions(item,normalized);};
      listEl.appendChild(row);
    });
    const visible=items.filter(x=>x.name!=='.'&&x.name!=='..'),folders=visible.filter(x=>x.isDirectory).length,totalBytes=visible.filter(x=>!x.isDirectory).reduce((sum,x)=>sum+(x.size||0),0);document.getElementById('sftpSummary').textContent=`${folders}フォルダ・${visible.length-folders}ファイル${totalBytes?`・${formatBytes(totalBytes)}`:''}　｜　ドラッグ＆ドロップでアップロード`;
    document.querySelectorAll('.sftp-list-head button').forEach(button=>{button.classList.toggle('active',button.dataset.sort===state.sftpSortKey);button.textContent=button.dataset.sort==='name'?'名前':button.dataset.sort==='size'?'サイズ':'更新日';if(button.dataset.sort===state.sftpSortKey)button.textContent+=(state.sftpSortDirection>0?' ▲':' ▼');});
  } catch(e) { listEl.innerHTML='';document.getElementById('sftpSummary').textContent='読み込みに失敗しました';listEl.appendChild(el('div','sftp-empty','SFTPエラー: '+e.message)); }
}

function showSftpActions(item,basePath){const full=remoteJoin(basePath,item.name);showModal(`${item.isDirectory?'📁':'📄'} ${item.name}`,body=>{const actions=el('div');actions.style.cssText='display:grid;grid-template-columns:repeat(2,1fr);gap:7px';const add=(label,cls,fn)=>{const b=el('button',cls,label);b.onclick=fn;actions.appendChild(b);};if(item.isDirectory)add('フォルダを開く','secondary',()=>{hideModal();loadSftpPath(full);});else{add('ダウンロード','secondary',async()=>{const r=await runSftpTransfer(()=>bridgeApi.sftp.download(state.sftpSessionId,full,state.verifySftpTransfers));if(r)toast((r.resumed?'ダウンロードを再開して完了しました: ':'ダウンロードしました: ')+r.localPath+(r.verified?'（SHA-256検証済み）':''));hideModal();});add('テキスト編集','secondary',()=>{hideModal();openRemoteEditor(full,item.name);});}add('名前を変更','secondary',async()=>{const name=prompt('新しい名前',item.name);if(!name||name===item.name)return;try{await bridgeApi.sftp.rename(state.sftpSessionId,full,remoteJoin(basePath,name));hideModal();loadSftpPath(basePath);toast('名前を変更しました');}catch(e){toast('名前変更失敗: '+e.message,7000);}});add('権限を変更','secondary',async()=>{const mode=prompt('権限（例: 755 または 644）',item.isDirectory?'755':'644');if(!mode)return;try{await bridgeApi.sftp.chmod(state.sftpSessionId,full,mode);hideModal();loadSftpPath(basePath);toast('権限を変更しました');}catch(e){toast('権限変更失敗: '+e.message,7000);}});add('削除','danger',async()=>{if(!confirm(`${item.name} を削除しますか？`))return;try{await bridgeApi.sftp.remove(state.sftpSessionId,full,item.isDirectory);hideModal();loadSftpPath(basePath);toast('削除しました');}catch(e){toast('削除失敗: '+e.message,7000);}});body.appendChild(actions);},hideModal,'閉じる');}

async function openRemoteEditor(remotePath,name) {
  toast('リモートファイルを読み込んでいます…');
  try {
    const sessionId=state.sftpSessionId;
    const [content,openedStat]=await Promise.all([bridgeApi.sftp.readText(sessionId,remotePath),bridgeApi.sftp.stat(sessionId,remotePath)]);
    showModal('✎ リモート編集: '+name,body=>{
      const area=document.createElement('textarea');area.id='remoteEditor';area.value=content;area.spellcheck=false;area.style.cssText='width:100%;height:55vh;background:#111;color:#ddd;border:1px solid #555;padding:10px;font:13px Consolas,monospace;resize:vertical';body.appendChild(area);
      body.appendChild(el('div','hint','UTF-8テキスト・最大1MB。外部変更を検出し、同一フォルダの一時ファイルから安全に置換します。'));
    },async()=>{try{
      const current=await bridgeApi.sftp.stat(sessionId,remotePath);
      if((current.mtime!==openedStat.mtime||current.size!==openedStat.size)&&!confirm('このファイルは開いた後に別の場所から変更されています。現在の内容を上書きしますか？'))return;
      await bridgeApi.sftp.writeText(sessionId,remotePath,document.getElementById('remoteEditor').value);
      hideModal();toast('リモートファイルを安全に保存しました');loadSftpPath(state.sftpPath);
    }catch(e){toast('保存失敗: '+e.message,8000);}},'リモートへ保存');
    const cancel=document.querySelector('#modalBackdrop .modal-actions .secondary');
    if(cancel)cancel.onclick=()=>{const area=document.getElementById('remoteEditor');if(area&&area.value!==content&&!confirm('未保存の変更を破棄しますか？'))return;hideModal();};
  } catch(e){toast('ファイルを開けません: '+e.message,8000);}
}

document.getElementById('sftpClose').onclick=()=>{if(state.sftpTransferActive){toast('転送中はSFTPパネルを閉じられません。先に「転送中止」を使用してください。',6000);return;}document.getElementById('sftpPanel').classList.remove('open');};
document.getElementById('sftpGo').onclick=()=>loadSftpPath(document.getElementById('sftpPath').value);
document.getElementById('sftpPath').addEventListener('keydown',e=>{if(e.key==='Enter')loadSftpPath(e.target.value);});
document.getElementById('sftpUp').onclick=()=>loadSftpPath(remoteJoin(state.sftpPath,'..'));
document.getElementById('sftpRefresh').onclick=()=>loadSftpPath(state.sftpPath);
document.querySelectorAll('.sftp-list-head button').forEach(button=>button.onclick=()=>{const key=button.dataset.sort;if(state.sftpSortKey===key)state.sftpSortDirection*=-1;else{state.sftpSortKey=key;state.sftpSortDirection=key==='name'?1:-1;}loadSftpPath(state.sftpPath);});
const sftpPanel=document.getElementById('sftpPanel');
sftpPanel.addEventListener('dragenter',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();sftpDragDepth++;sftpPanel.classList.add('dragging');document.getElementById('sftpDropTarget').textContent=`${state.sftpPath} へファイル・フォルダをアップロード`;}});
sftpPanel.addEventListener('dragover',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';}});
sftpPanel.addEventListener('dragleave',e=>{if(e.dataTransfer?.types?.includes('Files')){sftpDragDepth=Math.max(0,sftpDragDepth-1);if(!sftpDragDepth){sftpPanel.classList.remove('dragging','folder-target');document.querySelectorAll('.sftp-row.drop-target').forEach(row=>row.classList.remove('drop-target'));}}});
sftpPanel.addEventListener('drop',e=>{if(!e.dataTransfer?.files?.length)return;e.preventDefault();sftpDragDepth=0;sftpPanel.classList.remove('dragging','folder-target');document.querySelectorAll('.sftp-row.drop-target').forEach(row=>row.classList.remove('drop-target'));uploadDroppedSftpItems(e.dataTransfer.files,state.sftpPath);});
document.addEventListener('dragover',e=>{if(e.dataTransfer?.types?.includes('Files'))e.preventDefault();});document.addEventListener('drop',e=>{if(e.dataTransfer?.files?.length)e.preventDefault();});
document.getElementById('sftpCancel').onclick=async()=>{if(!state.sftpTransferActive||!state.sftpSessionId)return;if(!confirm('実行中のSFTP転送を中止しますか？\n途中ファイルは再開用に残ります。'))return;const cancelled=await bridgeApi.sftp.cancel(state.sftpSessionId);if(cancelled){state.sftpCancelRequested=true;setStatus('SFTP転送を中止しています…');}};
document.getElementById('sftpUpload').onclick=async()=>{try{const r=await runSftpTransfer(()=>bridgeApi.sftp.upload(state.sftpSessionId,state.sftpPath,state.verifySftpTransfers));if(r){toast((r.resumed?'アップロードを再開して完了しました: ':'アップロードしました: ')+r.remotePath+(r.verified?'（SHA-256検証済み）':''));loadSftpPath(state.sftpPath);}}catch(e){toast('アップロード失敗: '+e.message,7000);}};
document.getElementById('sftpUploadDir').onclick=async()=>{if(!confirm('選択したローカルフォルダを、現在のリモートフォルダへ再帰アップロードしますか？'))return;try{const r=await runSftpTransfer(()=>bridgeApi.sftp.uploadDirectory(state.sftpSessionId,state.sftpPath));if(r){toast(`${r.files}ファイルをアップロードしました`,7000);loadSftpPath(state.sftpPath);}}catch(e){toast('フォルダアップロード失敗: '+e.message,9000);}};
document.getElementById('sftpDownloadDir').onclick=async()=>{if(!confirm(`リモートフォルダ ${state.sftpPath} を再帰ダウンロードしますか？`))return;try{const r=await runSftpTransfer(()=>bridgeApi.sftp.downloadDirectory(state.sftpSessionId,state.sftpPath));if(r)toast(`${r.files}ファイルを ${r.localRoot} へ保存しました`,9000);}catch(e){toast('フォルダダウンロード失敗: '+e.message,9000);}};
function showCreateSftpItem(){showModal('SFTPに新規作成',body=>{const location=el('div','test-result',`作成先: ${state.sftpPath}`);location.style.marginBottom='10px';body.appendChild(location);const type=document.createElement('select');type.id='sftpCreateType';type.add(new Option(`📁 ${t('フォルダ')}`,'directory'));type.add(new Option(`📄 ${t('テキストファイル')}`,'file'));body.appendChild(fieldWrap('種類',type));const name=document.createElement('input');name.id='sftpCreateName';name.type='text';name.placeholder='例: logs または memo.txt';name.maxLength=255;name.autocomplete='off';body.appendChild(fieldWrap('名前',name));const contentWrap=el('div','field');contentWrap.id='sftpCreateContentWrap';contentWrap.hidden=true;contentWrap.appendChild(el('label',null,'初期内容（UTF-8、1MB以下）'));const content=document.createElement('textarea');content.id='sftpCreateContent';content.rows=9;content.placeholder='空のファイルとして作成する場合は未入力のままにします。';contentWrap.appendChild(content);body.appendChild(contentWrap);type.onchange=()=>{contentWrap.hidden=type.value!=='file';name.placeholder=type.value==='file'?'例: memo.txt':'例: logs';};setTimeout(()=>name.focus(),0);},async()=>{const type=document.getElementById('sftpCreateType').value,name=document.getElementById('sftpCreateName').value.trim(),content=document.getElementById('sftpCreateContent').value;if(!name||name==='.'||name==='..'||name.includes('/')||name.includes('\0')){toast('使用できる名前を入力してください。名前に / は使用できません。',7000);return;}if(new TextEncoder().encode(name).length>255){toast('名前が長すぎます（UTF-8で255バイト以下）。',7000);return;}if(type==='file'&&new TextEncoder().encode(content).length>1024*1024){toast('初期内容は1MB以下にしてください。',7000);return;}const remotePath=remoteJoin(state.sftpPath,name);try{if(type==='directory')await bridgeApi.sftp.mkdir(state.sftpSessionId,remotePath);else await bridgeApi.sftp.createTextFile(state.sftpSessionId,remotePath,content);hideModal();await loadSftpPath(state.sftpPath);toast(type==='directory'?`フォルダ「${name}」を作成しました`:`ファイル「${name}」を作成しました`);}catch(e){toast('作成失敗（同名の項目がないか確認してください）: '+(e?.message||e),9000);}},'作成');}
document.getElementById('sftpMkdir').onclick=showCreateSftpItem;
const transferStats=new Map();
bridgeApi.sftp.onProgress((id,p)=>{const now=Date.now(),key=`${id}:${p.direction}:${p.remotePath||p.file||''}`;let stat=transferStats.get(key);if(!stat||p.transferred<stat.last)stat={last:p.transferred,time:now,speed:0};const elapsed=(now-stat.time)/1000;if(elapsed>=0.25){const instant=Math.max(0,p.transferred-stat.last)/elapsed;stat.speed=stat.speed?stat.speed*.65+instant*.35:instant;stat.last=p.transferred;stat.time=now;}transferStats.set(key,stat);const percent=p.total?Math.min(100,Math.round(p.transferred/p.total*100)):0;const name=p.file||(p.remotePath||p.localPath||'').split(/[\\/]/).pop();const eta=stat.speed&&p.total>p.transferred?`・残り約${formatDuration((p.total-p.transferred)/stat.speed)}`:'';const speed=stat.speed?`・${formatBytes(stat.speed)}/秒`:'';setStatus(`SFTP ${String(p.direction).startsWith('upload')?'アップロード':String(p.direction).startsWith('verify')?'SHA-256検証':'ダウンロード'} ${name}: ${percent}% (${formatBytes(p.transferred)} / ${formatBytes(p.total||0)}) ${speed}${eta}`);if(p.total&&p.transferred>=p.total)setTimeout(()=>transferStats.delete(key),2000);});
function formatDuration(seconds){seconds=Math.max(0,Math.round(seconds));if(seconds<60)return seconds+'秒';if(seconds<3600)return Math.ceil(seconds/60)+'分';return Math.floor(seconds/3600)+'時間'+Math.ceil((seconds%3600)/60)+'分';}

// ---------- Port forwarding ----------
function showTunnelModal(sessionId) {
  showModal('⇆ SSHポートフォワード', body=>{
    const row=el('div','field-row'); row.appendChild(field('ローカルポート（0=自動）','number','tunLocal','0')); row.appendChild(field('転送先ポート','number','tunRemotePort',''));
    body.appendChild(row); body.appendChild(field('SSHサーバーから見た転送先ホスト','text','tunRemoteHost','127.0.0.1'));
    body.appendChild(el('div','hint','ローカル転送: SSH先のサービスを手元へ公開します。'));
    const remoteTitle=el('strong',null,'リモートポートフォワード');remoteTitle.style.cssText='display:block;margin-top:14px';body.appendChild(remoteTitle);
    const remoteRow=el('div','field-row');remoteRow.appendChild(field('SSHサーバー側待受ポート（0=自動）','number','rtunBindPort','0'));remoteRow.appendChild(field('手元の転送先ポート','number','rtunTargetPort',''));
    body.appendChild(remoteRow);body.appendChild(field('手元の転送先ホスト','text','rtunTargetHost','127.0.0.1'));
    const remote=el('button','secondary','リモート転送を開始');remote.onclick=async()=>{const config={bindHost:'127.0.0.1',bindPort:parseInt(document.getElementById('rtunBindPort').value)||0,targetHost:document.getElementById('rtunTargetHost').value.trim()||'127.0.0.1',targetPort:parseInt(document.getElementById('rtunTargetPort').value)};if(!config.targetPort){toast('手元の転送先ポートを入力してください');return;}try{const r=await bridgeApi.tunnel.startRemote(sessionId,config);toast(`リモート転送開始: ${r.bindHost}:${r.bindPort} → 手元 ${r.targetHost}:${r.targetPort}`);refreshTunnelList(sessionId);}catch(e){toast('リモート転送開始失敗: '+e.message,7000);}};body.appendChild(remote);
    const socks=el('button','secondary','SOCKS5動的プロキシを開始');socks.style.marginTop='8px';socks.onclick=async()=>{try{const r=await bridgeApi.tunnel.startSocks(sessionId,{localHost:'127.0.0.1',localPort:parseInt(document.getElementById('tunLocal').value)||0});toast(`SOCKS5開始: ${r.localHost}:${r.localPort}`);refreshTunnelList(sessionId);}catch(e){toast('SOCKS5開始失敗: '+e.message,7000);}};body.appendChild(socks);
    const list=el('div','test-result');list.id='tunnelList';body.appendChild(list);refreshTunnelList(sessionId);
  },async()=>{
    const config={localHost:'127.0.0.1',localPort:parseInt(document.getElementById('tunLocal').value)||0,remoteHost:document.getElementById('tunRemoteHost').value.trim()||'127.0.0.1',remotePort:parseInt(document.getElementById('tunRemotePort').value)};
    if(!config.remotePort){toast('転送先ポートを入力してください');return;}
    try{const r=await bridgeApi.tunnel.start(sessionId,config);toast(`転送開始: ${r.localHost}:${r.localPort} → ${r.remoteHost}:${r.remotePort}`);refreshTunnelList(sessionId);}catch(e){toast('転送開始失敗: '+e.message,7000);}
  },'転送開始');
}
async function refreshTunnelList(sessionId){
  const box=document.getElementById('tunnelList');if(!box)return;
  try{const list=await bridgeApi.tunnel.list(sessionId);box.innerHTML='';if(!list.length){box.textContent='実行中の転送はありません';return;}list.forEach(t=>{const row=el('div');row.style.cssText='display:flex;align-items:center;gap:8px;margin:5px 0';const text=el('span',null,t.type==='socks5'?`SOCKS5 ${t.localHost}:${t.localPort}`:t.type==='remote'?`リモート ${t.bindHost}:${t.bindPort} → 手元 ${t.targetHost}:${t.targetPort}`:`ローカル ${t.localHost}:${t.localPort} → SSH先 ${t.remoteHost}:${t.remotePort}`);text.style.flex='1';const stop=el('button','danger','停止');stop.onclick=async()=>{await bridgeApi.tunnel.stop(sessionId,t.id);refreshTunnelList(sessionId);};row.appendChild(text);row.appendChild(stop);box.appendChild(row);});}catch(e){box.textContent=e.message;}
}

// ---------- Monitoring ----------
function parseMonitor(snapshot){
  const memory=(snapshot.memory&&snapshot.memory.stdout||'').trim().split(/\r?\n/).find(x=>/^Mem:/i.test(x));let mem=null;if(memory){const p=memory.trim().split(/\s+/);mem={total:+p[1],used:+p[2]};}
  const diskLines=(snapshot.disk&&snapshot.disk.stdout||'').trim().split(/\r?\n/);let disk=null;if(diskLines[1]){const p=diskLines[1].trim().split(/\s+/);disk={total:+p[1],used:+p[2],percent:p[4]};}
  return {mem,disk,system:(snapshot.system&&snapshot.system.stdout||'').trim(),uptime:(snapshot.uptime&&snapshot.uptime.stdout||'').trim(),processes:(snapshot.processes&&snapshot.processes.stdout||'').trim(),docker:(snapshot.docker&&snapshot.docker.stdout||'').trim()};
}
function monitorCard(title,id){const c=el('div','monitor-card');c.appendChild(el('h4',null,title));const v=el('div','monitor-value','—');v.id=id;c.appendChild(v);return c;}
function showMonitor(sessionId,connId){
  const conn=state.connections.find(c=>c.id===connId);clearInterval(state.monitorTimer);
  showModal('▦ サーバー監視 — '+(conn?conn.name:sessionId.slice(-6)),body=>{
    const controls=el('div');controls.style.cssText='display:flex;gap:6px;align-items:center';const refresh=el('button',null,'↻ 更新');refresh.onclick=()=>refreshMonitor(sessionId);const auto=checkboxField('5秒ごとに自動更新','monitorAuto',true);auto.style.margin='0';controls.append(refresh,auto);body.appendChild(controls);
    const grid=el('div','monitor-grid');grid.append(monitorCard('稼働状況','monUptime'),monitorCard('メモリ','monMemory'),monitorCard('ルートディスク','monDisk'),monitorCard('システム','monSystem'));body.appendChild(grid);
    body.appendChild(el('h4',null,'CPU使用率 上位プロセス'));const proc=el('pre','monitor-pre','読み込み中…');proc.id='monProcesses';body.appendChild(proc);
    body.appendChild(el('h4',null,'Dockerコンテナ'));const docker=el('pre','monitor-pre','読み込み中…');docker.id='monDocker';body.appendChild(docker);
  },hideModal,'閉じる');
  setTimeout(()=>refreshMonitor(sessionId),0);state.monitorTimer=setInterval(()=>{const a=document.getElementById('monitorAuto');if(a&&a.checked)refreshMonitor(sessionId);},5000);
}
async function refreshMonitor(sessionId){
  const proc=document.getElementById('monProcesses');if(!proc)return;
  try{const raw=await bridgeApi.ssh.monitor(sessionId);const m=parseMonitor(raw);const up=document.getElementById('monUptime');if(!up)return;up.textContent=m.uptime||'取得不可';up.style.fontSize='12px';
    const mem=document.getElementById('monMemory');if(m.mem&&m.mem.total){const pct=Math.round(m.mem.used/m.mem.total*100);mem.innerHTML=`${pct}%<div class="monitor-bar"><span style="width:${pct}%"></span></div><div class="hint">${formatBytes(m.mem.used)} / ${formatBytes(m.mem.total)}</div>`;}else mem.textContent='取得不可';
    const disk=document.getElementById('monDisk');if(m.disk&&m.disk.total){const pct=parseInt(m.disk.percent)||Math.round(m.disk.used/m.disk.total*100);disk.innerHTML=`${pct}%<div class="monitor-bar"><span style="width:${pct}%"></span></div><div class="hint">${formatBytes(m.disk.used)} / ${formatBytes(m.disk.total)}</div>`;}else disk.textContent='取得不可';
    const sys=document.getElementById('monSystem');sys.textContent=m.system||'取得不可';sys.style.fontSize='11px';document.getElementById('monProcesses').textContent=m.processes||'取得不可';document.getElementById('monDocker').textContent=m.docker||'Docker未使用または権限なし';
  }catch(e){proc.textContent='監視情報取得エラー: '+e.message;}
}

// ---------- Multi-host command execution ----------
function showMultiExec(){
  const sessions=[];const seen=new Set();Object.values(state.panes).forEach(p=>{if(!p.connected||!p.sessionId||seen.has(p.sessionId))return;seen.add(p.sessionId);const c=state.connections.find(x=>x.id===p.connId);sessions.push({id:p.sessionId,name:c?c.name:p.sessionId.slice(-6)});});
  if(!sessions.length){toast('接続中のSSHセッションがありません');return;}
  showModal('複数サーバーへ一括コマンド実行',body=>{
    body.appendChild(el('div','hint','シェルを経由せず、各サーバーで独立したexecチャネルとして実行します。'));
    const targets=el('div','test-result');sessions.forEach((s,i)=>{const row=checkboxField(s.name,'execTarget'+i,true);row.dataset.session=s.id;targets.appendChild(row);});body.appendChild(targets);
    const area=document.createElement('textarea');area.id='multiExecCommand';area.rows=4;area.placeholder='例: hostname && uptime';area.style.fontFamily='Consolas,monospace';body.appendChild(fieldWrap('実行コマンド',area));
    const results=el('div');results.id='multiExecResults';body.appendChild(results);
  },async()=>{
    const command=document.getElementById('multiExecCommand').value.trim();if(!command){toast('コマンドを入力してください');return;}
    const selected=sessions.filter((s,i)=>document.getElementById('execTarget'+i).checked);if(!selected.length){toast('実行先を選択してください');return;}
    const box=document.getElementById('multiExecResults');box.innerHTML='';selected.forEach(s=>{const wrap=el('div','exec-result');wrap.id='execResult'+s.id;wrap.innerHTML=`<header>${escapeHtml(s.name)} — 実行中…</header><pre>待機中</pre>`;box.appendChild(wrap);});
    await Promise.all(selected.map(async s=>{const wrap=document.getElementById('execResult'+s.id);try{const r=await bridgeApi.ssh.exec(s.id,command,60000);wrap.querySelector('header').textContent=`${s.name} — exit ${r.code}`;wrap.querySelector('pre').textContent=(r.stdout||'')+(r.stderr?'\n[stderr]\n'+r.stderr:'')||'(出力なし)';}catch(e){wrap.querySelector('header').textContent=s.name+' — エラー';wrap.querySelector('pre').textContent=e.message;}}));
  },'選択先で実行');
}

// ---------- Modal helpers ----------
function showModal(title, buildBody, onOk, okLabel = 'OK') {
  hideModal();
  const backdrop = el('div', 'modal-backdrop');
  backdrop.id = 'modalBackdrop';
  const modal = el('div', 'modal');
  modal.appendChild(el('h3', null, title));
  const body = el('div');
  modal.appendChild(body);
  buildBody(body);
  const actions = el('div', 'modal-actions');
  const cancel = el('button', 'secondary', 'キャンセル');
  cancel.onclick = hideModal;
  const ok = el('button', null, okLabel);
  ok.onclick = onOk;
  actions.appendChild(cancel);
  actions.appendChild(ok);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

function hideModal() {
  clearInterval(state.monitorTimer); state.monitorTimer=null;
  if(state.replay){cancelAnimationFrame(state.replay.raf);try{state.replay.term.dispose();}catch(e){}state.replay=null;}
  const b = document.getElementById('modalBackdrop');
  if (b) b.remove();
}

// ---------- Connection CRUD ----------
document.getElementById('connSearch').addEventListener('input', renderConnections);
document.getElementById('btnAdd').onclick = () => addConnectionModal();
document.getElementById('btnImport').onclick = () => showImportOptions();
document.getElementById('btnKeygen').onclick = showKeyGenerator;
document.getElementById('btnSettings').onclick = showSettings;
document.getElementById('btnLock').onclick = async () => {
  await bridgeApi.vault.lock();
  location.reload();
};
document.getElementById('btnNewTab').onclick = () => newTab(null);
document.getElementById('btnWorkspace').onclick = showWorkspaceModal;
document.getElementById('btnSplitH').onclick = () => { if (state.activePaneId) splitPane(state.activePaneId, 'h'); };
document.getElementById('btnSplitV').onclick = () => { if (state.activePaneId) splitPane(state.activePaneId, 'v'); };
document.getElementById('btnSinglePane').onclick = keepOnlyActivePane;
document.getElementById('btnZoomOut').onclick = () => setTerminalFontSize(state.fontSize - 1);
document.getElementById('btnZoomIn').onclick = () => setTerminalFontSize(state.fontSize + 1);
document.getElementById('btnCopy').onclick = () => copyTerminalSelection(state.panes[state.activePaneId]);
document.getElementById('btnPaste').onclick = () => pasteTerminalClipboard(state.panes[state.activePaneId]);
document.getElementById('btnClear').onclick = () => {
  const p=state.panes[state.activePaneId]; if(p && p.terminal){p.terminal.clear(); p.history=''; toast('ターミナルをクリアしました');}
};
document.getElementById('btnSaveLog').onclick = async () => {
  const p=state.panes[state.activePaneId]; if(!p||!p.history){toast('保存できる表示履歴がありません');return;}
  const plain=p.history.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g,'').replace(/\r/g,'');
  const conn=state.connections.find(c=>c.id===p.connId);const name=(conn?conn.name:'ssh-session').replace(/[\\/:*?"<>|]/g,'_');
  const saved=await bridgeApi.dialog.saveText(`${name}-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.log`,plain);
  if(saved)toast('ログを保存しました: '+saved);
};
function updateRecordButton(){const p=state.panes[state.activePaneId];const b=document.getElementById('btnRecord');const on=!!(p&&p.recording);b.classList.toggle('recording-on',on);b.textContent=on?'■ 停止':'● 録画';}
async function finishPaneRecording(pane,reason='manual'){if(!pane||!pane.recording)return null;const rec=pane.recording;pane.recording=null;updateRecordButton();const conn=state.connections.find(c=>c.id===pane.connId);const payload={format:'ssh-nexus-recording',version:2,createdAt:new Date(rec.startedAt).toISOString(),connection:conn?conn.name:(pane.adhocOpts?.host||'SSH'),cols:rec.initialCols||80,rows:rec.initialRows||24,reason,events:rec.events};const safe=(payload.connection||'ssh').replace(/[\\/:*?"<>|]/g,'_'),name=`${safe}-${new Date(rec.startedAt).toISOString().slice(0,19).replace(/:/g,'-')}.ssnrec`;try{const saved=await bridgeApi.recordings.save(name,JSON.stringify(payload));toast(`録画を自動保存しました（${rec.events.length}イベント）: ${saved.name}`,7000);return saved;}catch(e){toast('暗号化録画の自動保存に失敗しました: '+e.message,9000);return null;}}
document.getElementById('btnRecord').onclick=async()=>{const p=state.panes[state.activePaneId];if(!p||!p.connected){toast('接続中のペインを選択してください');return;}if(!p.recording){const cols=p.terminal?.cols||80,rows=p.terminal?.rows||24;p.recording={startedAt:Date.now(),events:[],bytes:0,initialCols:cols,initialRows:rows,lastCols:cols,lastRows:rows};updateRecordButton();toast('サーバー出力の録画を開始しました（停止時に録画フォルダへ自動保存します）');return;}await finishPaneRecording(p,'manual');};
document.getElementById('btnReplay').onclick=showRecordingLibrary;
async function showRecordingLibrary(){try{const [items,settings]=await Promise.all([bridgeApi.recordings.list(),bridgeApi.recordings.settings()]);showModal('▶ 録画一覧',body=>{const top=el('div');top.style.cssText='display:flex;gap:6px;align-items:center;margin-bottom:9px;flex-wrap:wrap';const folder=el('button','secondary','保存先を開く');folder.onclick=()=>bridgeApi.recordings.openDirectory().catch(e=>toast(e.message,7000));const imported=el('button','secondary','以前の録画を取り込む');imported.onclick=async()=>{try{const r=await bridgeApi.recordings.importFile();if(r){hideModal();showRecordingLibrary();}}catch(e){toast('取込失敗: '+e.message,8000);}};top.append(folder,imported,el('span','hint',settings.directory));body.appendChild(top);const list=el('div','test-result');if(!items.length)list.appendChild(el('div','hint','保存済みの録画はありません'));items.forEach(item=>{const row=el('div');row.style.cssText='display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:7px;align-items:center;padding:7px 0;border-bottom:1px solid #333';const text=el('div');text.innerHTML=`<strong>${escapeHtml(item.connection)}</strong><div class="hint">${new Date(item.createdAt).toLocaleString()} ・ ${formatDuration(item.durationMs/1000)} ・ ${item.events}イベント ・ ${formatBytes(item.size)}</div>`;const play=el('button',null,'▶ 再生');play.onclick=async()=>{try{const data=JSON.parse(await bridgeApi.recordings.read(item.name));hideModal();showReplay(data);}catch(e){toast('録画を開けません: '+e.message,8000);}};const del=el('button','danger','削除');del.onclick=async()=>{if(!confirm(`${item.name} を削除しますか？`))return;await bridgeApi.recordings.remove(item.name);hideModal();showRecordingLibrary();};row.append(text,play,del);list.appendChild(row);});body.appendChild(list);},hideModal,'閉じる');}catch(e){toast('録画一覧を開けません: '+e.message,8000);}}

function showReplay(data){showModal('▶ セッション再生 — '+(data.connection||''),body=>{body.closest('.modal').classList.add('replay-modal');const controls=el('div','replay-controls');const pause=el('button','secondary','一時停止');pause.id='replayPause';const speed=document.createElement('select');speed.id='replaySpeed';[['0.5','0.5x'],['1','1x'],['2','2x'],['4','4x']].forEach(([v,l])=>{const o=document.createElement('option');o.value=v;o.textContent=l;if(v==='1')o.selected=true;speed.appendChild(o);});controls.append(pause,speed,el('span','hint',`${data.events.length}イベント ・ ${data.cols||80}列×${data.rows||24}行を維持して再生`));body.appendChild(controls);const timeline=el('div','replay-timeline');const seek=document.createElement('input');seek.type='range';seek.id='replaySeek';seek.min='0';seek.max=String(Math.max(0,Number(data.events?.at(-1)?.[0])||0));seek.step='50';seek.value='0';seek.setAttribute('aria-label',t('再生位置'));const time=el('span','replay-time','00:00 / '+formatDuration((Number(seek.max)||0)/1000));time.id='replayTime';timeline.append(seek,time);body.appendChild(timeline);const host=el('div','replay-host');host.id='replayHost';body.appendChild(host);},hideModal,'閉じる');setTimeout(()=>startReplay(data),0);}
function startReplay(data){
  const host=document.getElementById('replayHost');if(!host)return;
  const clamp=(n,min,max,fallback)=>Math.min(max,Math.max(min,Math.floor(Number(n)||fallback)));
  const initialCols=clamp(data.cols,2,500,80),initialRows=clamp(data.rows,1,200,24);
  const duration=Math.max(0,Number(data.events?.at(-1)?.[0])||0);
  const mount=el('div','replay-terminal-mount');
  mount.style.width=Math.ceil(initialCols*state.fontSize*.64+18)+'px';mount.style.height=Math.ceil(initialRows*state.fontSize*1.24+10)+'px';host.appendChild(mount);
  // Do not use FitAddon here: full-screen TUIs encode cursor movement for the
  // recorded PTY grid. Refitting into the modal makes each byobu/tmux status
  // refresh scroll upward. Keep the original grid and use host scrollbars.
  const term=new Terminal({theme:terminalThemes[state.terminalThemeName]||terminalThemes.dark,fontSize:state.fontSize,cols:initialCols,rows:initialRows,scrollback:10000,allowTransparency:false});
  term.open(mount);term.resize(initialCols,initialRows);
  const syncMount=()=>requestAnimationFrame(()=>{if(!term.element)return;const screen=term.element.querySelector('.xterm-screen');if(!screen)return;const rect=screen.getBoundingClientRect();if(rect.width>0)mount.style.width=Math.ceil(rect.width)+'px';if(rect.height>0)mount.style.height=Math.ceil(rect.height)+'px';host.scrollTop=host.scrollHeight;});
  syncMount();
  const seek=document.getElementById('replaySeek'),timeLabel=document.getElementById('replayTime'),pauseButton=document.getElementById('replayPause');
  const replay={term,data,index:0,time:0,last:performance.now(),paused:false,raf:0,speed:1,busy:false,seeking:false,seekToken:0,userSeeking:false,resumeAfterSeek:false};state.replay=replay;
  const formatReplayTime=ms=>formatDuration(Math.max(0,ms)/1000);
  const updateProgress=(value=replay.time)=>{const safe=Math.max(0,Math.min(duration,Number(value)||0));if(seek&&!replay.userSeeking)seek.value=String(safe);if(timeLabel)timeLabel.textContent=`${formatReplayTime(safe)} / ${formatReplayTime(duration)}`;};
  const schedule=()=>{if(state.replay===replay&&!replay.raf)replay.raf=requestAnimationFrame(tick);};
  const finishSeek=(token,target,resume)=>{if(state.replay!==replay||token!==replay.seekToken)return;replay.time=target;replay.last=performance.now();replay.seeking=false;replay.busy=false;replay.paused=!resume||target>=duration;if(pauseButton)pauseButton.textContent=target>=duration?'再生完了':(replay.paused?'再開':'一時停止');updateProgress();host.scrollTop=host.scrollHeight;schedule();};
  const seekTo=(rawTarget,resume=false)=>{
    const target=Math.max(0,Math.min(duration,Number(rawTarget)||0)),token=++replay.seekToken;
    replay.seeking=true;replay.paused=true;replay.busy=false;replay.index=0;replay.time=target;
    term.reset();term.resize(initialCols,initialRows);syncMount();if(pauseButton)pauseButton.textContent='移動中…';
    const applyNext=()=>{
      if(state.replay!==replay||token!==replay.seekToken)return;
      if(replay.index>=data.events.length||Number(data.events[replay.index][0])>target){finishSeek(token,target,resume);return;}
      const event=data.events[replay.index++];
      if(event.length>=4&&event[1]==='resize'){term.resize(clamp(event[2],2,500,80),clamp(event[3],1,200,24));syncMount();applyNext();return;}
      const output=(event[1]==='data'&&event.length>=3)?event[2]:event[1];term.write(String(output||''),applyNext);
    };
    applyNext();
  };
  const tick=now=>{
    replay.raf=0;if(state.replay!==replay)return;
    if(!replay.paused&&!replay.seeking)replay.time=Math.min(duration,replay.time+(now-replay.last)*replay.speed);replay.last=now;
    while(!replay.paused&&!replay.seeking&&!replay.busy&&replay.index<data.events.length&&Number(data.events[replay.index][0])<=replay.time){
      const event=data.events[replay.index++];
      if(event.length>=4&&event[1]==='resize'){term.resize(clamp(event[2],2,500,80),clamp(event[3],1,200,24));syncMount();continue;}
      const output=(event[1]==='data'&&event.length>=3)?event[2]:event[1];
      replay.busy=true;term.write(String(output||''),()=>{replay.busy=false;host.scrollTop=host.scrollHeight;schedule();});
    }
    updateProgress();
    if(replay.index<data.events.length||replay.busy||replay.paused||replay.seeking)schedule();else if(pauseButton)pauseButton.textContent='再生完了';
  };
  updateProgress(0);schedule();
  pauseButton.onclick=e=>{if(replay.seeking)return;if(replay.time>=duration){seekTo(0,true);return;}replay.paused=!replay.paused;e.currentTarget.textContent=replay.paused?'再開':'一時停止';replay.last=performance.now();schedule();};
  document.getElementById('replaySpeed').onchange=e=>{replay.speed=parseFloat(e.target.value)||1;};
  if(seek){
    seek.addEventListener('pointerdown',()=>{replay.userSeeking=true;replay.resumeAfterSeek=!replay.paused;replay.paused=true;if(pauseButton)pauseButton.textContent='再開';});
    seek.addEventListener('input',()=>{if(timeLabel)timeLabel.textContent=`${formatReplayTime(seek.value)} / ${formatReplayTime(duration)}`;});
    seek.addEventListener('change',()=>{replay.userSeeking=false;seekTo(seek.value,replay.resumeAfterSeek);});
    seek.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(e.key)){replay.resumeAfterSeek=!replay.paused;replay.userSeeking=true;}});
    seek.addEventListener('keyup',()=>{if(replay.userSeeking){replay.userSeeking=false;seekTo(seek.value,replay.resumeAfterSeek);}});
  }
}
function rebuildQuickCommands(){const select=document.getElementById('quickCommand');const old=document.getElementById('customCommandGroup');if(old)old.remove();if(!(state.customSnippets||[]).length)return;const group=document.createElement('optgroup');group.id='customCommandGroup';group.label='カスタム';state.customSnippets.forEach(x=>{const o=document.createElement('option');o.value=x.command;o.textContent=x.name;group.appendChild(o);});select.appendChild(group);}
rebuildQuickCommands();
document.getElementById('quickCommand').onchange = e => {
  const command=e.target.value;e.target.value='';if(!command)return;
  const p=state.panes[state.activePaneId];if(!p||!p.connected||!p.sessionId){toast('接続中のペインを選択してください');return;}
  bridgeApi.ssh.write(p.sessionId,command+'\r');p.terminal&&p.terminal.focus();
};
document.getElementById('btnMultiExec').onclick = showMultiExec;
document.getElementById('btnBroadcast').onclick = e => {
  if(!state.broadcastMode && !confirm('一斉入力を有効にすると、キーボード入力が接続中の全ペインへ送信されます。有効にしますか？'))return;
  state.broadcastMode=!state.broadcastMode;e.currentTarget.classList.toggle('broadcast-on',state.broadcastMode);
  e.currentTarget.textContent=state.broadcastMode?'一斉入力 ON':'一斉入力';toast(state.broadcastMode?'一斉入力を有効にしました':'一斉入力を解除しました');
};
function searchTerminal(next=true){const q=document.getElementById('terminalSearch').value;const p=state.panes[state.activePaneId];if(!q||!p||!p.searchAddon)return false;return next?p.searchAddon.findNext(q,{caseSensitive:false,incremental:true}):p.searchAddon.findPrevious(q,{caseSensitive:false});}
document.getElementById('btnFindNext').onclick=()=>searchTerminal(true);
document.getElementById('btnFindPrev').onclick=()=>searchTerminal(false);
document.getElementById('terminalSearch').addEventListener('input',()=>searchTerminal(true));
document.getElementById('terminalSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();searchTerminal(!e.shiftKey);}if(e.key==='Escape'){e.target.value='';const p=state.panes[state.activePaneId];p&&p.terminal&&p.terminal.clearSelection();p&&p.terminal&&p.terminal.focus();}});
function setTerminalFontSize(size) {
  state.fontSize=Math.max(9,Math.min(28,size));
  Object.values(state.panes).forEach(p=>{if(p.terminal)p.terminal.options.fontSize=state.fontSize;});
  setTimeout(fitAllTerminals,20); setStatus(`文字サイズ ${state.fontSize}px`);
}
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openCommandPalette(); return; }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); addConnectionModal(); return; }
  if (e.ctrlKey && !e.shiftKey && e.key === ',') { e.preventDefault(); showSettings(); return; }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); bridgeApi.vault.lock().then(()=>location.reload()); return; }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); const s=document.getElementById('terminalSearch');s.focus();s.select();return; }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); newTab(null); }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'w') { e.preventDefault(); if (state.activeTabId) closeTab(state.activeTabId); }
  if (e.ctrlKey && (e.key === '+' || e.key === '=')) { e.preventDefault(); setTerminalFontSize(state.fontSize+1); }
  if (e.ctrlKey && e.key === '-') { e.preventDefault(); setTerminalFontSize(state.fontSize-1); }
  if (e.key === 'F5' && state.activePaneId) {
    e.preventDefault(); const p=state.panes[state.activePaneId];
    if(p && p.connId) connectPane(state.activePaneId,p.connId); else if(p && p.adhocOpts) connectAdhocPane(state.activePaneId,p.adhocOpts);
  }
});

function showKeyGenerator() {
  showModal('🔑 SSH鍵ペア生成',body=>{
    const type=document.createElement('select');type.id='keyType';[['ed25519','Ed25519（推奨）'],['rsa','RSA 4096'],['ecdsa','ECDSA P-256']].forEach(([v,l])=>{const o=document.createElement('option');o.value=v;o.textContent=l;type.appendChild(o);});
    body.appendChild(fieldWrap('鍵タイプ',type));body.appendChild(field('コメント','text','keyComment','SSH Nexus'));
    body.appendChild(field('秘密鍵のパスフレーズ（任意）','password','keyPassphrase',''));
    body.appendChild(el('div','hint','秘密鍵はこのPC内で生成され、外部へ送信されません。'));
  },async()=>{
    try{
      const keys=await bridgeApi.ssh.generateKeyPair({type:document.getElementById('keyType').value,comment:document.getElementById('keyComment').value,passphrase:document.getElementById('keyPassphrase').value});
      hideModal();showGeneratedKeys(keys);
    }catch(e){toast('鍵生成失敗: '+e.message,8000);}
  },'鍵を生成');
}
function showGeneratedKeys(keys) {
  showModal('🔑 生成したSSH鍵',body=>{
    const pub=el('textarea');pub.id='generatedPublic';pub.rows=4;pub.value=keys.public;body.appendChild(fieldWrap('公開鍵（サーバーのauthorized_keysへ登録）',pub));
    const priv=el('textarea');priv.id='generatedPrivate';priv.rows=9;priv.value=keys.private;body.appendChild(fieldWrap('秘密鍵（絶対に共有しないでください）',priv));
    const actions=el('div');actions.style.cssText='display:flex;gap:6px;flex-wrap:wrap';
    const cp=el('button','secondary','公開鍵をコピー');cp.onclick=async()=>{await navigator.clipboard.writeText(keys.public);toast('公開鍵をコピーしました');};
    const savePub=el('button','secondary','公開鍵を保存');savePub.onclick=()=>bridgeApi.dialog.saveText('id_ssh_nexus.pub',keys.public);
    const savePriv=el('button','danger','秘密鍵を保存');savePriv.onclick=()=>bridgeApi.dialog.saveText('id_ssh_nexus',keys.private);
    actions.append(cp,savePub,savePriv);body.appendChild(actions);
  },hideModal,'閉じる');
}

function showAvailableUpdate(info){if(!info?.available)return;showModal(`SSH Nexus ${info.version} を利用できます`,body=>{body.appendChild(el('div','hint',`現在のバージョン: ${info.currentVersion}　新しいバージョン: ${info.version}`));if(info.notes){const notes=el('pre','test-result',info.notes);notes.style.cssText='white-space:pre-wrap;max-height:260px;overflow:auto;margin-top:12px';body.appendChild(notes);}body.appendChild(el('div','hint','ダウンロードを押すと、GitHub Releasesから公式インストーラーをブラウザーで開きます。'));},async()=>{try{await bridgeApi.updates.download();hideModal();}catch(e){toast('更新のダウンロードを開けません: '+e.message,8000);}},'ダウンロード');}
async function checkForUpdatesManually(statusEl){statusEl.textContent=t('GitHubで更新を確認しています…');try{const info=await bridgeApi.updates.check();if(!info.configured){statusEl.textContent=t('GitHub公開先がまだ設定されていません。');return;}if(info.available){statusEl.textContent=`バージョン ${info.version} を利用できます。`;setTimeout(()=>showAvailableUpdate(info),250);}else statusEl.textContent=`最新版です（${info.currentVersion}）。`;}catch(e){statusEl.textContent='更新確認に失敗しました: '+e.message;}}
function showRecoveryPassphraseChange(){
  showModal('回復パスフレーズを変更',body=>{body.appendChild(field('現在の回復パスフレーズ','password','oldRecovery'));body.appendChild(field('新しい回復パスフレーズ（16文字以上）','password','newRecovery'));body.appendChild(field('新しい回復パスフレーズを確認','password','newRecovery2'));body.appendChild(el('div','hint','変更してもランダムなマスターキーは維持され、Windows Helloの登録も自動的に更新されます。'));},async()=>{const oldValue=document.getElementById('oldRecovery').value,newValue=document.getElementById('newRecovery').value,confirmValue=document.getElementById('newRecovery2').value;if(newValue.length<16){toast('16文字以上必要です');return;}if(newValue!==confirmValue){toast('回復パスフレーズが一致しません');return;}try{await bridgeApi.vault.changePin(oldValue,newValue);hideModal();toast('回復パスフレーズを変更しました');}catch(e){toast(e.message,8000);}},'変更');
}
function showSettings() {
  showModal('⚙ SSH Nexus 設定',body=>{
    const language=document.createElement('select');language.id='setLanguage';const autoLanguage=document.createElement('option');autoLanguage.value='auto';autoLanguage.textContent=t('自動（Windowsの表示言語）');autoLanguage.selected=i18n.preference==='auto';language.appendChild(autoLanguage);i18n.locales.forEach(code=>{const o=document.createElement('option');o.value=code;o.textContent=i18n.names[code];o.selected=i18n.preference===code;language.appendChild(o);});body.appendChild(fieldWrap('言語',language));
    body.appendChild(field('ターミナル文字サイズ','number','setFont',state.fontSize));
    body.appendChild(field('スクロールバック行数','number','setScrollback',state.scrollback));
    const theme=document.createElement('select');theme.id='setTheme';[['dark','ダーク'],['solarized','Solarized Dark'],['light','ライト'],['matrix','Matrix Green']].forEach(([v,l])=>{const o=document.createElement('option');o.value=v;o.textContent=l;o.selected=state.terminalThemeName===v;theme.appendChild(o);});body.appendChild(fieldWrap('ターミナルテーマ',theme));
    body.appendChild(field('無操作時の自動ロック（分、0=無効）','number','setAutoLock',state.autoLockMinutes||0));
    body.appendChild(checkboxField('切断・再接続をWindows通知で知らせる','setNotifications',state.notifyOnDisconnect));
    body.appendChild(checkboxField('Ctrl+C / Ctrl+V と右クリック貼り付けを有効にする','setClipboardShortcuts',state.terminalClipboardShortcuts,'選択中の文字がある場合だけCtrl+Cでコピーします。選択がなければ通常どおりSIGINTを送信します。'));
    body.appendChild(checkboxField('SFTP単一ファイル転送後にSHA-256で完全性を検証','setSftpVerify',state.verifySftpTransfers,'検証ではリモートファイルをもう一度読み込むため、転送量と所要時間が増えます。再開転送は設定に関係なく必ず検証します。'));
    const recordingBox=el('div','test-result');recordingBox.innerHTML='<strong>録画の自動保存先</strong>';const recordingPath=el('div','hint','読み込み中…');recordingPath.id='recordingFolderPath';const changeRecording=el('button','secondary','保存先を変更');changeRecording.style.margin='8px 6px 0 0';changeRecording.onclick=async()=>{try{const r=await bridgeApi.recordings.chooseDirectory();if(r)recordingPath.textContent=r.directory;}catch(e){toast('保存先変更失敗: '+e.message,8000);}};const openRecording=el('button','secondary','フォルダを開く');openRecording.onclick=()=>bridgeApi.recordings.openDirectory().catch(e=>toast(e.message,7000));recordingBox.append(recordingPath,changeRecording,openRecording);body.appendChild(recordingBox);bridgeApi.recordings.settings().then(r=>{if(document.getElementById('recordingFolderPath'))document.getElementById('recordingFolderPath').textContent=r.directory;}).catch(e=>{recordingPath.textContent=e.message;});
    const snippets=document.createElement('textarea');snippets.id='setSnippets';snippets.rows=5;snippets.value=(state.customSnippets||[]).map(x=>x.name+'='+x.command).join('\n');body.appendChild(fieldWrap('カスタムコマンド（1行ごとに 名前=コマンド）',snippets));
    const security=el('div','test-result');security.innerHTML='<strong>完全暗号化セキュリティ</strong><div class="hint">接続先、ホスト名、ユーザー名、メモ、認証情報、ホスト鍵、録画、監査ログを暗号化します。マスターキーはランダム256ビット、回復鍵はscrypt N=131072で保護されます。</div>';const backup=el('button','secondary','バックアップ作成');backup.style.margin='8px 6px 0 0';backup.onclick=async()=>{const p=await bridgeApi.vault.backup();if(p)toast('バックアップを保存しました: '+p);};const restore=el('button','danger','バックアップ復元');restore.onclick=async()=>{if(!confirm('現在の保管庫をバックアップ内容で置き換えますか？'))return;if(!confirm('復元後はバックアップ作成時の回復パスフレーズが必要です。続行しますか？'))return;try{await bridgeApi.vault.restore();toast('復元しました。再起動します…');}catch(e){toast('復元失敗: '+e.message,8000);}};const exportConfig=el('button','secondary','OpenSSH config書出');exportConfig.style.marginTop='8px';exportConfig.onclick=async()=>{const p=await bridgeApi.sshConfig.export();if(p)toast('OpenSSH configを書き出しました: '+p);};const changeRecovery=el('button','secondary','回復パスフレーズを変更');changeRecovery.style.marginTop='8px';changeRecovery.onclick=showRecoveryPassphraseChange;security.append(backup,restore,exportConfig,changeRecovery);body.appendChild(security);
    const auditBtn=el('button','secondary','接続監査ログを表示');auditBtn.style.marginTop='8px';auditBtn.onclick=showAuditLog;body.appendChild(auditBtn);
    const updateBox=el('div','test-result');updateBox.style.marginTop='10px';updateBox.appendChild(el('strong',null,'アプリの更新'));const updateStatus=el('div','hint','起動時にGitHub Releasesの最新版を確認します。');updateStatus.style.margin='5px 0 8px';const updateBtn=el('button','secondary','今すぐ更新を確認');updateBtn.type='button';updateBtn.onclick=()=>checkForUpdatesManually(updateStatus);updateBox.append(updateStatus,updateBtn);body.appendChild(updateBox);
    const known=el('div','test-result');known.id='knownHostsSettings';known.textContent='登録済みホスト鍵を読み込み中…';body.appendChild(known);setTimeout(loadKnownHostsSettings,0);
    body.appendChild(el('div','hint','設定はこのWindowsユーザーのローカル環境に保存されます。'));
  },async()=>{
    const languagePreference=document.getElementById('setLanguage').value,languageChanged=languagePreference!==i18n.preference;i18n.setLocale(languagePreference);if(bridgeApi.i18n)await bridgeApi.i18n.setLocale(languagePreference);
    state.fontSize=Math.max(9,Math.min(28,parseInt(document.getElementById('setFont').value)||13));
    state.scrollback=Math.max(1000,Math.min(100000,parseInt(document.getElementById('setScrollback').value)||10000));
    state.terminalThemeName=document.getElementById('setTheme').value;state.autoLockMinutes=Math.max(0,parseInt(document.getElementById('setAutoLock').value)||0);state.notifyOnDisconnect=document.getElementById('setNotifications').checked;state.terminalClipboardShortcuts=document.getElementById('setClipboardShortcuts').checked;state.verifySftpTransfers=document.getElementById('setSftpVerify').checked;
    state.customSnippets=document.getElementById('setSnippets').value.split(/\r?\n/).map(line=>{const i=line.indexOf('=');return i>0?{name:line.slice(0,i).trim(),command:line.slice(i+1).trim()}:null;}).filter(x=>x&&x.name&&x.command);
    await bridgeApi.secureData.set('settings',{fontSize:state.fontSize,scrollback:state.scrollback,terminalThemeName:state.terminalThemeName,autoLockMinutes:state.autoLockMinutes,notifyOnDisconnect:state.notifyOnDisconnect,terminalClipboardShortcuts:state.terminalClipboardShortcuts,verifySftpTransfers:state.verifySftpTransfers,customSnippets:state.customSnippets});
    rebuildQuickCommands();
    Object.values(state.panes).forEach(p=>{if(p.terminal){p.terminal.options.fontSize=state.fontSize;p.terminal.options.theme=terminalThemes[state.terminalThemeName];}});fitAllTerminals();resetAutoLockTimer();hideModal();if(languageChanged)location.reload();else toast('設定を保存しました');
  },'保存');
}

async function loadKnownHostsSettings(){const box=document.getElementById('knownHostsSettings');if(!box)return;try{const known=await bridgeApi.knownHosts.list();box.innerHTML='<strong>信頼済みSSHホスト鍵</strong>';const entries=Object.entries(known);if(!entries.length){box.appendChild(el('div','hint','登録はありません'));return;}entries.forEach(([identity,fingerprint])=>{const row=el('div');row.style.cssText='display:flex;gap:6px;align-items:center;margin-top:7px';const text=el('span',null,identity+' — '+fingerprint);text.style.cssText='flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';text.title=fingerprint;const del=el('button','danger','削除');del.onclick=async()=>{if(confirm(identity+' の信頼情報を削除しますか？')){await bridgeApi.knownHosts.remove(identity);loadKnownHostsSettings();}};row.append(text,del);box.appendChild(row);});}catch(e){box.textContent='ホスト鍵一覧エラー: '+e.message;}}
async function showAuditLog(){const entries=await bridgeApi.audit.list(500);showModal('接続監査ログ',body=>{const controls=el('div');controls.style.cssText='display:flex;gap:6px;margin-bottom:8px';const exp=el('button','secondary','ログを書き出す');exp.onclick=async()=>{const p=await bridgeApi.audit.export();if(p)toast('監査ログを保存しました');};const clear=el('button','danger','ログを消去');clear.onclick=async()=>{if(confirm('監査ログを消去しますか？')){await bridgeApi.audit.clear();showAuditLog();}};controls.append(exp,clear);body.appendChild(controls);const pre=el('pre','monitor-pre');pre.style.maxHeight='60vh';pre.textContent=entries.length?entries.map(x=>`${x.time}  ${x.event.padEnd(18)}  ${x.name||x.host||''} ${x.username||''} ${x.message||''}`).join('\n'):'監査ログはありません';body.appendChild(pre);},hideModal,'閉じる');}

let autoLockTimer=null;
function resetAutoLockTimer(){clearTimeout(autoLockTimer);if(state.unlocked&&state.autoLockMinutes>0)autoLockTimer=setTimeout(async()=>{await bridgeApi.vault.lock();location.reload();},state.autoLockMinutes*60000);}
['mousedown','keydown','wheel'].forEach(name=>document.addEventListener(name,resetAutoLockTimer,{passive:true}));

bridgeApi.menu.onAction(action=>{const actions={newTab:()=>newTab(null),addConnection:()=>addConnectionModal(),workspace:showWorkspaceModal,lock:async()=>{await bridgeApi.vault.lock();location.reload();},find:()=>{const s=document.getElementById('terminalSearch');s.focus();s.select();},palette:openCommandPalette,multiExec:showMultiExec,keygen:showKeyGenerator,settings:showSettings};if(actions[action])actions[action]();});

function parseTunnelProfiles(text){const result=[];for(const [index,raw] of String(text||'').split(/\r?\n/).entries()){const line=raw.replace(/#.*$/,'').trim();if(!line)continue;const p=line.split(/\s+/),type=p.shift().toUpperCase();if(type==='L'&&p.length===2){const a=parseEndpoint(p[0]),b=parseEndpoint(p[1]);if(!b.port)throw new Error(`${index+1}行目の転送先ポートに0は使えません`);result.push({type:'local',localHost:a.host,localPort:a.port,remoteHost:b.host,remotePort:b.port});}else if(type==='R'&&p.length===2){const a=parseEndpoint(p[0]),b=parseEndpoint(p[1]);if(!b.port)throw new Error(`${index+1}行目の転送先ポートに0は使えません`);result.push({type:'remote',bindHost:a.host,bindPort:a.port,targetHost:b.host,targetPort:b.port});}else if(type==='D'&&p.length===1){const a=parseEndpoint(p[0]);result.push({type:'socks5',localHost:a.host,localPort:a.port});}else throw new Error(`${index+1}行目の自動転送書式が不正です`);if(result.length>20)throw new Error('自動転送は最大20件です');}return result;}
function parseEndpoint(value){const m=String(value).match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);if(!m)throw new Error(`ホスト:ポート形式が不正です: ${value}`);const port=Number(m[2]);if(port<0||port>65535)throw new Error(`ポートが不正です: ${value}`);return{host:m[1].replace(/^\[|\]$/g,''),port};}
function formatTunnelProfiles(list){return(list||[]).map(t=>t.type==='local'?`L ${t.localHost}:${t.localPort} ${t.remoteHost}:${t.remotePort}`:t.type==='remote'?`R ${t.bindHost}:${t.bindPort} ${t.targetHost}:${t.targetPort}`:`D ${t.localHost}:${t.localPort}`).join('\n');}

function readConnectionForm() {
  return {
    name: document.getElementById('cName').value || document.getElementById('cHost').value,
    host: document.getElementById('cHost').value.trim(),
    port: parseInt(document.getElementById('cPort').value) || 22,
    username: document.getElementById('cUser').value.trim(),
    authType: document.getElementById('cAuth').value,
    agentPath: document.getElementById('cAgentPath').value.trim(),
    agentForward: document.getElementById('cAgentForward').checked,
    encoding: document.getElementById('cEncoding').value,
    password: document.getElementById('cPass').value,
    privateKey: document.getElementById('cKey').value,
    passphrase: document.getElementById('cPassphrase').value,
    timeoutSeconds: parseInt(document.getElementById('cTimeout').value) || 8,
    keepaliveIntervalSeconds: Math.min(300,Math.max(0,parseInt(document.getElementById('cKeepalive').value)||0)),
    keepaliveCountMax: Math.min(10,Math.max(1,parseInt(document.getElementById('cKeepaliveCount').value)||3)),
    group: document.getElementById('cGroup').value,
    notes: document.getElementById('cNotes').value,
    startupCommand: document.getElementById('cStartupCommand').value,
    autoTunnels: parseTunnelProfiles(document.getElementById('cAutoTunnels').value),
    favorite: document.getElementById('cFavorite').checked,
    autoReconnect: document.getElementById('cAutoReconnect').checked,
    reconnectDelay: parseInt(document.getElementById('cReconnectDelay').value) || 3,
    compression: document.getElementById('cCompression').checked,
    jumpHostId: document.getElementById('cJumpHost').value
  };
}

function wouldCreateJumpCycle(connectionId,candidateId){if(!connectionId)return false;const seen=new Set();let id=candidateId;for(let depth=0;id&&depth<20;depth++){if(id===connectionId)return true;if(seen.has(id))return true;seen.add(id);id=(state.connections.find(x=>x.id===id)||{}).jumpHostId;}return false;}

function addConnectionModal(existing) {
  const conn = existing || {};
  showModal(existing ? '接続先を編集' : 'SSH接続先を追加', (body) => {
    body.appendChild(field('表示名', 'text', 'cName', conn.name || ''));
    const addressRow = el('div', 'field-row');
    addressRow.appendChild(field('ホスト名 / IPアドレス', 'text', 'cHost', conn.host || ''));
    addressRow.appendChild(field('ポート', 'number', 'cPort', conn.port || 22));
    body.appendChild(addressRow);
    body.appendChild(field('ユーザー名', 'text', 'cUser', conn.username || ''));
    const authSel = document.createElement('select'); authSel.id = 'cAuth';
    [['password','パスワード'],['key','秘密鍵'],['agent','SSH Agent（Windows OpenSSH）']].forEach(([v,label]) => { const o=document.createElement('option'); o.value=v; o.textContent=label; if((conn.authType||'password')===v)o.selected=true; authSel.appendChild(o); });
    body.appendChild(fieldWrap('認証方式', authSel));
    body.appendChild(field('SSH Agentソケット（空欄でWindows OpenSSH Agent）','text','cAgentPath',conn.agentPath||''));
    body.appendChild(checkboxField('SSH Agent転送を有効化', 'cAgentForward', conn.agentForward, '接続先からさらにSSH接続するときだけ有効にしてください。信頼できないサーバーでは使用しないでください。'));
    const encoding=document.createElement('select');encoding.id='cEncoding';[['utf8','UTF-8（推奨）'],['shift_jis','Shift_JIS / CP932'],['euc-jp','EUC-JP']].forEach(([v,label])=>{const o=document.createElement('option');o.value=v;o.textContent=label;o.selected=(conn.encoding||'utf8')===v;encoding.appendChild(o);});body.appendChild(fieldWrap('ターミナル文字コード',encoding));
    body.appendChild(field('パスワード', 'password', 'cPass', conn.password || ''));
    const keyRow = el('div', 'field');
    keyRow.appendChild(el('label', null, '秘密鍵（貼り付けまたはファイル読込）'));
    const keyArea = document.createElement('textarea'); keyArea.id='cKey'; keyArea.rows=4; keyArea.value=conn.privateKey||'';
    const importBtn = el('button','secondary','秘密鍵ファイルを選択');
    importBtn.onclick = async () => { const p=await bridgeApi.dialog.openFile(); if(p) keyArea.value=await bridgeApi.fs.readFile(p); };
    keyRow.appendChild(keyArea); keyRow.appendChild(importBtn); body.appendChild(keyRow);
    body.appendChild(field('秘密鍵のパスフレーズ', 'password', 'cPassphrase', conn.passphrase || ''));
    const networkRow=el('div','field-row');networkRow.appendChild(field('接続タイムアウト（秒）','number','cTimeout',conn.timeoutSeconds||8));networkRow.appendChild(field('Keepalive間隔（秒、0=無効）','number','cKeepalive',conn.keepaliveIntervalSeconds==null?10:conn.keepaliveIntervalSeconds));networkRow.appendChild(field('無応答許容回数','number','cKeepaliveCount',conn.keepaliveCountMax||3));body.appendChild(networkRow);
    body.appendChild(checkboxField('お気に入り', 'cFavorite', conn.favorite));
    body.appendChild(checkboxField('切断エラー時に自動再接続', 'cAutoReconnect', conn.autoReconnect, '接続失敗時は待ち時間を増やしながら最大5回再試行します。'));
    body.appendChild(field('再接続の初期待ち時間（秒）', 'number', 'cReconnectDelay', conn.reconnectDelay || 3));
    body.appendChild(checkboxField('SSH圧縮を有効化', 'cCompression', conn.compression, '低速回線やテキスト中心の通信で有効です。'));
    const jump=document.createElement('select');jump.id='cJumpHost';const direct=document.createElement('option');direct.value='';direct.textContent='直接接続';jump.appendChild(direct);state.connections.filter(x=>x.id!==conn.id&&!wouldCreateJumpCycle(conn.id,x.id)).forEach(x=>{const o=document.createElement('option');o.value=x.id;o.textContent=`${x.name} (${x.username}@${x.host})`;o.selected=conn.jumpHostId===x.id;jump.appendChild(o);});body.appendChild(fieldWrap('踏み台サーバー（ProxyJump）',jump));body.appendChild(el('div','hint','選択したSSH接続を経由します。踏み台側にも踏み台を設定すると最大5段のチェーンを自動構成します。循環する候補は表示しません。'));
    body.appendChild(field('グループ', 'text', 'cGroup', conn.group || ''));
    body.appendChild(field('メモ', 'text', 'cNotes', conn.notes || ''));
    body.appendChild(field('接続直後に自動実行するコマンド（任意）', 'text', 'cStartupCommand', conn.startupCommand || ''));
    const tunnelWrap=el('div','field');tunnelWrap.appendChild(el('label',null,'接続時に開始するポート転送（任意）'));const tunnelArea=document.createElement('textarea');tunnelArea.id='cAutoTunnels';tunnelArea.rows=4;tunnelArea.placeholder='L 127.0.0.1:5000 127.0.0.1:8080\nR 127.0.0.1:9000 127.0.0.1:3000\nD 127.0.0.1:1080';tunnelArea.value=formatTunnelProfiles(conn.autoTunnels);tunnelWrap.appendChild(tunnelArea);tunnelWrap.appendChild(el('div','hint','L=ローカル転送、R=リモート転送、D=SOCKS5。待受ポートは0で自動割当。最大20件。'));body.appendChild(tunnelWrap);
    const testBtn = el('button', 'secondary', '✓ 保存前に接続テスト');
    const resultBox = el('div', 'test-result'); resultBox.id='formTestResult'; resultBox.style.display='none';
    testBtn.onclick = async () => {
      let data;try{data=readConnectionForm();}catch(e){alert(e.message);return;}
      if(!data.host){ alert('ホスト名を入力してください'); return; }
      testBtn.disabled=true; resultBox.style.display='block'; resultBox.className='test-result'; resultBox.textContent='DNS → TCP → SSHバナー → 認証 を確認しています…';
      try { const r=await bridgeApi.ssh.test({options:data,authenticate:!!data.username}); resultBox.textContent=formatTestResult(r); resultBox.classList.add(r.ok?'ok':'fail'); }
      catch(e){ resultBox.textContent=e.message; resultBox.classList.add('fail'); }
      testBtn.disabled=false;
    };
    body.appendChild(testBtn); body.appendChild(resultBox);
  }, async () => {
    let data;try{data=readConnectionForm();}catch(e){alert(e.message);return;}
    if (!data.host || !data.username) { alert('ホスト名とユーザー名は必須です'); return; }
    if (existing) await bridgeApi.vault.update(existing.id, data);
    else await bridgeApi.vault.add(data);
    hideModal(); await refreshConnections(); toast(existing ? '接続先を更新しました' : '接続先を追加しました');
  }, existing ? '保存' : '追加');
}

function editConnection(id) {
  const c = state.connections.find(x => x.id === id);
  // need full record with password; fetch via get
  bridgeApi.vault.get(id).then(full => addConnectionModal(full));
}

function showImportOptions(){showModal('接続先を移行',body=>{body.appendChild(el('div','hint','JSON、OpenSSH config、Tera Term INI／TTLマクロをファイルから読み込めます。認証パスワードは平文移行しません。'));const putty=el('button','secondary','PuTTY保存セッションをWindowsから読み込む');putty.style.cssText='width:100%;margin-top:14px';putty.onclick=importPuttySessions;body.appendChild(putty);},()=>{hideModal();importConnections();},'ファイルを選択');}
async function importPuttySessions(){try{const arr=await bridgeApi.migration.puttySessions();if(!arr.length){toast('PuTTYの保存セッションが見つかりませんでした',7000);return;}if(!confirm(`${arr.length}件のPuTTY保存セッションを取り込みますか？\nパスワードは取り込みません。`))return;for(const c of arr)await bridgeApi.vault.add(c);hideModal();await refreshConnections();toast(`${arr.length}件のPuTTYセッションをインポートしました`);}catch(e){alert('PuTTYインポート失敗: '+e.message);}}

function parseTeraTermConnections(content){const results=[];const candidates=[];for(const raw of content.split(/\r?\n/)){let m=raw.match(/^\s*Host\d+\s*=\s*(.+)$/i);if(m)candidates.push(m[1].trim());m=raw.match(/^\s*connect\s+['"](.+?)['"]\s*$/i);if(m)candidates.push(m[1].trim());}for(let value of candidates){value=value.replace(/^['"]|['"]$/g,'');const hostToken=(value.match(/^([^\s/]+)/)||[])[1];if(!hostToken)continue;let host=hostToken,port=22;if(/^\[[^\]]+\]:\d+$/.test(hostToken)){const m=hostToken.match(/^\[([^\]]+)\]:(\d+)$/);host=m[1];port=+m[2];}else if((hostToken.match(/:/g)||[]).length===1){const i=hostToken.lastIndexOf(':');if(/^\d+$/.test(hostToken.slice(i+1))){host=hostToken.slice(0,i);port=+hostToken.slice(i+1);}}const option=(name)=>{const m=value.match(new RegExp('\\/'+name+'=(?:"([^"]*)"|([^\\s]+))','i'));return m&&(m[1]??m[2]);};port=parseInt(option('port'))||port;const username=option('user')||'';const auth=(option('auth')||'').toLowerCase();const keyfile=option('keyfile');results.push({name:host,host,port,username,authType:keyfile||/publickey/.test(auth)?'key':'password',notes:keyfile?`Tera Term秘密鍵: ${keyfile}`:'Tera Termからインポート（パスワードは安全のため未取込）',group:'Tera Term'});}const seen=new Set();return results.filter(x=>{const k=`${x.username}@${x.host}:${x.port}`;if(seen.has(k))return false;seen.add(k);return true;});}

async function importConnections() {
  const p = await bridgeApi.dialog.openFile();
  if (!p) return;
  try {
    const content = await bridgeApi.fs.readFile(p);
    let arr;
    try {
      const parsed = JSON.parse(content);
      arr = Array.isArray(parsed) ? parsed : (parsed.connections || []);
    } catch (_) {
      // Tera Term INI history and TTL `connect` macro importer.
      arr = parseTeraTermConnections(content);
      // Fall back to the full OpenSSH config importer, including multi-hop ProxyJump.
      if (!arr.length) arr = await bridgeApi.migration.parseOpenSsh(content);
    }
    if (!arr.length) throw new Error('インポートできる接続先がありません');
    if(!confirm(`${arr.length}件の接続先候補をインポートしますか？\n既存の同一ユーザー・ホスト・ポートは重複登録せず、パスワードはファイルから取り込みません。`))return;
    const existingByKey=new Map(state.connections.map(c=>[`${c.username||''}@${String(c.host||'').toLowerCase()}:${c.port||22}`,c.id]));const idMap=new Map();let skipped=0;
    for(const c of arr){const key=`${c.username||''}@${String(c.host||'').toLowerCase()}:${c.port||22}`;const existingId=existingByKey.get(key);if(existingId){if(c.id)idMap.set(c.id,existingId);c._skipImport=true;skipped++;}else{if(c.id)idMap.set(c.id,c.id);existingByKey.set(key,c.id||key);}}
    let added=0;for(const c of arr){if(c._skipImport)continue;const clean={...c};delete clean._skipImport;if(clean.jumpHostId&&idMap.has(clean.jumpHostId))clean.jumpHostId=idMap.get(clean.jumpHostId);await bridgeApi.vault.add(clean);added++;}
    await refreshConnections(); toast(`${added}件をインポートしました${skipped?`（重複${skipped}件をスキップ）`:''}`);
  } catch (e) { alert('インポート失敗: ' + e.message); }
}

// ---------- SSH keyboard-interactive / 2FA ----------
function showAuthChallenge(token,challenge){state.authChallengeToken=token;const overlay=document.getElementById('authChallenge');document.getElementById('authChallengeTitle').textContent=challenge.name||challenge.label||'SSH追加認証';document.getElementById('authChallengeInstructions').textContent=challenge.instructions||`${challenge.label||'SSHサーバー'}が追加認証を要求しています。`;const fields=document.getElementById('authChallengeFields');fields.innerHTML='';(challenge.prompts||[]).forEach((p,i)=>{const f=field(p.prompt||`回答 ${i+1}`,p.echo?'text':'password','authAnswer'+i,'');fields.appendChild(f);});overlay.classList.add('open');setTimeout(()=>{const first=fields.querySelector('input');first&&first.focus();},0);}
function finishAuthChallenge(submit){const token=state.authChallengeToken;if(!token)return;const inputs=[...document.querySelectorAll('#authChallengeFields input')];const answers=submit?inputs.map(x=>x.value):[];state.authChallengeToken=null;document.getElementById('authChallenge').classList.remove('open');bridgeApi.ssh.respondChallenge(token,answers);}
document.getElementById('authChallengeSubmit').onclick=()=>finishAuthChallenge(true);document.getElementById('authChallengeCancel').onclick=()=>finishAuthChallenge(false);document.getElementById('authChallenge').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();finishAuthChallenge(true);}if(e.key==='Escape')finishAuthChallenge(false);});

// ---------- SSH events ----------
sshEventApi.onChallenge((token,challenge)=>showAuthChallenge(token,challenge));
function handleSshStatus(sid,stage,msg){
  const pid=sessionToPane[sid],pane=pid?state.panes[pid]:null;
  if(!pane){orphanSessionStatus.set(sid,{stage,msg});return;}
  if(stage==='ready'){
    const wasRetry=(pane.reconnectAttempts||0)>0;pane.connected=true;pane.connecting=false;pane.reconnectAttempts=0;
    const c=state.connections.find(x=>x.id===pane.connId);setPaneTabTitle(pid,c?c.name:(pane.adhocOpts?.host||'SSH'));
    if(pane.terminal){pane.terminal.write(t(`\r\n\x1b[32m[SSH接続済み]\x1b[0m ${c?c.name:(pane.adhocOpts?.host||'SSH')}\r\n`));pane.terminal.focus();schedulePaneFit(pane,true);setTimeout(()=>{if(state.panes[pid]===pane&&pane.sessionId===sid)schedulePaneFit(pane,true);},180);}
    if(wasRetry&&state.notifyOnDisconnect)bridgeApi.notification.show(t('SSH再接続成功'),t(`${c?c.name:'SSH'} に再接続しました。`));
    if(c&&pane.autoTunnelsStartedFor!==sid){pane.autoTunnelsStartedFor=sid;startAutoTunnels(sid,c);}
    if(pane.connId){const now=Date.now();if(c)c.lastConnectedAt=now;bridgeApi.vault.update(pane.connId,{lastConnectedAt:now}).catch(()=>{});}
  }
  if(stage==='error')pane.connecting=false;
  if(stage==='ready'||stage==='error')renderConnections();
  setStatus(msg||stage);
}
function handleSshData(sid,data){
  const pid=sessionToPane[sid],pane=pid?state.panes[pid]:null;
  if(!pane){const old=orphanSessionData.get(sid)||'';orphanSessionData.set(sid,(old+data).slice(-250000));return;}
  pane.history=(pane.history||'')+data;if(pane.history.length>250000)pane.history=pane.history.slice(-250000);
  if(pane.recording&&pane.recording.bytes<20_000_000){pane.recording.events.push([Date.now()-pane.recording.startedAt,'data',data]);pane.recording.bytes+=data.length;}
  if(pane.terminal)pane.terminal.write(data);
}
sshEventApi.onStatus(handleSshStatus);
sshEventApi.onData(handleSshData);
function handleSshExit(sid,code){
  if(!sessionToPane[sid]){orphanSessionEnd.set(sid,{type:'exit',value:code});return;}
  if(state.sftpSessionId===sid){document.getElementById('sftpPanel').classList.remove('open');state.sftpSessionId=null;state.sftpCancelRequested=false;setSftpTransferActive(false);}
  const pid = sessionToPane[sid];
  const pane = pid ? state.panes[pid] : null;
  if (pane) {
    if(pane.recording)finishPaneRecording(pane,'disconnect');
    if(state.notifyOnDisconnect&&!pane.manualClose){const c=state.connections.find(x=>x.id===pane.connId);bridgeApi.notification.show(t('SSH切断'),t(`${c?c.name:'SSH'} との接続が切断されました。`));}
    pane.sessionId = null;
    pane.connected = false;pane.connecting=false;
    const c=state.connections.find(x=>x.id===pane.connId);setPaneTabTitle(pid,`${c?c.name:(pane.adhocOpts?.host||'SSH')} • 切断`);
    if (pane.terminal) {
      pane.terminal.write('\r\n\x1b[31m[Connection closed]\x1b[0m\r\n');
    }
  }
  renderConnections();
  setStatus('切断されました (code ' + code + ')');
  delete sessionToPane[sid];orphanSessionData.delete(sid);orphanSessionStatus.delete(sid);orphanSessionEnd.delete(sid);
}
sshEventApi.onExit(handleSshExit);
function handleSshError(sid,msg){
  if(!sessionToPane[sid]){orphanSessionEnd.set(sid,{type:'error',value:msg});return;}
  if(state.sftpSessionId===sid){document.getElementById('sftpPanel').classList.remove('open');state.sftpSessionId=null;state.sftpCancelRequested=false;setSftpTransferActive(false);}
  const pid = sessionToPane[sid];
  const pane = pid ? state.panes[pid] : null;
  if (pane) {
    if(pane.recording)finishPaneRecording(pane,'error');
    if(state.notifyOnDisconnect&&!pane.manualClose){const c=state.connections.find(x=>x.id===pane.connId);bridgeApi.notification.show(t('SSH接続エラー'),`${c?c.name:'SSH'}: ${t(msg)}`);}
    pane.connected=false;pane.connecting=false;
    pane.sessionId=null;
    const c=state.connections.find(x=>x.id===pane.connId);setPaneTabTitle(pid,`${c?c.name:(pane.adhocOpts?.host||'SSH')} • エラー`);
    bridgeApi.ssh.disconnect(sid).catch(() => {});
    if (pane.terminal) pane.terminal.write(t('\r\n\x1b[31m[接続エラー]\x1b[0m ')+t(msg)+t('\r\n\x1b[36m左上の ↻ 再接続、または接続先一覧の ✓ で診断できます。\x1b[0m\r\n'));
  }
  renderConnections();
  setStatus('接続エラー: ' + msg);
  toast(msg, 8000);
  if(pid)scheduleReconnect(pid);
  delete sessionToPane[sid];orphanSessionData.delete(sid);orphanSessionStatus.delete(sid);orphanSessionEnd.delete(sid);
}
sshEventApi.onError(handleSshError);

// ---------- Boot ----------
showUnlock();
