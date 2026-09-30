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
//   node json-tool.js find-unreaped-finished <baseDir> [callerSurfaceId]
//   node json-tool.js pane-of-surface <surfaceId>     (`wmux list-panes` JSON on stdin)
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

const out = text => process.stdout.write(text + '\n');

/** Every agent of every wave, in order. Tolerates a state with no waves. */
function allAgents(data) {
  return (data.waves || []).flatMap(wave => wave.agents || []);
}

/** The wave at argv index `raw`, or undefined. */
function waveAt(data, raw) {
  return data.waves ? data.waves[parseInt(raw, 10)] : undefined;
}

/** That wave's agents[], or undefined when the wave or the list is missing. */
function agentsAt(data, raw) {
  const wave = waveAt(data, raw);
  return wave ? wave.agents : undefined;
}

// One function per query, so adding one does not grow a single switch. Each
// prints exactly what its `case` used to.
const QUERIES = {
  'agents-by-status': (data, args) => {
    for (const agent of allAgents(data)) {
      if (agent.status === args[0]) out(agent.id);
    }
  },

  'wave-of-agent': (data, args) => {
    const found = findAgent(data, args[0]);
    if (found) out(String(found.waveIndex));
  },

  'count-agents-by-status': (data, args) => {
    out(String(allAgents(data).filter(agent => agent.status === args[0]).length));
  },

  'wave-complete': (data, args) => {
    const wave = waveAt(data, args[0]);
    if (!wave) { out('true'); return; }
    const allDone = (wave.agents || []).every(a => a.status === 'exited' || a.status === 'failed');
    out(allDone ? 'true' : 'false');
  },

  // Prints nothing if no pending wave is found.
  'next-pending-wave': (data) => {
    const i = (data.waves || []).findIndex(wave => wave.status === 'pending');
    if (i !== -1) out(String(i));
  },

  'all-waves-done': (data) => {
    const waves = data.waves || [];
    const done = waves.every(w => w.status !== 'pending' && w.status !== 'running');
    out(done ? 'true' : 'false');
  },

  'wave-agents': (data, args) => {
    const wave = waveAt(data, args[0]);
    out(wave ? JSON.stringify(wave.agents || []) : '[]');
  },

  'wave-count': (data) => {
    out(String((data.waves || []).length));
  },

  'wave-agent-ids': (data, args) => {
    for (const agent of agentsAt(data, args[0]) || []) out(agent.id);
  },

  'agent-label': (data, args) => {
    const found = findAgent(data, args[0]);
    if (found) out(String(found.agent.label || ''));
  },

  'wave-status': (data, args) => {
    const wave = waveAt(data, args[0]);
    if (wave) out(String(wave.status || 'unknown'));
  },

  // Each agent as a compact JSON line (for while-read loops).
  'wave-agents-each': (data, args) => {
    for (const agent of agentsAt(data, args[0]) || []) out(JSON.stringify(agent));
  },

  // Each agent as a compact JSON line plus its 0-based "_cell" (agents that
  // share a group share a cell). A non-object entry has no fields to carry
  // it, so it prints as {"_cell":n} to keep the line count equal to agents[].
  'wave-cells-each': (data, args) => {
    const agents = agentsAt(data, args[0]);
    if (!Array.isArray(agents)) return;
    const cells = cellsForAgents(agents);
    agents.forEach((agent, i) => {
      const fields = agent && typeof agent === 'object' && !Array.isArray(agent) ? agent : {};
      out(JSON.stringify({ ...fields, _cell: cells[i] }));
    });
  },

  'wave-cell-count': (data, args) => {
    const cells = cellsForAgents(agentsAt(data, args[0]));
    out(String(cells.length ? Math.max(...cells) + 1 : 0));
  },

  // One tab-separated line per agent that still has a surface to close:
  // id, wmuxAgentId, surfaceId, paneId ('-' stands for an empty field, so
  // `read` with a tab IFS cannot collapse it).
  'reap-candidates': (data, args) => {
    const cell = v => (v === undefined || v === null || v === '' ? '-' : String(v));
    for (const a of reapCandidates(data, args[0], args[1] || '')) {
      out([a.id, cell(a.wmuxAgentId), a.surfaceId, cell(a.paneId)].join('\t'));
    }
  },
};

function cmdQuery(file, queryName, ...args) {
  const data = readJSON(file);
  const run = Object.hasOwn(QUERIES, queryName) ? QUERIES[queryName] : null;
  if (!run) {
    process.stderr.write(`json-tool: unknown query "${queryName}"\n`);
    process.exit(1);
  }
  run(data, args);
}

/**
 * Why a surface must never be closed by a reap, or '' when it may be.
 *
 * The caller's own surface is SKIPPED, not closed last: `close-surface` on it
 * ends the shell running the reap, and with it whoever asked (a coordinator
 * whose own surface ended up in agents[], a worker running cleanup). The
 * recorded coordinator surface is protected the same way whoever the caller
 * is — that is the only protection a run laid out by the `layout grid`
 * fallback has, since it never learns a coordinatorPaneId.
 */
function protectedSurfaceReason(data, surfaceId, callerSurface) {
  if (callerSurface && surfaceId === callerSurface) return "the caller's own surface";
  if (data.coordinatorSurfaceId && surfaceId === data.coordinatorSurfaceId) return "the coordinator's surface";
  return '';
}

/** Agents of the selected wave(s) that still have a closable surface. */
function reapCandidates(data, sel, callerSurface) {
  const waves = data.waves || [];
  const indexes = sel === 'all' ? waves.map((_, i) => i) : [parseInt(sel, 10)];
  const rows = [];
  for (const wi of indexes) {
    for (const agent of (waves[wi] && waves[wi].agents) || []) {
      if (!agent.surfaceId || agent.reapedAt) continue;
      const why = protectedSurfaceReason(data, agent.surfaceId, callerSurface);
      if (why) {
        process.stderr.write(`reap-wave: WARNING agent ${agent.id} is on ${why} (${agent.surfaceId}), not closing it\n`);
        continue;
      }
      rows.push(agent);
    }
  }
  return rows;
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

/** `dir` without any trailing `/` or `\`. */
function trimTrailingSeparators(dir) {
  let end = dir.length;
  while (end > 0 && (dir[end - 1] === '/' || dir[end - 1] === '\\')) end--;
  return dir.slice(0, end);
}

/** The CLI's `{agents:[...]}` reply or a bare array, as an array. */
function agentListOf(list) {
  if (Array.isArray(list)) return list;
  return list && Array.isArray(list.agents) ? list.agents : [];
}

/**
 * How the Stop hook in `callerSurface` may prove a run is its own, or null
 * when it must leave the run alone:
 *   '-'        the run's recorded coordinator surface IS the caller;
 *   <paneId>   only a coordinator pane was recorded, so the hook still has to
 *              check that the caller sits in that pane (one `wmux list-panes`).
 *
 * Only `complete` runs qualify. A `failed` or `aborted` run keeps its panes:
 * they are what the user inspects to find out what went wrong, and only an
 * explicit cleanup.sh removes them. A run with no recorded coordinator is
 * nobody's to reap from a hook, and neither is any run when the hook has no
 * surface of its own to compare (it is not running inside wmux).
 */
function stopHookClaim(state, callerSurface) {
  if (!state || state.status !== 'complete' || state.reapedAt || !callerSurface) return null;
  if (state.coordinatorSurfaceId) return state.coordinatorSurfaceId === callerSurface ? '-' : null;
  return typeof state.coordinatorPaneId === 'string' && state.coordinatorPaneId ? state.coordinatorPaneId : null;
}

/**
 * Runs the Stop hook in `callerSurface` may reap, one `<claim>\t<dir>` line
 * each (see stopHookClaim). The hook fires in every Claude Code session on the
 * machine — another coordinator's, in another workspace or window, and every
 * worker's — so "finished" alone is not enough: the run has to be the caller's.
 * One node process scans every run dir, so the hook pays for one, not N.
 */
function cmdFindUnreapedFinished(baseDir, callerSurface) {  let names;
  try {
    names = fs.readdirSync(baseDir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (!name.startsWith('wmux-orch-')) continue;
    let state;
    try {
      state = JSON.parse(fs.readFileSync(path.join(baseDir, name, 'state.json'), 'utf8'));
    } catch {
      continue;
    }
    const claim = stopHookClaim(state, callerSurface || '');
    if (!claim) continue;
    out(claim + '\t' + trimTrailingSeparators(baseDir) + '/' + name);
  }
}

/**
 * The pane holding `surfaceId`, out of `wmux list-panes` JSON on stdin
 * (`{panes:[{paneId, surfaces:[{id}]}]}`). Prints nothing when it is not there.
 */
function cmdPaneOfSurface(surfaceId) {
  let reply;
  try {
    reply = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const panes = reply && Array.isArray(reply.panes) ? reply.panes : [];
  const pane = panes.find(p => p && Array.isArray(p.surfaces) && p.surfaces.some(s => s && s.id === surfaceId));
  if (pane && pane.paneId) process.stdout.write(String(pane.paneId) + '\n');
}

/**
 * The agent a timed-out `wmux agent spawn` may still have started: running, in
 * the pane it was spawned into, under its label. The newest one wins if there
 * are several. Accepts the CLI's `{agents:[...]}` reply or a bare array.
 */
function findSpawned(list, label, paneId) {
  const agents = agentListOf(list);
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
  process.stderr.write('Commands: get, set, inc, query, update-agent, dashboard, find-unreaped-finished, pane-of-surface, parse-json, find-spawned\n');
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
    if (args.length < 2) { process.stderr.write('Usage: node json-tool.js find-unreaped-finished <baseDir> [callerSurfaceId]\n'); process.exit(1); }
    cmdFindUnreapedFinished(args[1], args[2]);
    break;

  case 'pane-of-surface':
    if (args.length < 2) { process.stderr.write('Usage: node json-tool.js pane-of-surface <surfaceId> < list-panes.json\n'); process.exit(1); }
    cmdPaneOfSurface(args[1]);
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
