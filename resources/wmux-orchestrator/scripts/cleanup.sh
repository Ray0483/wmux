#!/usr/bin/env bash
# cleanup.sh <orch-dir>
# Reap the run's agents, then remove the orchestration temp directory.

ORCH_DIR="$1"
[ -z "$ORCH_DIR" ] && { echo "Usage: cleanup.sh <orch-dir>"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The directory holds the only record of which surfaces to close, so reap first.
[ -f "$ORCH_DIR/state.json" ] && bash "$SCRIPT_DIR/reap-wave.sh" "$ORCH_DIR" all </dev/null

[ -d "$ORCH_DIR" ] && rm -rf "$ORCH_DIR"
echo "Cleaned up $ORCH_DIR"
