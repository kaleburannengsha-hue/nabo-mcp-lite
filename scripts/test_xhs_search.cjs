const { WebSocket } = require('D:/all_code/tools/localbower/node_modules/ws');
const ws = new WebSocket('ws://127.0.0.1:9877');

function call(tool, args = {}) {
  return new Promise((resolve) => {
    const id = 'test_' + tool;
    ws.send(JSON.stringify({ id, type: 'call_tool', tool, args }));
    ws.once('message', data => {
      resolve(JSON.parse(data.toString()));
    });
    setTimeout(() => resolve({ type: 'timeout' }), 10000);
  });
}

// The key insight: XHS's INITIAL_STATE JSON contains "undefined" as a raw value
// (not quoted), which is not valid JSON. But the inline script assigns it directly
// to window.__INITIAL_STATE__. So by the time we read, window.__INITIAL_STATE__ is
// already set with the correct JS object (undefined mapped to JS undefined).
// We just need to check that global — but the first test showed it was "undefined"
// at the time of our CDP execution. That likely means CDP runs in a separate world!

const EXTRACT = `
(() => {
  // Key insight: window.__INITIAL_STATE__ IS set by the inline script
  // But CDP Runtime.evaluate runs in an isolated world (worldName: 'nabo_mcp_lite')
  // which doesn't see the main world's globals!
  // The main-world script tag runs AFTER the isolated world is created,
  // so window.__INITIAL_STATE__ is not visible in our isolated context.
  //
  // Solution: Read the raw text, replace JS literals, then JSON.parse
  const scripts = document.querySelectorAll('script:not([src])');
  for (const s of scripts) {
    const t = s.textContent || '';
    const idx = t.indexOf('window.__INITIAL_STATE__=');
    if (idx === -1) continue;

    const after = t.slice(idx);
    const equalsPos = after.indexOf('=');
    let jsonStr = after.slice(equalsPos + 1).trim();

    // Replace JS undefined/null with JSON null (XHS uses undefined as values)
    // This is a hack but works because undefined only appears as property values
    jsonStr = jsonStr.replace(/:undefined([,\\s\\}])/g, ':null$1');

    try {
      const state = JSON.parse(jsonStr);
      const feeds = state.search?.feeds?._rawValue || [];
      const notes = feeds.slice(0, 3).map(item => {
        const nc = item.note_card || {};
        return {
          id: item.id,
          title: nc.display_title,
          type: nc.type,
          user: (nc.user || {}).nickname,
          xsec: item.xsec_token
        };
      });
      return { ok: true, total: feeds.length, sample: notes };
    } catch(e) {
      return { error: e.message };
    }
  }
  return { error: 'no script found' };
})()
`;

ws.on('open', async () => {
  const r = await call('execute_script', { code: EXTRACT });
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
});
ws.on('error', err => { console.error('WS error:', err.message); process.exit(1); });
