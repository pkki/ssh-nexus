'use strict';
const crypto = require('crypto');

function splitWords(value) {
  const words=[];String(value||'').replace(/"([^"]*)"|'([^']*)'|(\S+)/g,(_,a,b,c)=>{words.push(a??b??c);return '';});return words;
}
function stripComment(line){let quote='';for(let i=0;i<line.length;i++){const c=line[i];if((c==='"'||c==="'")&&!quote)quote=c;else if(c===quote)quote='';else if(c==='#'&&!quote)return line.slice(0,i);}return line;}
function truthy(v){return /^(yes|true|on|1)$/i.test(String(v||''));}
function parseJumpToken(token){let value=String(token||'').trim(),username='';const at=value.lastIndexOf('@');if(at>=0){username=value.slice(0,at);value=value.slice(at+1);}let host=value,port=22;if(/^\[[^\]]+\](?::\d+)?$/.test(value)){const m=value.match(/^\[([^\]]+)\](?::(\d+))?$/);host=m[1];port=Number(m[2]||22);}else if((value.match(/:/g)||[]).length===1){const i=value.lastIndexOf(':');if(/^\d+$/.test(value.slice(i+1))){host=value.slice(0,i);port=Number(value.slice(i+1));}}return{alias:token,host,port,username};}

function parseOpenSshConfig(content){
  const defaults={},wildcardDefaults={};const blocks=[];let active=[];let sawHost=false;
  const set=(obj,key,value)=>{if(obj[key]==null)obj[key]=value;};
  for(const raw of String(content||'').split(/\r?\n/)){
    const line=stripComment(raw).trim();if(!line)continue;const m=line.match(/^(\S+)(?:\s+|\s*=\s*)(.*)$/);if(!m)continue;const key=m[1].toLowerCase(),value=m[2].trim();
    if(key==='host'){sawHost=true;active=[];for(const alias of splitWords(value)){if(alias==='*'){active.push({alias:'*',values:wildcardDefaults,wildcard:true});continue;}if(/[*!?]/.test(alias))continue;const block={alias,values:{...defaults}};blocks.push(block);active.push(block);}continue;}
    const targets=sawHost?active.map(x=>x.values):[defaults];for(const target of targets){
      if(key==='hostname')set(target,'host',value);else if(key==='user')set(target,'username',value);else if(key==='port')set(target,'port',Number(value)||22);else if(key==='identityfile')set(target,'identityFile',value);else if(key==='proxyjump')set(target,'proxyJump',value);else if(key==='compression')set(target,'compression',truthy(value));else if(key==='connecttimeout')set(target,'timeoutSeconds',Number(value)||8);else if(key==='serveraliveinterval')set(target,'keepaliveIntervalSeconds',Number(value)||0);else if(key==='serveralivecountmax')set(target,'keepaliveCountMax',Number(value)||3);else if(key==='forwardagent')set(target,'agentForward',truthy(value));
    }
  }
  const records=blocks.map(({alias,values})=>{const v={...wildcardDefaults,...values};return{id:crypto.randomUUID(),name:alias,host:v.host||alias,port:v.port||22,username:v.username||'',authType:v.identityFile?'key':'password',notes:v.identityFile?`OpenSSH IdentityFile: ${v.identityFile}`:'OpenSSH configからインポート',group:'OpenSSH',compression:!!v.compression,timeoutSeconds:v.timeoutSeconds||8,keepaliveIntervalSeconds:v.keepaliveIntervalSeconds==null?10:v.keepaliveIntervalSeconds,keepaliveCountMax:v.keepaliveCountMax||3,agentForward:!!v.agentForward,_alias:alias,_proxyJump:v.proxyJump||''};});
  const byAlias=new Map(records.map(x=>[x._alias,x]));
  const ensureJump=token=>{const parsed=parseJumpToken(token);let record=byAlias.get(token)||byAlias.get(parsed.host);if(record)return record;record={id:crypto.randomUUID(),name:token,host:parsed.host,port:parsed.port,username:parsed.username,authType:'password',notes:'ProxyJump参照から作成（認証情報を設定してください）',group:'OpenSSH',timeoutSeconds:8,keepaliveIntervalSeconds:10,keepaliveCountMax:3,_alias:token,_proxyJump:''};records.push(record);byAlias.set(token,record);return record;};
  for(const record of [...records]){if(!record._proxyJump||/^none$/i.test(record._proxyJump))continue;let previous='';for(const token of record._proxyJump.split(',').map(x=>x.trim()).filter(Boolean)){const hop=ensureJump(token);if(previous&&!hop.jumpHostId)hop.jumpHostId=previous;previous=hop.id;}if(previous)record.jumpHostId=previous;}
  return records.map(record=>{const out={...record};delete out._alias;delete out._proxyJump;return out;});
}
module.exports={parseOpenSshConfig,parseJumpToken};
