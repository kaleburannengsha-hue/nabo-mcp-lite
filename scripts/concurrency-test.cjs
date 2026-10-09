#!/usr/bin/env node
'use strict';
// Live concurrency test against the RUNNING hub (9877).
// Answers: when two sessions call tools at the same time, are they serialized?
// Read-only tools only — does not disturb the user's page state.

const { WebSocket } = require('ws');
const { getHubPort } = require('../server/shared.cjs');

const HUB_URL = `ws://127.0.0.1:${getHubPort()}`;
let seq = 0;

function makeClient(name) {
  const ws = new WebSocket(HUB_URL);
  const pending = new Map();
  const ready = new Promise((res, rej) => {
    ws.on('open', () => res());
    ws.on('error', rej);
  });
  ws.on('message', data => {
    const msg = JSON.parse(data.toString());
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    p(msg);
  });
  return {
    name,
    ready,
    call(tool, args = {}) {
      const id = `${name}_${++seq}`;
      const t0 = Date.now();
      return new Promise((resolve, reject) => {
        pending.set(id, msg => {
          const ms = Date.now() - t0;
          if (msg.type === 'tool_result') resolve({ ms, result: msg.result });
          else reject(new Error(`${tool} failed: ${msg.error}`));
        });
        ws.send(JSON.stringify({ id, type: 'call_tool', tool, args }));
      });
    },
    close() { ws.close(); },
  };
}

(async () => {
  const A = makeClient('A');
  const B = makeClient('B');
  await Promise.all([A.ready, B.ready]);
  console.log('two clients connected to hub\n');

  // 1) baseline: one get_dom alone
  const t1 = await A.call('get_dom');
  console.log(`1) A get_dom alone .......... ${t1.ms} ms (elements=${String(t1.result.elements).length} chars)`);

  // 2) two get_dom fired simultaneously
  const t0 = Date.now();
  const [rA, rB] = await Promise.all([A.call('get_dom'), B.call('get_dom')]);
  const wall = Date.now() - t0;
  const max = Math.max(rA.ms, rB.ms);
  // Serialized: wall ≈ 2 × single, and one call's ms ≈ 2 × single (it waited in queue).
  // Parallel:   wall ≈ single, both calls ≈ single.
  const ratio = wall / t1.ms;
  console.log(`2) A+B get_dom simultaneously . A=${rA.ms}ms B=${rB.ms}ms wall=${wall}ms (single=${t1.ms}ms, ratio=${ratio.toFixed(2)}x)`);
  console.log(`   verdict: ${ratio >= 1.6 ? 'SERIALIZED (queue works)' : ratio <= 1.25 ? 'PARALLEL (no lock!)' : 'UNCLEAR'}`);

  // 3) does a fast read-only call jump the queue while a slow one runs?
  const slow = A.call('get_dom');
  await new Promise(r => setTimeout(r, 150)); // let the slow call start
  const fast = await B.call('list_tabs');
  await slow;
  console.log(`3) B list_tabs during A get_dom . ${fast.ms}ms ${fast.ms < 150 ? '→ BYPASSED queue' : '→ also queued (strict FIFO)'}`);

  A.close(); B.close();
  process.exit(0);
})().catch(err => {
  console.error('TEST FAILED:', err.message);
  process.exit(1);
});
