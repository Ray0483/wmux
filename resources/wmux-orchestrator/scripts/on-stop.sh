#!/usr/bin/env bash
# Stop hook: warn if orchestration is active before Claude Code exits, and reap
# the agents of any run that has finished (the last wave is never followed by a
# "spawn next wave", so nothing else closes it if the model skips the reap step).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/orchestration-state.sh"

ORCH_DIR=$(find_active_orch)
if [ -n "$ORCH_DIR" ]; then
  RUNNING=$(node "$JSON_TOOL" query "$ORCH_DIR/state.json" count-agents-by-status running 2>/dev/null)

  if [ "$RUNNING" -gt 0 ] 2>/dev/null; then
    echo "WARNING: wmux orchestration in progress with $RUNNING active agent(s)."
    echo "Exiting now will leave agents running unmonitored."
  fi
fi

# </dev/null: the loop is fed by the scan, and nothing inside may read it.
while IFS= read -r FINISHED_DIR; do
  FINISHED_DIR="${FINISHED_DIR%$'\r'}"
  [ -z "$FINISHED_DIR" ] && continue
  bash "$SCRIPT_DIR/reap-wave.sh" "$FINISHED_DIR" all >/dev/null 2>&1 </dev/null
done < <(find_unreaped_finished_orchs)

exit 0
