const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const SALT_LEN = 32;
const IV_LEN = 12;
const LEGACY_SCRYPT_N = 1 << 15;
const SCRYPT_N = 1 << 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function paths(userData) {
  return {
    store: path.join(userData, 'vault.json'),
    meta: path.join(userData, 'vault.meta.json'),
    helloKey: path.join(userData, 'vault.hello-key')
  };
}
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const temp=file+'.tmp-'+process.pid+'-'+crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(temp,content,{mode:0o600});fs.renameSync(temp,file);
}
function validateRecoveryPassphrase(value) {
  const text=String(value||'');
  if(text.length<16)throw new Error('Recovery passphrase must be at least 16 characters');
  const classes=[/[a-z]/,/[A-Z]/,/\d/,/[^A-Za-z0-9]/].filter(r=>r.test(text)).length;
  if(text.length<20&&classes<3)throw new Error('Use at least 3 character types, or a passphrase of 20+ characters');
  return text;
}
function deriveKey(secret,salt,params={}) {
  return crypto.scryptSync(String(secret),salt,KEY_LEN,{N:Number(params.N)||SCRYPT_N,r:Number(params.r)||SCRYPT_R,p:Number(params.p)||SCRYPT_P,maxmem:256*1024*1024});
}

class Vault {
  constructor(userData) {
    this.userData=userData;this.key=null;this.salt=null;this.data={connections:[],knownHosts:{},appData:{}};this.p=paths(userData);this.version=0;this.legacyUnlocked=false;
  }
  exists(){return fs.existsSync(this.p.meta)&&fs.existsSync(this.p.store);}
  getVersion(){if(this.version)return this.version;try{return Number(JSON.parse(fs.readFileSync(this.p.meta,'utf8')).version)||1;}catch(e){return 0;}}
  securityInfo(){const version=this.getVersion();return{version,migrationRequired:version>0&&version<2,fullyEncrypted:version>=2,kdf:version>=2?'scrypt-N131072':'legacy-scrypt-N32768'};}

  setup(recoveryPassphrase) {
    if(this.exists())throw new Error('Vault already exists');
    const phrase=validateRecoveryPassphrase(recoveryPassphrase),salt=crypto.randomBytes(SALT_LEN),kek=deriveKey(phrase,salt),master=crypto.randomBytes(KEY_LEN);
    this.key=master;this.salt=salt;this.version=2;this.legacyUnlocked=false;this.data={connections:[],knownHosts:{},appData:{}};
    const meta={format:'ssh-nexus-vault-meta',version:2,kdf:{name:'scrypt',N:SCRYPT_N,r:SCRYPT_R,p:SCRYPT_P,salt:salt.toString('base64')},wrappedKey:this._encryptBuffer(master,kek).toString('base64'),createdAt:new Date().toISOString()};
    atomicWrite(this.p.meta,JSON.stringify(meta,null,2));this._persist();
  }
  _loadMeta(){return JSON.parse(fs.readFileSync(this.p.meta,'utf8'));}
  unlock(secret) {
    if(!this.exists())throw new Error('Vault not initialized');
    const meta=this._loadMeta(),version=Number(meta.version)||1;
    if(version>=2){const salt=Buffer.from(meta.kdf.salt,'base64'),kek=deriveKey(secret,salt,meta.kdf);let master;try{master=this._decryptBuffer(Buffer.from(meta.wrappedKey,'base64'),kek);}catch(e){throw new Error('Invalid recovery passphrase');}return this.unlockWithKey(master);}
    this.salt=Buffer.from(meta.salt,'base64');const legacyKey=crypto.scryptSync(String(secret),this.salt,KEY_LEN,{N:LEGACY_SCRYPT_N,maxmem:64*1024*1024});
    this._unlockLegacyWithKey(legacyKey);return{legacy:true,migrationRequired:true};
  }
  _unlockLegacyWithKey(key) {
    const meta=this._loadMeta();let ok=false;try{ok=this._decryptBuffer(Buffer.from(meta.verifier,'base64'),key).toString('utf8')==='SSH_NEXUS_OK';}catch(e){}
    if(!ok)throw new Error('Invalid PIN');this.key=Buffer.from(key);this.version=1;this.legacyUnlocked=true;
    const store=JSON.parse(fs.readFileSync(this.p.store,'utf8'));this.data={connections:(store.connections||[]).map(c=>this._decryptLegacyConnection(c)),knownHosts:{},appData:{}};
  }
  unlockWithKey(keyValue) {
    if(!this.exists())throw new Error('Vault not initialized');const key=Buffer.isBuffer(keyValue)?Buffer.from(keyValue):Buffer.from(keyValue,'base64');if(key.length!==KEY_LEN)throw new Error('Invalid vault key');
    const version=this.getVersion();if(version<2){this._unlockLegacyWithKey(key);return true;}
    const store=JSON.parse(fs.readFileSync(this.p.store,'utf8'));if(store.version!==2||!store.payload)throw new Error('Invalid encrypted vault store');
    let parsed;try{parsed=JSON.parse(this._decryptBuffer(Buffer.from(store.payload,'base64'),key).toString('utf8'));}catch(e){throw new Error('Vault authentication failed');}
    if(!parsed||!Array.isArray(parsed.connections))throw new Error('Invalid vault payload');
    this.key=key;this.version=2;this.legacyUnlocked=false;this.data={connections:parsed.connections,knownHosts:parsed.knownHosts&&typeof parsed.knownHosts==='object'?parsed.knownHosts:{},appData:parsed.appData&&typeof parsed.appData==='object'?parsed.appData:{}};return true;
  }
  migrateLegacy(recoveryPassphrase,knownHosts={}) {
    if(!this.legacyUnlocked||this.version!==1)throw new Error('Legacy vault must be unlocked first');
    const phrase=validateRecoveryPassphrase(recoveryPassphrase),oldData=this.data,salt=crypto.randomBytes(SALT_LEN),kek=deriveKey(phrase,salt),master=crypto.randomBytes(KEY_LEN);
    this.key=master;this.salt=salt;this.version=2;this.legacyUnlocked=false;this.data={connections:oldData.connections,knownHosts:{...(knownHosts||{})},appData:{}};
    const meta={format:'ssh-nexus-vault-meta',version:2,kdf:{name:'scrypt',N:SCRYPT_N,r:SCRYPT_R,p:SCRYPT_P,salt:salt.toString('base64')},wrappedKey:this._encryptBuffer(master,kek).toString('base64'),migratedAt:new Date().toISOString()};
    atomicWrite(this.p.meta,JSON.stringify(meta,null,2));this._persist();return this.securityInfo();
  }
  exportKeyForOsProtection(){this._requireUnlocked();return this.key.toString('base64');}
  lock(){if(this.key)try{this.key.fill(0);}catch(e){}this.key=null;this.data={connections:[],knownHosts:{},appData:{}};this.legacyUnlocked=false;}
  isUnlocked(){return!!this.key;}

  _encryptBuffer(buf,key){const k=key||this.key,iv=crypto.randomBytes(IV_LEN),cipher=crypto.createCipheriv(ALGO,k,iv),ct=Buffer.concat([cipher.update(buf),cipher.final()]),tag=cipher.getAuthTag();return Buffer.concat([iv,tag,ct]);}
  _decryptBuffer(buf,key){if(!Buffer.isBuffer(buf)||buf.length<IV_LEN+16)throw new Error('Invalid encrypted data');const k=key||this.key,iv=buf.subarray(0,IV_LEN),tag=buf.subarray(IV_LEN,IV_LEN+16),ct=buf.subarray(IV_LEN+16),decipher=crypto.createDecipheriv(ALGO,k,iv);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(ct),decipher.final()]);}
  seal(value,purpose='external'){this._requireV2();const envelope={format:'ssh-nexus-encrypted',version:1,purpose,data:value};return this._encryptBuffer(Buffer.from(JSON.stringify(envelope),'utf8')).toString('base64');}
  unseal(encoded,purpose='external'){this._requireV2();const envelope=JSON.parse(this._decryptBuffer(Buffer.from(String(encoded),'base64')).toString('utf8'));if(envelope.format!=='ssh-nexus-encrypted'||envelope.purpose!==purpose)throw new Error('Encrypted data purpose mismatch');return envelope.data;}

  _decryptLegacyStr(s){if(!s)return'';return this._decryptBuffer(Buffer.from(s,'base64')).toString('utf8');}
  _decryptLegacyConnection(c){let password='',privateKey='',passphrase='';try{password=c.password?this._decryptLegacyStr(c.password):'';}catch(e){}try{privateKey=c.privateKey?this._decryptLegacyStr(c.privateKey):'';}catch(e){}try{passphrase=c.passphrase?this._decryptLegacyStr(c.passphrase):'';}catch(e){}return{...c,password,privateKey,passphrase};}
  _persist(){this._requireUnlocked();if(this.version<2)throw new Error('Legacy vault must be migrated before changes');const payload=this._encryptBuffer(Buffer.from(JSON.stringify(this.data),'utf8')).toString('base64');atomicWrite(this.p.store,JSON.stringify({format:'ssh-nexus-vault',version:2,payload},null,2));}

  list(){this._requireUnlocked();return this.data.connections.map(c=>({id:c.id,name:c.name,host:c.host,port:c.port,username:c.username,timeoutSeconds:c.timeoutSeconds||8,keepaliveIntervalSeconds:c.keepaliveIntervalSeconds==null?10:Number(c.keepaliveIntervalSeconds),keepaliveCountMax:c.keepaliveCountMax||3,authType:c.authType,agentPath:c.agentPath||'',agentForward:!!c.agentForward,encoding:c.encoding||'utf8',hasPassword:!!c.password,hasKey:!!c.privateKey,notes:c.notes,startupCommand:c.startupCommand||'',autoTunnels:Array.isArray(c.autoTunnels)?c.autoTunnels.slice(0,20):[],group:c.group,favorite:!!c.favorite,autoReconnect:!!c.autoReconnect,reconnectDelay:c.reconnectDelay||3,compression:!!c.compression,jumpHostId:c.jumpHostId||'',lastConnectedAt:c.lastConnectedAt||0,createdAt:c.createdAt,updatedAt:c.updatedAt}));}
  get(id){this._requireUnlocked();const c=this.data.connections.find(x=>x.id===id);if(!c)throw new Error('Connection not found');return{...c};}
  add(conn){this._requireV2();const c={id:conn.id||crypto.randomUUID(),name:conn.name||conn.host,host:conn.host,port:conn.port||22,username:conn.username,timeoutSeconds:conn.timeoutSeconds||8,keepaliveIntervalSeconds:conn.keepaliveIntervalSeconds==null?10:Number(conn.keepaliveIntervalSeconds),keepaliveCountMax:conn.keepaliveCountMax||3,authType:conn.authType||'password',agentPath:conn.agentPath||'',agentForward:!!conn.agentForward,encoding:conn.encoding||'utf8',password:conn.password||'',privateKey:conn.privateKey||'',passphrase:conn.passphrase||'',notes:conn.notes||'',startupCommand:conn.startupCommand||'',autoTunnels:Array.isArray(conn.autoTunnels)?conn.autoTunnels.slice(0,20):[],group:conn.group||'',favorite:!!conn.favorite,autoReconnect:!!conn.autoReconnect,reconnectDelay:conn.reconnectDelay||3,compression:!!conn.compression,jumpHostId:conn.jumpHostId||'',lastConnectedAt:conn.lastConnectedAt||0,createdAt:Date.now(),updatedAt:Date.now()};this.data.connections.push(c);this._persist();return c.id;}
  update(id,patch){this._requireV2();const c=this.data.connections.find(x=>x.id===id);if(!c)throw new Error('Connection not found');Object.assign(c,patch,{updatedAt:Date.now()});this._persist();}
  remove(id){this._requireV2();this.data.connections=this.data.connections.filter(x=>x.id!==id);this._persist();}
  getKnownHosts(){this._requireV2();return{...(this.data.knownHosts||{})};}
  setKnownHost(identity,fingerprint){this._requireV2();this.data.knownHosts=this.data.knownHosts||{};this.data.knownHosts[String(identity)]=String(fingerprint);this._persist();}
  removeKnownHost(identity){this._requireV2();delete(this.data.knownHosts||{})[String(identity)];this._persist();}
  getAppData(key){this._requireV2();const value=(this.data.appData||{})[String(key)];return value==null?null:JSON.parse(JSON.stringify(value));}
  setAppData(key,value){this._requireV2();this.data.appData=this.data.appData||{};this.data.appData[String(key)]=JSON.parse(JSON.stringify(value));this._persist();return true;}
  deleteAppData(key){this._requireV2();delete(this.data.appData||{})[String(key)];this._persist();return true;}
  changePin(oldPhrase,newPhrase){this._requireV2();const meta=this._loadMeta(),salt=Buffer.from(meta.kdf.salt,'base64'),oldKek=deriveKey(oldPhrase,salt,meta.kdf);let master;try{master=this._decryptBuffer(Buffer.from(meta.wrappedKey,'base64'),oldKek);}catch(e){throw new Error('Invalid recovery passphrase');}if(!crypto.timingSafeEqual(master,this.key))throw new Error('Invalid recovery passphrase');const phrase=validateRecoveryPassphrase(newPhrase),newSalt=crypto.randomBytes(SALT_LEN),newKek=deriveKey(phrase,newSalt);meta.kdf={name:'scrypt',N:SCRYPT_N,r:SCRYPT_R,p:SCRYPT_P,salt:newSalt.toString('base64')};meta.wrappedKey=this._encryptBuffer(this.key,newKek).toString('base64');meta.updatedAt=new Date().toISOString();atomicWrite(this.p.meta,JSON.stringify(meta,null,2));}
  exportJson(){this._requireUnlocked();return JSON.stringify(this.data,null,2);}
  _requireUnlocked(){if(!this.key)throw new Error('Vault locked');}
  _requireV2(){this._requireUnlocked();if(this.version<2)throw new Error('Security migration required');}
}
module.exports={Vault,validateRecoveryPassphrase};
