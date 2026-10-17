'use strict';

function parseExternalConnect(argv = []) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  let value = args.find(x => /^sshnexus:\/\//i.test(x));
  const flag = args.findIndex(x => x === '--connect');
  if (!value && flag >= 0) value = args[flag + 1];
  if (!value) return null;
  let host = '', username = '', port = 22;
  try {
    if (/^sshnexus:\/\//i.test(value)) {
      const u = new URL(value);
      host = u.searchParams.get('host') || (u.hostname.toLowerCase() === 'connect' ? '' : u.hostname);
      username = decodeURIComponent(u.searchParams.get('user') || u.username || '');
      port = Number(u.searchParams.get('port') || u.port || 22);
    } else {
      const m = value.match(/^(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/);
      if (!m) return null;
      username = m[1] || '';
      host = m[2].replace(/^\[|\]$/g, '');
      port = Number(m[3] || 22);
    }
  } catch (e) { return null; }
  if (!host || /[\s\x00-\x1f]/.test(host) || host.length > 255 || /[\x00-\x1f]/.test(username) || username.length > 128 || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, username, port, source:'external' };
}

module.exports = { parseExternalConnect };
