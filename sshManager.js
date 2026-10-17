const { Client, utils: { generateKeyPairSync } } = require('ssh2');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const iconv = require('iconv-lite');

function terminalEncoding(value) {
  const encoding=String(value||'utf8').toLowerCase().replace(/-/g,'_');
  return ({utf8:'utf8',utf_8:'utf8',shift_jis:'shift_jis',sjis:'shift_jis',euc_jp:'euc-jp',eucjp:'euc-jp'})[encoding] || 'utf8';
}

function connectionOptions(opts) {
  const timeoutSeconds = Math.min(120, Math.max(5, Number(opts.timeoutSeconds) || 8));
  const result = {
    host: opts.host,
    port: Number(opts.port) || 22,
    username: opts.username,
    readyTimeout: timeoutSeconds * 1000,
    keepaliveInterval: Number(opts.keepaliveIntervalSeconds) === 0 ? 0 : Math.min(300, Math.max(5, Number(opts.keepaliveIntervalSeconds) || 10)) * 1000,
    keepaliveCountMax: Math.min(10, Math.max(1, Number(opts.keepaliveCountMax) || 3)),
    tryKeyboard: true,
    compress: !!opts.compression,
    hostHash: 'sha256',
    hostVerifier: opts.hostVerifier
  };
  if (opts.agentForward) {
    result.agent = opts.agentPath || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK);
    if (!result.agent) throw new Error('Agent転送を有効にしましたがSSH Agentが見つかりません。');
    result.agentForward = true;
  }
  if (opts.authType === 'key' || opts.privateKey) {
    result.privateKey = opts.privateKey;
    if (opts.passphrase) result.passphrase = opts.passphrase;
  } else if (opts.authType === 'agent') {
    result.agent = opts.agentPath || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK);
    if (!result.agent) throw new Error('SSH Agentが見つかりません。');
  } else {
    result.password = opts.password;
  }
  return result;
}

function friendlyError(err, opts) {
  const msg = err && err.message ? err.message : String(err);
  if (/Timed out while waiting for handshake/i.test(msg)) {
    return `SSHハンドシェイクがタイムアウトしました。${opts.host}:${opts.port || 22} のポートは開いていても、sshdがSSHバナーを返していない可能性があります。「接続テスト」で確認してください。`;
  }
  if (/All configured authentication methods failed/i.test(msg)) {
    return '認証に失敗しました。ユーザー名、パスワード、秘密鍵、サーバー側のPasswordAuthentication設定を確認してください。';
  }
  if (/ECONNREFUSED/i.test(msg)) return '接続を拒否されました。SSHサービスとポート番号を確認してください。';
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return 'ホスト名を解決できません。ホスト名またはDNS設定を確認してください。';
  if (/Host denied|host verification/i.test(msg)) return 'ホスト鍵が信頼されなかったため接続を中止しました。';
  return msg;
}

class SshManager {
  constructor() {
    this.sessions = new Map();
    this.challenges = new Map();
  }

  _attachKeyboardInteractive(client, challengeBase, onChallenge, label) {
    client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      const token = challengeBase + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      this.challenges.set(token, finish);
      const timer = setTimeout(() => { if (this.challenges.delete(token)) finish([]); }, 120000);
      const wrappedFinish = answers => { clearTimeout(timer); if (!this.challenges.delete(token)) return false; finish(Array.isArray(answers) ? answers : []); return true; };
      this.challenges.set(token, wrappedFinish);
      if (onChallenge) onChallenge(token, { name:name || label || 'SSH認証', instructions, prompts:prompts.map(p=>({ prompt:p.prompt, echo:!!p.echo })), label });
      else wrappedFinish([]);
    });
  }

  respondChallenge(token, answers) {
    const finish = this.challenges.get(token);
    if (!finish) return false;
    return finish(answers);
  }

  _cancelChallenges(prefix) {
    for (const [token, finish] of [...this.challenges.entries()]) if (token.startsWith(prefix)) finish([]);
  }

  _connectWithOptionalJump(client, opts, status, fail, challengeContext) {
    const chain=Array.isArray(opts.jumpChain)&&opts.jumpChain.length?opts.jumpChain:(opts.jump?[opts.jump]:[]);
    const jumpClients=[];let failed=false;
    const failOnce=err=>{if(failed)return;failed=true;fail(err);};
    const connectTarget = (sock) => {
      const target = connectionOptions(opts);if(sock)target.sock=sock;
      status&&status(sock?'jump-forward':'connecting',sock?`${chain.length}段の踏み台経由で ${opts.host}:${opts.port||22} へ接続しています…`:`${opts.host}:${opts.port||22} に接続しています…`);
      client.connect(target);
    };
    const connectHop=(index,sock)=>{
      if(index>=chain.length){try{connectTarget(sock);}catch(e){failOnce(e);}return;}
      const hop=chain[index],hopClient=new Client();jumpClients.push(hopClient);
      const label=`踏み台 ${index+1}/${chain.length}`;
      this._attachKeyboardInteractive(hopClient,(challengeContext?.id||'ssh')+`_jump_${index}`,challengeContext?.onChallenge,label);
      hopClient.on('ready',()=>{
        status&&status('jump-ready',`${label} ${hop.host}:${hop.port||22} に接続しました`);
        const next=index+1<chain.length?chain[index+1]:opts;
        hopClient.forwardOut('127.0.0.1',0,next.host,next.port||22,(err,stream)=>{if(err)return failOnce(new Error(`${label}から次の接続先への転送に失敗: ${err.message}`));connectHop(index+1,stream);});
      });
      hopClient.on('error',err=>failOnce(new Error(`${label} 接続エラー: ${friendlyError(err,hop)}`)));
      status&&status('jump-connecting',`${label} ${hop.host}:${hop.port||22} に接続しています…`);
      try{const config=connectionOptions(hop);if(sock)config.sock=sock;hopClient.connect(config);}catch(e){failOnce(e);}
    };
    if(!chain.length)connectTarget(null);else connectHop(0,null);
    return jumpClients;
  }

  connect(opts, onData, onExit, onError, onStatus, onChallenge) {
    const id = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const client = new Client();
    this._attachKeyboardInteractive(client, id + '_target', onChallenge, '接続先サーバー');
    const initialCols=Math.min(1000,Math.max(2,Number(opts.cols)||80));
    const initialRows=Math.min(1000,Math.max(1,Number(opts.rows)||24));
    // Keep the latest requested geometry even before the remote shell exists.
    // This avoids a race where xterm fits first, the resize is dropped, and
    // tmux/byobu starts permanently at the 80x24 fallback size.
    const session = { id, client, jumpClients: [], stream: null, connected: false, info: opts, cols:initialCols, rows:initialRows, sftp: null, tunnels: new Map(), transferStreams:new Set() };
    this.sessions.set(id, session);
    const status = (stage, message) => onStatus && onStatus(id, stage, message);

    client.on('ready', () => {
      session.connected = true;
      status('authenticated', '認証に成功しました。シェルを開始しています…');
      client.shell({ term: 'xterm-256color', cols: session.cols, rows: session.rows }, (err, stream) => {
        if (err) { onError && onError(id, friendlyError(err, opts)); return; }
        session.stream = stream;
        // Re-apply the newest size in case it changed while shell creation was in flight.
        try { stream.setWindow(session.rows, session.cols, 0, 0); } catch (e) {}
        session.encoding = terminalEncoding(opts.encoding);
        const outputDecoder=iconv.getDecoder(session.encoding),errorDecoder=iconv.getDecoder(session.encoding);
        status('ready', `接続済み（${session.encoding}）`);
        stream.on('data', (d) => {const text=outputDecoder.write(d);if(text&&onData)onData(id,text);});
        stream.stderr.on('data', (d) => {const text=errorDecoder.write(d);if(text&&onData)onData(id,text);});
        if (opts.startupCommand) setTimeout(() => { try { stream.write(iconv.encode(opts.startupCommand + '\r',session.encoding)); } catch (e) {} }, 250);
        stream.on('close', (code) => {
          const tail=outputDecoder.end()+errorDecoder.end();if(tail&&onData)onData(id,tail);
          session.connected = false;
          onExit && onExit(id, code);
          try { client.end(); } catch (e) {}
        });
      });
    });
    client.on('banner', (message) => status('banner', String(message).trim() || 'SSHバナーを受信'));
    client.on('error', (err) => {
      session.connected = false;
      const message = friendlyError(err, opts);
      status('error', message);
      onError && onError(id, message);
      try { client.end(); } catch (e) {}
      for(const jump of session.jumpClients||[]){try{jump.end();}catch(e){}}
      this.sessions.delete(id);
    });
    client.on('close', () => {
      if (session.connected) {
        session.connected = false;
        onExit && onExit(id, 0);
      }
      for (const tunnel of session.tunnels.values()) { try { if (tunnel.stop) tunnel.stop(); else if (tunnel.server) tunnel.server.close(); } catch (e) {} }
      session.tunnels.clear();
      for(const jump of session.jumpClients||[]){try{jump.end();}catch(e){}}
      this.sessions.delete(id);
    });

    try {
      session.jumpClients = this._connectWithOptionalJump(client, opts, status, (err) => {
        const message = friendlyError(err, opts);
        status('error', message); onError && onError(id, message);
        try { client.end(); } catch (e) {} for(const jump of session.jumpClients||[]){try{jump.end();}catch(e){}}
        this.sessions.delete(id);
      }, { id, onChallenge });
    } catch (e) {
      onError && onError(id, friendlyError(e, opts));
    }
    return id;
  }

  test(opts, onStatus, onChallenge) {
    return new Promise((resolve) => {
      const client = new Client();
      const testId = 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      this._attachKeyboardInteractive(client, testId + '_target', onChallenge, '接続テスト');
      let jumpClients = [];
      let settled = false;
      const started = Date.now();
      const finish = (result) => {
        if (settled) return;
        settled = true;
        this._cancelChallenges(testId);
        try { client.end(); } catch (e) {}
        for(const jump of jumpClients){try{jump.end();}catch(e){}}
        resolve({ elapsedMs: Date.now() - started, ...result });
      };
      client.on('ready', () => finish({ ok: true, stage: 'authentication', message: 'SSH認証に成功しました。' }));
      client.on('banner', (message) => onStatus && onStatus('banner', String(message).trim()));
      client.on('error', (err) => finish({ ok: false, stage: 'authentication', message: friendlyError(err, opts), rawError: err.message }));
      try {
        jumpClients = this._connectWithOptionalJump(client, opts, (stage, message) => onStatus && onStatus(stage, message), err => finish({ ok:false, stage:'jump', message:friendlyError(err, opts), rawError:err.message }), { id:testId, onChallenge });
      } catch (err) { finish({ ok: false, stage: 'configuration', message: friendlyError(err, opts), rawError: err.message }); }
    });
  }

  exec(id, command, timeoutMs = 20000) {
    const s = this._requireConnected(id);
    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '', settled = false, streamRef = null;
      const finish = (err, result) => { if (settled) return; settled = true; clearTimeout(timer); if (err) reject(err); else resolve(result); };
      const timer = setTimeout(() => { try { streamRef && streamRef.close(); } catch (e) {} finish(new Error('コマンドがタイムアウトしました。')); }, timeoutMs);
      s.client.exec(command, (err, stream) => {
        if (err) return finish(err); streamRef = stream;
        stream.on('data', d => { if (stdout.length < 2_000_000) stdout += d.toString('utf8'); });
        stream.stderr.on('data', d => { if (stderr.length < 2_000_000) stderr += d.toString('utf8'); });
        stream.on('close', (code, signal) => finish(null, { code, signal, stdout, stderr }));
        stream.on('error', e => finish(e));
      });
    });
  }

  async monitorSnapshot(id) {
    const commands = {
      system: 'uname -a 2>/dev/null || ver',
      uptime: 'uptime 2>/dev/null || true',
      memory: 'LC_ALL=C free -b 2>/dev/null || true',
      disk: 'LC_ALL=C df -B1 -P / 2>/dev/null || true',
      processes: "ps -eo pid,comm,%cpu,%mem --sort=-%cpu 2>/dev/null | head -9 || true",
      docker: "docker ps --format '{{.Names}}|{{.Status}}|{{.Image}}' 2>/dev/null | head -20 || true"
    };
    const entries = await Promise.all(Object.entries(commands).map(async ([key, command]) => {
      try { return [key, await this.exec(id, command, 12000)]; }
      catch (e) { return [key, { code:-1, stdout:'', stderr:e.message }]; }
    }));
    return Object.fromEntries(entries);
  }

  generateKeyPair(options = {}) {
    const type = ['ed25519', 'rsa', 'ecdsa'].includes(options.type) ? options.type : 'ed25519';
    const opts = { comment: options.comment || 'SSH Nexus' };
    if (type === 'rsa') opts.bits = Number(options.bits) || 4096;
    if (type === 'ecdsa') opts.bits = 256;
    if (options.passphrase) { opts.passphrase = options.passphrase; opts.cipher = 'aes256-cbc'; }
    return generateKeyPairSync(type, opts);
  }

  _requireConnected(id) {
    const s = this.sessions.get(id);
    if (!s || !s.connected) throw new Error('SSHセッションが接続されていません。');
    return s;
  }

  getSftp(id) {
    const s = this._requireConnected(id);
    if (s.sftp) return Promise.resolve(s.sftp);
    return new Promise((resolve, reject) => {
      s.client.sftp((err, channel) => {
        if (err) return reject(err);
        s.sftp = channel;
        channel.on('close', () => { if (s.sftp === channel) s.sftp = null; });
        resolve(channel);
      });
    });
  }

  async sftpList(id, remotePath) {
    const channel = await this.getSftp(id);
    return await new Promise((resolve, reject) => channel.readdir(remotePath, (err, list) => {
      if (err) return reject(err);
      resolve(list.map(item => ({
        name: item.filename,
        longname: item.longname,
        size: item.attrs.size,
        mode: item.attrs.mode,
        mtime: item.attrs.mtime,
        isDirectory: (item.attrs.mode & 0o170000) === 0o040000,
        isSymlink: (item.attrs.mode & 0o170000) === 0o120000
      })));
    }));
  }

  _trackTransferStream(id,stream){const s=this.sessions.get(id);if(!s)return stream;s.transferStreams=s.transferStreams||new Set();s.transferStreams.add(stream);const remove=()=>s.transferStreams.delete(stream);stream.once('close',remove);stream.once('end',remove);stream.once('finish',remove);return stream;}

  cancelSftpTransfers(id) {
    const s=this.sessions.get(id);if(!s)return false;let cancelled=false;
    for(const stream of s.transferStreams||[]){try{stream.destroy(new Error('SFTP転送はユーザーにより中止されました。'));cancelled=true;}catch(e){}}
    if(s.transferStreams)s.transferStreams.clear();
    if(s.sftp){const channel=s.sftp;s.sftp=null;try{channel.end();cancelled=true;}catch(e){}}
    return cancelled;
  }

  async sftpStat(id, remotePath) {
    const channel = await this.getSftp(id);
    return await new Promise((resolve, reject) => channel.stat(remotePath, (err, attrs) => err ? reject(err) : resolve({ size:attrs.size||0, mode:attrs.mode, mtime:attrs.mtime })));
  }

  async sftpHash(id, remotePath, onProgress) {
    const channel=await this.getSftp(id);const attrs=await this.sftpStat(id,remotePath);
    return await new Promise((resolve,reject)=>{const hash=crypto.createHash('sha256'),input=this._trackTransferStream(id,channel.createReadStream(remotePath));let read=0;input.on('data',chunk=>{hash.update(chunk);read+=chunk.length;onProgress&&onProgress({direction:'verify-remote',transferred:read,total:attrs.size,remotePath});});input.once('error',reject);input.once('end',()=>resolve({algorithm:'sha256',hash:hash.digest('hex'),bytes:read}));});
  }

  async localFileHash(localPath, onProgress, id = null) {
    const total=fs.statSync(localPath).size;
    return await new Promise((resolve,reject)=>{const hash=crypto.createHash('sha256'),input=id?this._trackTransferStream(id,fs.createReadStream(localPath)):fs.createReadStream(localPath);let read=0;input.on('data',chunk=>{hash.update(chunk);read+=chunk.length;onProgress&&onProgress({direction:'verify-local',transferred:read,total,localPath});});input.once('error',reject);input.once('end',()=>resolve({algorithm:'sha256',hash:hash.digest('hex'),bytes:read}));});
  }

  async verifySftpFile(id, remotePath, localPath, onProgress) {
    const [remote,local]=await Promise.all([this.sftpHash(id,remotePath,onProgress),this.localFileHash(localPath,onProgress,id)]);
    return {ok:remote.bytes===local.bytes&&remote.hash===local.hash,algorithm:'sha256',remoteHash:remote.hash,localHash:local.hash,bytes:local.bytes};
  }

  async sftpDownload(id, remotePath, localPath, onProgress, resumeFrom = 0) {
    const channel = await this.getSftp(id);
    const remote = await this.sftpStat(id, remotePath);
    const offset = Math.max(0, Math.min(Number(resumeFrom)||0, remote.size));
    if (!offset) {
      const options = { step: (transferred, chunk, total) => onProgress && onProgress({ transferred, total, direction:'download', remotePath, localPath }) };
      await new Promise((resolve, reject) => channel.fastGet(remotePath, localPath, options, err => err ? reject(err) : resolve()));
    } else if (offset < remote.size) {
      await new Promise((resolve, reject) => {
        const input=this._trackTransferStream(id,channel.createReadStream(remotePath,{start:offset}));
        const output=this._trackTransferStream(id,fs.createWriteStream(localPath,{flags:'a'}));let done=offset;
        input.on('data',chunk=>{done+=chunk.length;onProgress&&onProgress({transferred:done,total:remote.size,direction:'download-resume',remotePath,localPath});});
        input.once('error',reject);output.once('error',reject);output.once('finish',resolve);input.pipe(output);
      });
    }
    return { resumed:offset>0, bytes:remote.size, resumedFrom:offset };
  }

  async sftpUpload(id, localPath, remotePath, onProgress, resumeFrom = 0) {
    const channel = await this.getSftp(id);
    const total=fs.statSync(localPath).size;
    const offset=Math.max(0,Math.min(Number(resumeFrom)||0,total));
    if (!offset) {
      const options = { step: (transferred, chunk, size) => onProgress && onProgress({ transferred, total:size, direction:'upload', remotePath, localPath }) };
      await new Promise((resolve, reject) => channel.fastPut(localPath, remotePath, options, err => err ? reject(err) : resolve()));
    } else if(offset < total) {
      await new Promise((resolve,reject)=>{
        const input=this._trackTransferStream(id,fs.createReadStream(localPath,{start:offset}));
        const output=this._trackTransferStream(id,channel.createWriteStream(remotePath,{flags:'r+',start:offset}));let done=offset;
        input.on('data',chunk=>{done+=chunk.length;onProgress&&onProgress({transferred:done,total,direction:'upload-resume',remotePath,localPath});});
        input.once('error',reject);output.once('error',reject);output.once('finish',resolve);input.pipe(output);
      });
    }
    return { resumed:offset>0, bytes:total, resumedFrom:offset };
  }

  async _sftpEnsureDir(channel, remoteDir) {
    const parts = path.posix.normalize(remoteDir).split('/').filter(Boolean);
    let current = remoteDir.startsWith('/') ? '/' : '';
    for (const part of parts) {
      current = path.posix.join(current, part);
      await new Promise((resolve, reject) => channel.mkdir(current, err => {
        if (!err || /exist/i.test(err.message || '')) return resolve();
        channel.stat(current, statErr => statErr ? reject(err) : resolve());
      }));
    }
  }

  async sftpUploadDirectory(id, localDir, remoteRoot, onProgress) {
    const channel = await this.getSftp(id);
    const files = [], dirs = [''];
    const walk = (dir, rel = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes:true })) {
        if (entry.isSymbolicLink()) continue;
        const childRel = rel ? path.posix.join(rel, entry.name) : entry.name;
        const local = path.join(dir, entry.name);
        if (entry.isDirectory()) { dirs.push(childRel); walk(local, childRel); }
        else if (entry.isFile()) files.push({ local, rel:childRel, size:fs.statSync(local).size });
        if (files.length + dirs.length > 10000) throw new Error('フォルダ内の項目数が10,000件を超えています。');
      }
    };
    walk(localDir);
    const total = files.reduce((n,f)=>n+f.size,0); let completed = 0;
    await this._sftpEnsureDir(channel, remoteRoot);
    for (const dir of dirs.filter(Boolean)) await this._sftpEnsureDir(channel, path.posix.join(remoteRoot, dir));
    for (const file of files) {
      const remotePath = path.posix.join(remoteRoot, file.rel);
      await new Promise((resolve,reject)=>channel.fastPut(file.local,remotePath,{step:(sent,chunk)=>onProgress&&onProgress({direction:'upload-folder',transferred:completed+sent,total,remotePath,file:file.rel})},err=>err?reject(err):resolve()));
      completed += file.size;
    }
    return { files:files.length, directories:dirs.length, bytes:total, remoteRoot };
  }

  async sftpDownloadDirectory(id, remoteRoot, localRoot, onProgress) {
    const channel = await this.getSftp(id);
    const files = [], dirs = [''];
    const walk = async (remote, rel = '') => {
      const list = await new Promise((resolve,reject)=>channel.readdir(remote,(err,value)=>err?reject(err):resolve(value)));
      for (const entry of list) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        const isDir = (entry.attrs.mode & 0o170000) === 0o040000;
        const isLink = (entry.attrs.mode & 0o170000) === 0o120000;
        if (isLink) continue;
        const safeName = entry.filename.replace(/[\\/]/g, '_');
        const childRel = rel ? path.join(rel,safeName) : safeName;
        const remotePath = path.posix.join(remote,entry.filename);
        if (isDir) { dirs.push(childRel); await walk(remotePath,childRel); }
        else files.push({ remote:remotePath, rel:childRel, size:entry.attrs.size||0 });
        if (files.length + dirs.length > 10000) throw new Error('リモートフォルダ内の項目数が10,000件を超えています。');
      }
    };
    await walk(remoteRoot);
    dirs.forEach(dir=>fs.mkdirSync(path.join(localRoot,dir),{recursive:true}));
    const total=files.reduce((n,f)=>n+f.size,0);let completed=0;
    for (const file of files) {
      const localPath=path.join(localRoot,file.rel);fs.mkdirSync(path.dirname(localPath),{recursive:true});
      await new Promise((resolve,reject)=>channel.fastGet(file.remote,localPath,{step:(got,chunk)=>onProgress&&onProgress({direction:'download-folder',transferred:completed+got,total,remotePath:file.remote,file:file.rel})},err=>err?reject(err):resolve()));
      completed+=file.size;
    }
    return { files:files.length,directories:dirs.length,bytes:total,localRoot };
  }

  async sftpReadText(id, remotePath, maxBytes = 1024 * 1024) {
    const channel = await this.getSftp(id);
    const attrs = await new Promise((resolve, reject) => channel.stat(remotePath, (err, value) => err ? reject(err) : resolve(value)));
    if (attrs.size > maxBytes) throw new Error('1MBを超えるファイルは内蔵エディターで開けません。');
    const data = await new Promise((resolve, reject) => channel.readFile(remotePath, (err, value) => err ? reject(err) : resolve(value)));
    if (data.includes(0)) throw new Error('バイナリファイルは内蔵エディターで開けません。');
    return data.toString('utf8');
  }

  async sftpWriteText(id, remotePath, content) {
    const channel = await this.getSftp(id);
    const original = await this.sftpStat(id, remotePath);
    const dir=path.posix.dirname(remotePath),base=path.posix.basename(remotePath);
    const temp=path.posix.join(dir,`.${base}.ssh-nexus-${Date.now()}-${Math.random().toString(36).slice(2,6)}.tmp`);
    try {
      await new Promise((resolve,reject)=>channel.writeFile(temp,content,{encoding:'utf8',mode:original.mode&0o7777},err=>err?reject(err):resolve()));
      if(typeof channel.ext_openssh_rename==='function'){
        await new Promise((resolve,reject)=>channel.ext_openssh_rename(temp,remotePath,err=>err?reject(err):resolve()));
      }else{
        const backup=path.posix.join(dir,`.${base}.ssh-nexus-backup-${Date.now()}`);
        await new Promise((resolve,reject)=>channel.rename(remotePath,backup,err=>err?reject(err):resolve()));
        try{await new Promise((resolve,reject)=>channel.rename(temp,remotePath,err=>err?reject(err):resolve()));}
        catch(e){await new Promise(resolve=>channel.rename(backup,remotePath,()=>resolve()));throw e;}
        await new Promise(resolve=>channel.unlink(backup,()=>resolve()));
      }
      return { atomic:true, bytes:Buffer.byteLength(content,'utf8') };
    } catch(e) {
      try{await new Promise(resolve=>channel.unlink(temp,()=>resolve()));}catch(_){}
      throw new Error('安全な一時ファイル置換に失敗しました。元のファイルは保持されています: '+e.message);
    }
  }

  async sftpMkdir(id, remotePath) {
    const channel = await this.getSftp(id);
    return await new Promise((resolve, reject) => channel.mkdir(remotePath, err => err ? reject(err) : resolve(true)));
  }

  async sftpDelete(id, remotePath, isDirectory) {
    const channel = await this.getSftp(id);
    return await new Promise((resolve, reject) => {
      const method = isDirectory ? 'rmdir' : 'unlink';
      channel[method](remotePath, err => err ? reject(err) : resolve(true));
    });
  }

  async sftpRename(id, oldPath, newPath) {
    const channel = await this.getSftp(id);
    return await new Promise((resolve, reject) => channel.rename(oldPath, newPath, err => err ? reject(err) : resolve(true)));
  }

  async sftpChmod(id, remotePath, mode) {
    const channel = await this.getSftp(id);
    const numeric = typeof mode === 'number' ? mode : parseInt(String(mode), 8);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0o7777) throw new Error('権限は755や0644などの8進数で指定してください。');
    return await new Promise((resolve, reject) => channel.chmod(remotePath, numeric, err => err ? reject(err) : resolve(true)));
  }

  async startTunnel(id, config) {
    const s = this._requireConnected(id);
    const tunnelId = 'tun_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const localHost = config.localHost || '127.0.0.1';
    const localPort = Number(config.localPort) || 0;
    const remoteHost = config.remoteHost || '127.0.0.1';
    const remotePort = Number(config.remotePort);
    if (!remotePort) throw new Error('転送先ポートが必要です。');
    const server = net.createServer(localSocket => {
      s.client.forwardOut(localSocket.remoteAddress || '127.0.0.1', localSocket.remotePort || 0, remoteHost, remotePort, (err, remoteStream) => {
        if (err) { localSocket.destroy(); return; }
        localSocket.pipe(remoteStream).pipe(localSocket);
        remoteStream.on('error', () => localSocket.destroy());
        localSocket.on('error', () => remoteStream.destroy());
      });
    });
    const result = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(localPort, localHost, () => {
        server.removeListener('error', reject);
        const address = server.address();
        resolve({ id: tunnelId, localHost, localPort: address.port, remoteHost, remotePort });
      });
    });
    server.on('error', () => {});
    s.tunnels.set(tunnelId, { ...result, server });
    return result;
  }

  async startRemoteTunnel(id, config = {}) {
    const s = this._requireConnected(id);
    const tunnelId = 'rtun_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const bindHost = config.bindHost || '127.0.0.1';
    const bindPort = Number(config.bindPort) || 0;
    const targetHost = config.targetHost || '127.0.0.1';
    const targetPort = Number(config.targetPort);
    if (!targetPort || targetPort < 1 || targetPort > 65535) throw new Error('ローカル転送先ポートが不正です');
    const assignedPort = await new Promise((resolve, reject) => {
      s.client.forwardIn(bindHost, bindPort, (err, port) => err ? reject(err) : resolve(Number(port) || bindPort));
    });
    const handler = (info, accept, reject) => {
      if (Number(info.destPort) !== assignedPort) return;
      // Establish the local destination first, so a failed service does not leave a dangling SSH channel.
      const local = net.connect(targetPort, targetHost);
      let channel = null;
      local.once('connect', () => {
        try { channel = accept(); channel.pipe(local).pipe(channel); channel.on('error', () => local.destroy()); }
        catch (e) { local.destroy(); try { reject(); } catch (_) {} }
      });
      local.once('error', () => { if (!channel) try { reject(); } catch (_) {} });
    };
    s.client.on('tcp connection', handler);
    const result = { id:tunnelId, type:'remote', bindHost, bindPort:assignedPort, targetHost, targetPort };
    s.tunnels.set(tunnelId, { ...result, stop: () => {
      s.client.removeListener('tcp connection', handler);
      try { s.client.unforwardIn(bindHost, assignedPort, () => {}); } catch (e) {}
    }});
    return result;
  }

  async startSocksProxy(id, config = {}) {
    const s = this._requireConnected(id);
    const tunnelId = 'socks_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const localHost = config.localHost || '127.0.0.1';
    const localPort = Number(config.localPort) || 0;
    const server = net.createServer(socket => {
      let buffer = Buffer.alloc(0), stage = 0, finished = false;
      const fail = (code = 1) => { try { socket.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])); } catch (e) {} socket.destroy(); };
      socket.on('data', chunk => {
        if (finished) return;
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === 0) {
          if (buffer.length < 2) return;
          const count = buffer[1]; if (buffer.length < 2 + count) return;
          if (buffer[0] !== 5 || !buffer.subarray(2, 2 + count).includes(0)) return fail(0xff);
          socket.write(Buffer.from([5, 0])); buffer = buffer.subarray(2 + count); stage = 1;
        }
        if (stage === 1) {
          if (buffer.length < 5) return;
          if (buffer[0] !== 5 || buffer[1] !== 1) return fail(7);
          const atyp = buffer[3]; let host, offset;
          if (atyp === 1) { if (buffer.length < 10) return; host = [...buffer.subarray(4, 8)].join('.'); offset = 8; }
          else if (atyp === 3) { const len = buffer[4]; if (buffer.length < 7 + len) return; host = buffer.subarray(5, 5 + len).toString('utf8'); offset = 5 + len; }
          else if (atyp === 4) { if (buffer.length < 22) return; const parts=[]; for(let i=4;i<20;i+=2)parts.push(buffer.readUInt16BE(i).toString(16)); host=parts.join(':'); offset=20; }
          else return fail(8);
          const port = buffer.readUInt16BE(offset); const pending = buffer.subarray(offset + 2); finished = true;
          s.client.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, host, port, (err, remote) => {
            if (err) return fail(5);
            socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            if (pending.length) remote.write(pending);
            socket.pipe(remote).pipe(socket);
            remote.on('error', () => socket.destroy());
          });
        }
      });
      socket.on('error', () => {});
    });
    const result = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(localPort, localHost, () => {
        server.removeListener('error', reject); const address = server.address();
        resolve({ id:tunnelId, type:'socks5', localHost, localPort:address.port, remoteHost:'SOCKS5', remotePort:0 });
      });
    });
    server.on('error', () => {}); s.tunnels.set(tunnelId, { ...result, server }); return result;
  }

  listTunnels(id) {
    const s = this._requireConnected(id);
    return [...s.tunnels.values()].map(({ server, stop, ...info }) => info);
  }

  stopTunnel(id, tunnelId) {
    const s = this.sessions.get(id);
    if (!s) return false;
    const tunnel = s.tunnels.get(tunnelId);
    if (!tunnel) return false;
    try { if (tunnel.stop) tunnel.stop(); else if (tunnel.server) tunnel.server.close(); } catch (e) {}
    s.tunnels.delete(tunnelId);
    return true;
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (s && s.stream) { s.stream.write(iconv.encode(String(data), s.encoding || terminalEncoding(s.info&&s.info.encoding))); return true; }
    return false;
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s) return false;
    const nextCols=Math.min(1000,Math.max(2,Math.floor(Number(cols)||80)));
    const nextRows=Math.min(1000,Math.max(1,Math.floor(Number(rows)||24)));
    // Save dimensions even while authentication/shell startup is still running.
    // Full-screen programs such as byobu, tmux, vim and top then receive the
    // actual viewport size from their very first frame instead of 80x24.
    s.cols=nextCols;s.rows=nextRows;
    if (s.stream) {
      try { s.stream.setWindow(nextRows, nextCols, 0, 0); } catch (e) {}
    }
    return true;
  }

  disconnect(id) {
    const s = this.sessions.get(id);
    this._cancelChallenges(id);
    if (!s) return;
    for (const tunnel of s.tunnels.values()) { try { if (tunnel.stop) tunnel.stop(); else if (tunnel.server) tunnel.server.close(); } catch (e) {} }
    s.tunnels.clear();
    try { this.cancelSftpTransfers(id); } catch (e) {}
    try { if (s.stream) s.stream.close(); } catch (e) {}
    try { s.client.end(); } catch (e) {}
    for(const jump of s.jumpClients||[]){try{jump.end();}catch(e){}}
    this.sessions.delete(id);
  }

  disconnectAll() { for (const id of [...this.sessions.keys()]) this.disconnect(id); }

  list() {
    return [...this.sessions.values()].map(s => ({ id: s.id, host: s.info.host, username: s.info.username, connected: s.connected }));
  }
}

module.exports = { SshManager, friendlyError, connectionOptions };
