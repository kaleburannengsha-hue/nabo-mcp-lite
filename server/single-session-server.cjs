#!/usr/bin/env node
// Compatibility entry point. Hub mode splits the old single process into:
// - nabo-hub.cjs: one shared bridge for Chrome extension port 9876
// - nabo-client.cjs: one stdio MCP client per Agent
'use strict';

const { runClient } = require('./nabo-client.cjs');

runClient();

