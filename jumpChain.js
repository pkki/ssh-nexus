'use strict';

function buildJumpChain(connection, getById, maxHops = 5) {
  if (!connection || !connection.jumpHostId) return [];
  const seen = new Set(connection.id ? [connection.id] : []);
  const reversed = [];
  let id = connection.jumpHostId;
  while (id) {
    if (seen.has(id)) throw new Error('踏み台チェーンに循環参照があります。');
    if (reversed.length >= maxHops) throw new Error(`踏み台チェーンは最大${maxHops}段です。`);
    seen.add(id);
    const hop = getById(id);
    if (!hop) throw new Error(`踏み台接続先が見つかりません: ${id}`);
    reversed.push(hop);
    id = hop.jumpHostId || '';
  }
  return reversed.reverse();
}

module.exports = { buildJumpChain };
