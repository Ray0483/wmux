#!/usr/bin/env node
// json-tool.js — Node.js replacement for jq in wmux-orchestrator scripts.
// Works on Windows without jq installed. Node.js is always available (Claude Code runs on it).
//
// Usage:
//   node json-tool.js get <file> <path>
//   node json-tool.js set <file> <path> <value>
//   node json-tool.js inc <file> <path>
//   node json-tool.js query <file> <query-name> [args...]
//   node json-tool.js update-agent <file> <agentId> <field=value>...
//   node json-tool.js dashboard <file>
//   node json-tool.js find-unreaped-finished <baseDir>
//   node json-tool.js parse-json <jsonString> <path>
//   node json-tool.js find-spawned <label> <paneId>   (`wmux agent list` JSON on stdin)

'use strict';

const fs = require('fs');
const path = require('path');

// ── Helpers ──────────────────────────────────────────────────────────────────

function readJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`json-tool: cannot read ${filePath}: ${e.message}\n`);
    process.exit(1);
  }
}

function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (e) {
    process.stderr.write(`json-tool: cannot write ${filePath}: ${e.message}\n`);
    process.exit(1);
  }
}

/**
 * Resolve a jq-style dot path on an object.
 * Supports: .foo, .foo.bar, .foo[0], .foo[0].bar, .waves[0].agents[0].toolUses
 * Also supports quoted keys with dots inside them (rare but safe).
 */
function resolvePath(obj, dotPath) {
  if (!dotPath || dotPath === '.') return obj;

  // Remove leading dot
  let p = dotPath.startsWith('.') ? dotPath.slice(1) : dotPath;

  const tokens = [];
  // Tokenize: split on '.' and '[N]'
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(p)) !== null) {
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(parseInt(m[2], 10));
  }

  let current = obj;
  for (const tok of tokens) {
    if (current == null) return undefined;
    current = current[tok];
  }
  return current;
}

/**
 * Set a value at a jq-style dot path, mutating the object in place.
 */
function setPath(obj, dotPath, value) {
  if (!dotPath || dotPath === '.') return value;

  let p = dotPath.startsWith('.') ? dotPath.slice(1) : dotPath;

  const tokens = [];
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(p)) !== null) {
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(parseInt(m[2], 10));
  }

  let current = obj;
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i];
    if (current[tok] == null) {
      // Create intermediate object or array
      const nextTok = tokens[i + 1];
      current[tok] = typeof nextTok === 'number' ? [] : {};
    }
    current = current[tok];
  }
  current[tokens[tokens.length - 1]] = value;
  return obj;
}

/**
 * Smart value parsing: try JSON first (for numbers, bools, null, objects, arrays),
 * fall back to string.
 */
function parseValue(str) {
  if (str === undefined || str === null) return null;
  // Try to parse as JSON literal
  try {
    return JSON.parse(str);
  } catch {
    // It's a plain string
    return str;
  }
}

/**
 * Find all agents across all waves, returning { waveIndex, agentIndex, agent } tuples.
 */
function findAgent(data, agentId) {
  if (!data.waves) return null;
  for (let wi = 0; wi < data.waves.length; wi++) {
    const wave = data.waves[wi];
    if (!wave.agents) continue;
    for (let ai = 0; ai < wave.agents.length; ai++) {
      if (wave.agents[ai].id === agentId) {
        return { waveIndex: wi, agentIndex: ai, agent: wave.agents[ai] };
      }
    }
  }
  return null;
}

/**
 * Cell index per agent of one wave: agents sharing a trimmed, non-blank string
 * `group` share a cell; every other agent (missing/null/non-string/blank group,
 * or a non-object entry) gets its own. Cells are numbered by first appearance.
 * The sidebar's groupWaveAgents applies the same rule; a parity test pins both.
 */
function cellsForAgents(agents) {
  const list = Array.isArray(agents) ? agents : [];
  const byName = new Map();
  let next = 0;
  return list.map(agent => {
    const raw = agent && typeof agent === 'object' ? agent.group : undefined;
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name === '') return next++;
    if (!byName.has(name)) byName.set(name, next++);
    return byName.get(name);
  });
}

// ── Commands ─────────────────────────────────────────────────────────────────

function cmdGet(file, dotPath) {
  const data = readJSON(file);
  const val = resolvePath(data, dotPath);
  if (val === undefined || val === null) {
    process.stdout.write('null\n');
  } else if (typeof val === 'object') {
    process.stdout.write(JSON.stringify(val) + '\n');
  } else {
    process.stdout.write(String(val) + '\n');
  }
}

function cmdSet(file, dotPath, rawValue) {
  const data = readJSON(file);
  const value = parseValue(rawValue);
  setPath(data, dotPath, value);
  writeJSON(file, data);
}

function cmdInc(file, dotPath) {
  const data = readJSON(file);
  const current = resolvePath(data, dotPath);
  const newVal = (typeof current === 'number' ? current : 0) + 1;
  setPath(data, dotPath, newVal);
  writeJSON(file, data);
}

function cmdQuery(file, queryName, ...args) {
  const data = readJSON(file);

  switch (queryName) {
    case 'agents-by-status': {
      const status = args[0];
      if (!data.waves) break;
      for (const wave of data.waves) {
        if (!wave.agents) continue;
        for (const agent of wave.agents) {
          if (agent.status === status) {
            process.stdout.write(agent.id + '\n');
          }
        }
      }
      break;
    }

    case 'wave-of-agent': {
      const agentId = args[0];
      const found = findAgent(data, agentId);
      if (found) {
        process.stdout.write(String(found.waveIndex) + '\n');
      }
      break;
    }

    case 'count-agents-by-status': {
      const status = args[0];
      let count = 0;
      if (data.waves) {
        for (const wave of data.waves) {
          if (!wave.agents) continue;
          for (const agent of wave.agents) {
            if (agent.status === status) count++;
          }
        }
      }
      process.stdout.write(String(count) + '\n');
      break;
    }

    case 'wave-complete': {
      const waveIdx = parseInt(args[0], 10);
      if (!data.waves || !data.waves[waveIdx]) {
        process.stdout.write('true\n');
        break;
      }
      const agents = data.waves[waveIdx].agents || [];
      const allDone = agents.every(a => a.status === 'exited' || a.status === 'failed');
      process.stdout.write(allDone ? 'true' : 'false');
      process.stdout.write('\n');
      break;
    }

    case 'next-pending-wave': {
      if (data.waves) {
        for (let i = 0; i < data.waves.length; i++) {
          if (data.waves[i].status === 'pending') {
            process.stdout.write(String(i) + '\n');
            return;
          }
        }
      }
      // Print nothing if no pending wave found
      break;
    }

    case 'all-waves-done': {
      if (!data.waves || data.waves.length === 0) {
        process.stdout.write('true\n');
        break;
      }
      const done = data.waves.every(w => w.status !== 'pending' && w.status !== 'running');
      process.stdout.write(done ? 'true' : 'false');
      process.stdout.write('\n');
      break;
    }

    case 'wave-agents': {
      const waveIdx = parseInt(args[0], 10);
      if (!data.waves || !data.waves[waveIdx]) {
        process.stdout.write('[]\n');
        break;
      }
      process.stdout.write(JSON.stringify(data.waves[waveIdx].agents || []) + '\n');
      break;
    }

    case 'wave-count': {
      process.stdout.write(String((data.waves || []).length) + '\n');
      break;
    }

    case 'wave-agent-ids': {
      const waveIdx = parseInt(args[0], 10);
      if (data.waves && data.waves[waveIdx] && data.waves[waveIdx].agents) {
        for (const agent of data.waves[waveIdx].agents) {
          process.stdout.write(agent.id + '\n');
        }
      }
      break;
    }

    case 'agent-label': {
      const agentId = args[0];
      const found = findAgent(data, agentId);
      if (found) {
        process.stdout.write(String(found.agent.label || '') + '\n');
      }
      break;
    }

    case 'wave-status': {
      const waveIdx = parseInt(args[0], 10);
      if (data.waves && data.waves[waveIdx]) {
        process.stdout.write(String(data.waves[waveIdx].status || 'unknown') + '\n');
      }
      break;
    }

    case 'wave-agents-each': {
      // Output each agent as a compact JSON line (for while-read loops)
      const waveIdx = parseInt(args[0], 10);
      if (data.waves && data.waves[waveIdx] && data.waves[waveIdx].agents) {
        for (const agent of data.waves[waveIdx].agents) {
          process.stdout.write(JSON.stringify(agent) + '\n');
        }
      }
      break;
    }

    case 'wave-cells-each': {
      // Each agent as a compact JSON line plus its 0-based "_cell" (agents that
      // share a group share a cell). A non-object entry has no fields to carry
      // it, so it prints as {"_cell":n} to keep the line count equal to agents[].
      const waveIdx = parseInt(args[0], 10);
      const agents = data.waves && data.waves[waveIdx] && data.waves[waveIdx].agents;
      if (!Array.isArray(agents)) break;
      const cells = cellsForAgents(agents);
      agents.forEach((agent, i) => {
        const fields = agent && typeof agent === 'object' && !Array.isArray(agent) ? agent : {};
        process.stdout.write(JSON.stringify({ ...fields, _cell: cells[i] }) + '\n');
      });
      break;
    }

    case 'wave-cell-count': {
      const waveIdx = parseInt(args[0], 10);
      const agents = data.waves && data.waves[waveIdx] && data.waves[waveIdx].agents;
      const cells = cellsForAgents(agents);
      process.stdout.write(String(cells.length ? Math.max(...cells) + 1 : 0) + '\n');
      break;
    }

    case 'reap-candidates': {
      // One tab-separated line per agent that still has a surface to close:
      // id, wmuxAgentId, surfaceId, paneId ('-' stands for an empty field, so
      // `read` with a tab IFS cannot collapse it). The caller's own surface
      // goes last: killing its own PTY may end the script running this.
      const sel = args[0];
      const callerSurface = args[1] || '';
      const waves = data.waves || [];
      const indexes = sel === 'all' ? waves.map((_, i) => i) : [parseInt(sel, 10)];
      const rows = [];
      for (const wi of indexes) {
        for (const agent of (waves[wi] && waves[wi].agents) || []) {
          if (!agent.surfaceId || agent.reapedAt) continue;
          rows.push(agent);
        }
      }
      const own = a => (callerSurface && a.surfaceId === callerSurface ? 1 : 0);
      rows.sort((a, b) => own(a) - own(b));
      const cell = v => (v === undefined || v === null || v === '' ? '-' : String(v));
      for (const a of rows) {
        process.stdout.write([a.id, cell(a.wmuxAgentId), a.surfaceId, cell(a.paneId)].join('\t') + '\n');
      }
      break;
    }

    default:
      process.stderr.write(`json-tool: unknown query "${queryName}"\n`);
      process.exit(1);
  }
}

function cmdUpdateAgent(file, agentId, ...assignments) {
  const data = readJSON(file);
  const found = findAgent(data, agentId);
  if (!found) {
    process.stderr.write(`json-tool: agent "${agentId}" not found\n`);
    process.exit(1);
  }
  for (const assignment of assignments) {
    const eqIdx = assignment.indexOf('=');
    if (eqIdx === -1) {
      process.stderr.write(`json-tool: invalid assignment "${assignment}" (expected field=value)\n`);
      process.exit(1);
    }
    const field = assignment.slice(0, eqIdx);
    const rawVal = assignment.slice(eqIdx + 1);
    found.agent[field] = parseValue(rawVal);
  }
  writeJSON(file, data);
}

function cmdDashboard(file) {
  const data = readJSON(file);

  const task = data.task || 'Unknown';
  const status = data.status || 'unknown';
  const waves = data.waves || [];

  let totalAgents = 0;
  let completedAgents = 0;
  let runningAgents = 0;
  let failedAgents = 0;

  for (const wave of waves) {
    for (const agent of (wave.agents || [])) {
      totalAgents++;
      if (agent.status === 'exited') completedAgents++;
      else if (agent.status === 'running') runningAgents++;
      else if (agent.status === 'failed') failedAgents++;
    }
  }

  const lines = [];
  lines.push(`# Orchestration: ${task}`);
  lines.push(`**Status:** ${status} | **Agents:** ${completedAgents}/${totalAgents} complete | **Running:** ${runningAgents} | **Failed:** ${failedAgents}`);
  lines.push('');

  for (let i = 0; i < waves.length; i++) {
    const wave = waves[i];
    lines.push(`## Wave ${i + 1} — ${wave.status || 'unknown'}`);
    lines.push('');
    lines.push('| Agent | Status | Tools | Started | Finished |');
    lines.push('|-------|--------|-------|---------|----------|');
    for (const agent of (wave.agents || [])) {
      const label = agent.label || agent.id;
      const st = agent.status || 'pending';
      const tools = agent.toolUses != null ? agent.toolUses : 0;
      const started = agent.startedAt || '-';
      const finished = agent.finishedAt || '-';
      lines.push(`| ${label} | ${st} | ${tools} | ${started} | ${finished} |`);
    }
    lines.push('');
  }

  const reviewerStatus = (data.reviewer && data.reviewer.status) || 'pending';
  lines.push(`## Reviewer — ${reviewerStatus}`);

  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * Parse a JSON string from stdin or argument and extract a path.
 * Used to replace: echo "$json" | jq -r '.field'
 */
function cmdParseJson(jsonStr, dotPath) {
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch (e) {
    process.stderr.write(`json-tool: invalid JSON input: ${e.message}\n`);
    process.exit(1);
  }
  const val = resolvePath(data, dotPath);
  if (val === undefined || val === null) {
    process.stdout.write('\n');
  } else if (typeof val === 'object') {
    process.stdout.write(JSON.stringify(val) + '\n');
  } else {
    process.stdout.write(String(val) + '\n');
  }
}

/**
 * A finished run is one a Stop hook may reap: terminal status, written by a
 * plugin version that records coordinatorPaneId, and not reaped yet.
 * One node process scans every run dir, so the hook pays for one, not N.
 */
function cmdFindUnreapedFinished(baseDir) {
  let names;
  try {
    names = fs.readdirSync(baseDir);
  } catch {
    return;
  }
  const finished = new Set(['complete', 'aborted', 'failed']);
  for (const name of names.sort()) {
    if (!name.startsWith('wmux-orch-')) continue;
    let state;
    try {
      state = JSON.parse(fs.readFileSync(path.join(baseDir, name, 'state.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!state || !finished.has(state.status)) continue;
    if (!state.coordinatorPaneId || state.reapedAt) continue;
    process.stdout.write(baseDir.replace(/[\\/]+$/, '') + '/' + name + '\n');
  }
}

/**
 * The agent a timed-out `wmux agent spawn` may still have started: running, in
 * the pane it was spawned into, under its label. The newest one wins if there
 * are several. Accepts the CLI's `{agents:[...]}` reply or a bare array.
 */
function findSpawned(list, label, paneId) {
  const agents = Array.isArray(list) ? list : list && Array.isArray(list.agents) ? list.agents : [];
  let best = null;
  for (const a of agents) {
    if (!a || typeof a !== 'object') continue;
    if (a.status !== 'running' || a.label !== label || a.paneId !== paneId) continue;
    const t = typeof a.spawnTime === 'number' ? a.spawnTime : -Infinity;
    if (!best || t > best.t) best = { agent: a, t };
  }
  return best ? best.agent : null;
}

function cmdFindSpawned(label, paneId) {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const found = findSpawned(list, label, paneId);
  if (found) process.stdout.write(JSON.stringify(found) + '\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd) {
  process.stderr.write('Usage: node json-tool.js <command> [args...]\n');
  process.stderr.write('Commands: get, set, inc, query, update-agent, dashboard, find-unreaped-finished, parse-json, find-spawned\n');
  process.exit(1);
}

switch (cmd) {
  case 'get':
    if (args.length < 3) { process.stderr.write('Usage: node json-tool.js get <file> <path>\n'); process.exit(1); }
    cmdGet(args[1], args[2]);
    break;

  case 'set':
    if (args.length < 4) { process.stderr.write('Usage: node json-tool.js set <file> <path> <value>\n'); process.exit(1); }
    cmdSet(args[1], args[2], args[3]);
    break;

  case 'inc':
    if (args.length < 3) { process.stderr.write('Usage: node json-tool.js inc <file> <path>\n'); process.exit(1); }
    cmdInc(args[1], args[2]);
    break;

  case 'query':
    if (args.length < 3) { process.stderr.write('Usage: node json-tool.js query <file> <query-name> [args...]\n'); process.exit(1); }
    cmdQuery(args[1], args[2], ...args.slice(3));
    break;

  case 'update-agent':
    if (args.length < 4) { process.stderr.write('Usage: node json-tool.js update-agent <file> <agentId> <field=value>...\n'); process.exit(1); }
    cmdUpdateAgent(args[1], args[2], ...args.slice(3));
    break;

  case 'dashboard':
    if (args.length < 2) { process.stderr.write('Usage: node json-tool.js dashboard <file>\n'); process.exit(1); }
    cmdDashboard(args[1]);
    break;

  case 'find-unreaped-finished':
    if (args.length < 2) { process.stderr.write('Usage: node json-tool.js find-unreaped-finished <baseDir>\n'); process.exit(1); }
    cmdFindUnreapedFinished(args[1]);
    break;

  case 'parse-json':
    if (args.length < 3) { process.stderr.write('Usage: node json-tool.js parse-json <jsonString> <path>\n'); process.exit(1); }
    cmdParseJson(args[1], args[2]);
    break;

  case 'find-spawned':
    if (args.length < 3) { process.stderr.write('Usage: node json-tool.js find-spawned <label> <paneId> < agent-list.json\n'); process.exit(1); }
    cmdFindSpawned(args[1], args[2]);
    break;

  default:
    process.stderr.write(`json-tool: unknown command "${cmd}"\n`);
    process.exit(1);
}
