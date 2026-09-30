#!/usr/bin/env bash
# Stop hook: warn if orchestration is active before Claude Code exits, and reap
# the agents of a run that has completed (the last wave is never followed by a
# "spawn next wave", so nothing else closes it if the model skips the reap step).
#
# This hook fires in EVERY Claude Code session that has the plugin: the
# coordinator's, another coordinator's in another workspace or window, and each
# worker's. So it reaps only what is provably its own:
#   - the run's recorded coordinator is THIS pane ($WMUX_SURFACE_ID, or the pane
#     holding it for a run that only recorded coordinatorPaneId). A run with no
#     recorded coordinator is never reaped from here, and neither is anything
#     when this session is not inside wmux;
#   - the run is `complete`. A `failed` or `aborted` run keeps its panes for
#     inspection until someone runs cleanup.sh.

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

# The caller's pane costs a wmux round trip, so it is looked up at most once and
# only when a run needs it (one that recorded a coordinator pane but no surface).
CALLER_PANE=""
CALLER_PANE_KNOWN=false

# </dev/null: the loop is fed by the scan, and nothing inside may read it.
while IFS=$'\t' read -r CLAIM FINISHED_DIR; do
  FINISHED_DIR="${FINISHED_DIR%$'\r'}"
  [ -z "$FINISHED_DIR" ] && continue
  if [ "$CLAIM" != "-" ]; then
    if [ "$CALLER_PANE_KNOWN" != "true" ]; then
      CALLER_PANE=$(caller_pane_id </dev/null)
      CALLER_PANE_KNOWN=true
    fi
    # Empty means "could not tell" (wmux down, surface not found): not ours.
    if [ -z "$CALLER_PANE" ] || [ "$CALLER_PANE" != "$CLAIM" ]; then
      continue
    fi
  fi
  bash "$SCRIPT_DIR/reap-wave.sh" "$FINISHED_DIR" all >/dev/null 2>&1 </dev/null
done < <(find_unreaped_finished_orchs)

exit 0
