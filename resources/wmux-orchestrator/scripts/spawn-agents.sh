#!/usr/bin/env bash
# spawn-agents.sh <orch-dir> <wave-index>
# Splits the coordinator's own pane into [coordinator | worker grid] with
# `wmux layout agents` (one atomic split-tree mutation) and spawns one Claude
# Code agent per worker pane. Agents of earlier waves are reaped first, so
# their panes are gone before the new grid is laid out. Agents that share a
# `group` share one pane: the first is spawned over the pane's idle tab, the
# others are appended as tabs, and the first is made active at the end.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/orchestration-state.sh"

# winpath: convert MSYS/Cygwin paths to mixed Windows form (C:/...) so Windows
# binaries spawned via `wmux agent spawn --cmd` can resolve them. No-op on Linux/macOS.
winpath() {
  if command -v cygpath &>/dev/null; then
    cygpath -m "$1" 2>/dev/null || echo "$1"
  else
    echo "$1"
  fi
}

ORCH_DIR="$1"
WAVE_IDX="$2"
LAUNCHER="$(winpath "$SCRIPT_DIR/launch-agent.js")"

[ -z "$ORCH_DIR" ] || [ -z "$WAVE_IDX" ] && { echo "Usage: spawn-agents.sh <orch-dir> <wave-index>"; exit 1; }

WMUX_AVAILABLE=false
if command -v wmux &>/dev/null; then
  PING_RESULT=$(wmux ping 2>&1)
  if [ "$PING_RESULT" = "pong" ]; then
    WMUX_AVAILABLE=true
  else
    echo "WARNING: wmux found but ping failed: $PING_RESULT" >&2
  fi
else
  echo "WARNING: wmux not found in PATH" >&2
fi

if [ "$WMUX_AVAILABLE" != "true" ]; then
  echo "wmux unavailable — writing pending spawn file for degraded mode" >&2
  node "$JSON_TOOL" query "$ORCH_DIR/state.json" wave-agents "$WAVE_IDX" > "$ORCH_DIR/wave-${WAVE_IDX}-pending-spawn.json"
  exit 0
fi

CWD=$(read_state "$ORCH_DIR" '.cwd')
[ -z "$CWD" ] || [ "$CWD" = "null" ] && CWD="$(pwd)"

# One worker cell per group, one per ungrouped agent.
CELL_COUNT=$(node "$JSON_TOOL" query "$ORCH_DIR/state.json" wave-cell-count "$WAVE_IDX")
CELL_COUNT=${CELL_COUNT:-0}

if [ "$CELL_COUNT" -eq 0 ]; then
  echo "No agents in wave $WAVE_IDX — nothing to spawn"
  exit 0
fi

# Earlier waves are finished by the time this one starts. Reaping is
# idempotent, so a wave the model already reaped costs one ping.
REAP_IDX=0
while [ "$REAP_IDX" -lt "$WAVE_IDX" ]; do
  bash "$SCRIPT_DIR/reap-wave.sh" "$ORCH_DIR" "$REAP_IDX" </dev/null
  REAP_IDX=$((REAP_IDX + 1))
done

# Only "this wmux has no layout agents" may fall back to `layout grid`. Any
# other failure (an unresolvable anchor above all) must stop the spawn: a grid
# built around the wrong anchor would fold unrelated panes into the coordinator.
layout_agents_unsupported() {
  printf '%s' "$1" | grep -Eq 'Unknown layout (sub)?command: agents|(Method not found|Unknown method)[: ]+layout\.agents|-32601.*layout\.agents'
}

# --count is worker CELLS. The anchor is $WMUX_SURFACE_ID, which the CLI picks
# up itself; a pane id is deliberately not passed, since a stale one is a miss,
# not a fallback.
echo "Laying out $CELL_COUNT worker cell(s) beside the coordinator"

ANCHOR_PANE=""
LAYOUT_RESULT=$(wmux layout agents --count "$CELL_COUNT" --type terminal 2>&1)
FIRST_PANE=$(parse_json "$LAYOUT_RESULT" '.newPaneIds[0]')
if [ -n "$FIRST_PANE" ] && [ "$FIRST_PANE" != "null" ]; then
  ANCHOR_PANE=$(parse_json "$LAYOUT_RESULT" '.anchorPaneId')
elif layout_agents_unsupported "$LAYOUT_RESULT"; then
  echo "WARNING: wmux has no 'layout agents'; falling back to 'layout grid'" >&2
  # 1 cell for the coordinator + 1 per worker cell. The fallback does not learn the
  # coordinator's pane, so it leaves coordinatorPaneId unset.
  GRID_COUNT=$((CELL_COUNT + 1))
  LAYOUT_RESULT=$(wmux layout grid --count "$GRID_COUNT" --type terminal 2>&1)
  FIRST_PANE=$(parse_json "$LAYOUT_RESULT" '.newPaneIds[0]')
  if [ -z "$FIRST_PANE" ] || [ "$FIRST_PANE" = "null" ]; then
    echo "ERROR: wmux layout grid failed: $LAYOUT_RESULT" >&2
    exit 1
  fi
else
  echo "ERROR: wmux layout agents failed: $LAYOUT_RESULT" >&2
  exit 1
fi

if [ -n "$ANCHOR_PANE" ] && [ "$ANCHOR_PANE" != "null" ]; then
  CURRENT_COORD=$(read_state "$ORCH_DIR" '.coordinatorPaneId')
  if [ -z "$CURRENT_COORD" ] || [ "$CURRENT_COORD" = "null" ]; then
    update_state "$ORCH_DIR" .coordinatorPaneId "$ANCHOR_PANE"
  fi
fi

spawn_timed_out() {
  printf '%s' "$1" | grep -Eq 'timed out after .* may still have completed'
}

# Spawn each agent into its cell's pane. Process substitution keeps the counters
# in the parent shell (unlike `node ... | while`). The per-cell arrays are
# indexed, not associative: macOS ships bash 3.2.
CELL_MEMBERS=()
CELL_FIRST=()
while IFS= read -r agent; do
  [ -z "$agent" ] && continue
  AGENT_ID=$(parse_json "$agent" '.id')
  AGENT_LABEL=$(parse_json "$agent" '.label')
  PROMPT_FILE="$(winpath "$ORCH_DIR/agent-${AGENT_ID}-prompt.md")"

  CELL=$(parse_json "$agent" '._cell')
  PANE_ID=$(parse_json "$LAYOUT_RESULT" ".newPaneIds[$CELL]")
  if [ -z "$PANE_ID" ] || [ "$PANE_ID" = "null" ]; then
    echo "ERROR: No pane at index $CELL for agent $AGENT_ID. Layout result: $LAYOUT_RESULT" >&2
    continue
  fi

  # Until one member of the cell has spawned, take over the pane's idle default
  # tab; after that, append.
  REPLACE_TAB="--replace-tab"
  [ "${CELL_MEMBERS[$CELL]:-0}" -gt 0 ] && REPLACE_TAB=""

  # launch-agent.js uses execFileSync with '--' separator to pass the prompt
  # as a positional arg — full interactive TUI, user can watch and intervene.
  SPAWN_RESULT=$(wmux agent spawn \
    --cmd "node \"$LAUNCHER\" \"$PROMPT_FILE\"" \
    --label "$AGENT_LABEL" \
    --cwd "$CWD" \
    --pane "$PANE_ID" \
    $REPLACE_TAB 2>&1)

  SPAWNED_AGENT_ID=$(parse_json "$SPAWN_RESULT" '.agentId')
  SPAWNED_SURFACE_ID=$(parse_json "$SPAWN_RESULT" '.surfaceId')

  # The CLI gives up after a few seconds while wmux may still finish the spawn
  # (seen with several Claude sessions starting at once). Unrecorded, that agent
  # could never be reaped, so look for it once before calling it a failure.
  if { [ -z "$SPAWNED_AGENT_ID" ] || [ "$SPAWNED_AGENT_ID" = "null" ]; } && spawn_timed_out "$SPAWN_RESULT"; then
    LATE_AGENT=$(wmux agent list 2>/dev/null | node "$JSON_TOOL" find-spawned "$AGENT_LABEL" "$PANE_ID")
    if [ -n "$LATE_AGENT" ]; then
      SPAWNED_AGENT_ID=$(parse_json "$LATE_AGENT" '.agentId')
      SPAWNED_SURFACE_ID=$(parse_json "$LATE_AGENT" '.surfaceId')
      echo "WARNING: spawn of $AGENT_ID timed out, but wmux started it as $SPAWNED_AGENT_ID; recording that one" >&2
    fi
  fi

  if [ -z "$SPAWNED_AGENT_ID" ] || [ "$SPAWNED_AGENT_ID" = "null" ]; then
    echo "ERROR: Failed to spawn agent $AGENT_ID in pane $PANE_ID. Result: $SPAWN_RESULT" >&2
    continue
  fi

  echo "Spawned $AGENT_ID ($AGENT_LABEL) in pane $PANE_ID"

  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  update_agent "$ORCH_DIR" "$AGENT_ID" \
    "wmuxAgentId=$SPAWNED_AGENT_ID" \
    "paneId=$PANE_ID" \
    "surfaceId=$SPAWNED_SURFACE_ID" \
    "status=running" \
    "startedAt=$NOW"

  [ "${CELL_MEMBERS[$CELL]:-0}" -eq 0 ] && CELL_FIRST[$CELL]="$SPAWNED_SURFACE_ID"
  CELL_MEMBERS[$CELL]=$(( ${CELL_MEMBERS[$CELL]:-0} + 1 ))
done < <(node "$JSON_TOOL" query "$ORCH_DIR/state.json" wave-cells-each "$WAVE_IDX")

# Each appended spawn made itself the active tab, so focus once, after all of
# them. selectSurface only changes the pane's active tab; it does not move
# keyboard focus off the coordinator.
CELL=0
while [ "$CELL" -lt "$CELL_COUNT" ]; do
  FIRST_SURFACE="${CELL_FIRST[$CELL]:-}"
  if [ "${CELL_MEMBERS[$CELL]:-0}" -ge 2 ]; then
    if [ -z "$FIRST_SURFACE" ] || [ "$FIRST_SURFACE" = "null" ]; then
      echo "WARNING: the first agent spawned in cell $CELL reported no surfaceId; not focusing that cell" >&2
    else
      FOCUS_RESULT=$(wmux focus-surface "$FIRST_SURFACE" 2>&1) \
        || echo "WARNING: could not focus $FIRST_SURFACE: $FOCUS_RESULT" >&2
    fi
  fi
  CELL=$((CELL + 1))
done
