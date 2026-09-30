#!/usr/bin/env bash
# reap-wave.sh <orch-dir> <wave-index|all>
# Close the agents of a finished wave (or of every wave): `wmux agent kill`, then
# `wmux close-surface`. Agents run the interactive TUI and never exit on their
# own, so without this their panes and processes stay alive.
#
# Idempotent: an agent that already has `reapedAt` is skipped, so a second run
# calls no wmux command beyond `ping`. With `all` the run gets a top-level
# `reapedAt` too, which is what the Stop hook keys on.

ORCH_DIR="$1"
WAVE_SEL="$2"

if [ -z "$ORCH_DIR" ] || [ -z "$WAVE_SEL" ]; then
  echo "Usage: reap-wave.sh <orch-dir> <wave-index|all>" >&2
  exit 1
fi
case "$WAVE_SEL" in
  all) ;;
  ''|*[!0-9]*) echo "reap-wave: wave must be a number or 'all', got '$WAVE_SEL'" >&2; exit 1 ;;
  *) ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/orchestration-state.sh"

[ -f "$ORCH_DIR/state.json" ] || { echo "reap-wave: no state.json in $ORCH_DIR, nothing to do"; exit 0; }

# Unreachable wmux means no attempt was made, so nothing is marked reaped and
# the next spawn or Stop hook tries again.
if ! command -v wmux >/dev/null 2>&1 || [ "$(wmux ping 2>/dev/null </dev/null | tr -d '\r\n')" != "pong" ]; then
  echo "reap-wave: wmux not reachable, leaving $ORCH_DIR untouched" >&2
  exit 0
fi

COORD_PANE=$(read_state "$ORCH_DIR" .coordinatorPaneId)
[ "$COORD_PANE" = "null" ] && COORD_PANE=""

# </dev/null on every wmux call: inside this while-read loop a command that
# reads stdin would swallow the remaining agent lines.
while IFS=$'\t' read -r AGENT_ID WMUX_AGENT_ID SURFACE_ID PANE_ID; do
  [ -z "$AGENT_ID" ] && continue
  [ "$WMUX_AGENT_ID" = "-" ] && WMUX_AGENT_ID=""
  [ "$PANE_ID" = "-" ] && PANE_ID=""

  if [ -n "$COORD_PANE" ] && [ "$PANE_ID" = "$COORD_PANE" ]; then
    echo "reap-wave: WARNING agent $AGENT_ID sits in the coordinator's pane ($PANE_ID), not closing it" >&2
    continue
  fi

  # Exit codes are ignored: an unknown agent id is "Agent not found" and an
  # unknown surface already answers ok, both meaning "already gone".
  if [ -n "$WMUX_AGENT_ID" ]; then
    wmux agent kill "$WMUX_AGENT_ID" >/dev/null 2>&1 </dev/null
  fi
  wmux close-surface "$SURFACE_ID" >/dev/null 2>&1 </dev/null
  echo "reaped $AGENT_ID (surface $SURFACE_ID)"

  update_agent "$ORCH_DIR" "$AGENT_ID" "reapedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
done < <(node "$JSON_TOOL" query "$ORCH_DIR/state.json" reap-candidates "$WAVE_SEL" "${WMUX_SURFACE_ID:-}")

if [ "$WAVE_SEL" = "all" ]; then
  update_state "$ORCH_DIR" .reapedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
exit 0
