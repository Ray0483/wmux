#!/usr/bin/env bash
# reap-wave.sh <orch-dir> <wave-index|all>
# Close the agents of a finished wave (or of every wave): `wmux agent kill`, then
# `wmux close-surface`. Agents run the interactive TUI and never exit on their
# own, so without this their panes and processes stay alive.
#
# Idempotent: an agent that already has `reapedAt` is skipped, so a second run
# calls no wmux command beyond `ping`. `reapedAt` means "its surface is closed":
# an agent whose close FAILED is not stamped and is tried again next time. With
# `all` the run gets a top-level `reapedAt` too, once nothing is left to retry,
# which is what the Stop hook keys on.
#
# Never closed, whoever runs this: the caller's own surface ($WMUX_SURFACE_ID),
# the run's recorded coordinator surface, and anything in the coordinator's pane.

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

LEFT_OPEN=0

# `reap-candidates` already leaves out the caller's own surface and the run's
# recorded coordinator surface (it says so on stderr): neither is ever closed.
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

  # The kill's exit code is ignored: an unknown agent id is "Agent not found",
  # which means "already gone".
  if [ -n "$WMUX_AGENT_ID" ]; then
    wmux agent kill "$WMUX_AGENT_ID" >/dev/null 2>&1 </dev/null
  fi

  # The close's is NOT. `close-surface` answers ok for a surface that is already
  # gone, so a failure is a real one (pipe error, timeout, no window) and the
  # pane may still be there. Stamping reapedAt anyway would make every later
  # run skip it, and the leaked pane would never be retried.
  if wmux close-surface "$SURFACE_ID" >/dev/null 2>&1 </dev/null; then
    echo "reaped $AGENT_ID (surface $SURFACE_ID)"
    update_agent "$ORCH_DIR" "$AGENT_ID" "reapedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    echo "reap-wave: WARNING could not close surface $SURFACE_ID of agent $AGENT_ID, leaving it for the next reap" >&2
    LEFT_OPEN=$((LEFT_OPEN + 1))
  fi
done < <(node "$JSON_TOOL" query "$ORCH_DIR/state.json" reap-candidates "$WAVE_SEL" "${WMUX_SURFACE_ID:-}")

# The run-level stamp is what the Stop hook keys on, so it only goes on once
# nothing is left to retry. Agents skipped as protected (the coordinator's pane
# or surface, the caller's own surface) do not hold it back: no later run of
# this script would close them either.
if [ "$WAVE_SEL" = "all" ] && [ "$LEFT_OPEN" -eq 0 ]; then
  update_state "$ORCH_DIR" .reapedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
exit 0
