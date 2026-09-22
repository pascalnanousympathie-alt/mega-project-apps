#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RT="$ROOT/runtime"
LOG="$RT/watchdog.log"
PIDFILE="$RT/watchdog.pid"
LOCKFILE="$RT/watchdog.lockfile"
WORKER_SESSION="acep-worker"
INTERVAL="${ACEP_WATCHDOG_INTERVAL:-30}"
ORPHAN_GRACE="${ACEP_ORPHAN_GRACE:-1200}"
STALE_PROGRESS=180
mkdir -p "$RT"

log() {
  printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"
}

worker_pid() {
  pid="$(state_field worker_pid)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null &&
     tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'supervisor/worker.py'; then
    printf '%s\n' "$pid"
  fi
}

executor_pid() {
  pid="$(state_field executor_pid)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null &&
     tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'agents/executor.py'; then
    printf '%s\n' "$pid"
  fi
}

state_status() {
  python3 - "$RT/worker-state.json" <<'PY'
import json,sys
try:
    with open(sys.argv[1]) as f: d=json.load(f)
    print(d.get("status","UNKNOWN"))
except Exception:
    print("UNKNOWN")
PY
}

state_phase() {
  python3 - "$RT/worker-state.json" <<'PY'
import json,sys
try:
    with open(sys.argv[1]) as f: d=json.load(f)
    print(d.get("phase","P00"))
except Exception:
    print("P00")
PY
}

state_field() {
  python3 - "$RT/worker-state.json" "$1" <<'PY2'
import json,sys
try:
    with open(sys.argv[1]) as f: d=json.load(f)
    v=d.get(sys.argv[2],"")
    print(v if v is not None else "")
except Exception: print("")
PY2
}
age_since() {
  python3 - "$1" <<'PY2'
from datetime import datetime,timezone
import sys
try:
    t=datetime.fromisoformat(sys.argv[1].replace("Z","+00:00"))
    print(max(0,int((datetime.now(timezone.utc)-t).total_seconds())))
except Exception: print(999999)
PY2
}

agent_progress_age() {
  python3 - "$RT/agent-progress-$1.json" "$2" <<'PY3'
import json,sys,time,os
try:
    with open(sys.argv[1],encoding="utf-8") as f: d=json.load(f)
    expected_attempt=sys.argv[2]
    if d.get("phase") != os.path.basename(sys.argv[1]).replace("agent-progress-","").replace(".json","") or d.get("attempt_id") != expected_attempt:
        print(999999)
    else:
        print(max(0,int(time.time()-float(d.get("updated",0)))))
except Exception:
    print(999999)
PY3
}
agent_progress_event() {
  python3 - "$RT/agent-progress-$1.json" "$2" <<'PY4'
import json,sys,os
try:
    with open(sys.argv[1],encoding="utf-8") as f: d=json.load(f)
    expected_attempt=sys.argv[2]
    if d.get("phase") != os.path.basename(sys.argv[1]).replace("agent-progress-","").replace(".json","") or d.get("attempt_id") != expected_attempt:
        print("UNKNOWN")
    else:
        print(d.get("event","UNKNOWN"))
except Exception:
    print("UNKNOWN")
PY4
}

worker_session_matches() {
  if ! tmux has-session -t "$WORKER_SESSION" 2>/dev/null; then
    return 1
  fi
  panes="$(tmux list-panes -t "$WORKER_SESSION" -F '#{pane_pid}' 2>/dev/null || true)"
  for pane in $panes; do
    if [ -n "$pane" ] &&
       kill -0 "$pane" 2>/dev/null &&
       tr '\000' ' ' < "/proc/$pane/cmdline" 2>/dev/null | grep -q 'supervisor/worker.py'; then
      return 0
    fi
  done
  return 1
}

start_worker_session() {
  if tmux has-session -t "$WORKER_SESSION" 2>/dev/null; then
    if worker_session_matches; then
      log "WORKER_SESSION_EXISTS_VALID session=$WORKER_SESSION"
      return 1
    fi
    log "WORKER_SESSION_STALE_CLEANUP session=$WORKER_SESSION"
    tmux kill-session -t "$WORKER_SESSION" 2>/dev/null || true
    sleep 1
  fi
  if tmux new-session -d -s "$WORKER_SESSION" "cd '$ROOT' && exec python3 supervisor/worker.py"; then
    log "WORKER_RESTARTED session=$WORKER_SESSION"
    return 0
  fi
  log "WORKER_RESTART_FAILED session=$WORKER_SESSION"
  return 1
}

legacy_watchdog_running() {
  old_pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -z "$old_pid" ] || [ "$old_pid" = "$$" ]; then return 1; fi
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null &&
     tr '\000' ' ' < "/proc/$old_pid/cmdline" 2>/dev/null | grep -q 'acep-watchdog.sh'; then
    printf '%s\n' "$old_pid"
    return 0
  fi
  return 1
}

acquire_wake_lock() {
  if [ -x /system/bin/am ]; then
    if /system/bin/am startservice --user 0 \
      -a com.termux.service_wake_lock \
      com.termux/com.termux.app.TermuxService >/dev/null 2>&1; then
      log "WAKE_LOCK_REQUESTED"
    else
      log "WAKE_LOCK_REQUEST_FAILED"
    fi
  else
    log "SYSTEM_AM_ABSENT"
  fi
}

exec 9>"$LOCKFILE"
if ! flock -n 9; then
  log "WATCHDOG_ALREADY_RUNNING"
  exit 0
fi
printf '%s\n' "$$" > "$PIDFILE"
cleanup() {
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [ "$pid" = "$$" ] && rm -f "$PIDFILE"
}
trap cleanup EXIT INT TERM
acquire_wake_lock
log "WATCHDOG_STARTED interval=$INTERVAL phase=$(state_phase)"

while true; do
  status="$(state_status)"
  phase="$(state_phase)"
  wpid="$(worker_pid)"
  epid="$(executor_pid)"
  attempt_id="$(state_field attempt_id)"

  heartbeat="$(state_field heartbeat_at)"
  progress="$(state_field last_progress_at)"
  h_age="$(age_since "$heartbeat")"
  p_age="$(age_since "$progress")"
  a_age="$(agent_progress_age "$phase" "$attempt_id")"
  a_event="$(agent_progress_event "$phase" "$attempt_id")"
  active_stale="$STALE_PROGRESS"
  if [ "$a_event" = "TOOL_CALL" ]; then active_stale=420; fi
  if [ "$a_event" = "MODEL_CALL" ] || [ "$a_event" = "MODEL_FALLBACK" ]; then active_stale=90; fi
  if [ -n "$wpid" ] && [ "$h_age" -le "$STALE_PROGRESS" ] && { [ "$p_age" -le "$active_stale" ] || [ "$a_age" -le "$active_stale" ]; }; then
    rm -f "$RT/worker-death-since" "$RT/stall-since"
    log "HEALTHY phase=$phase worker_pid=$wpid heartbeat_age=${h_age}s worker_progress_age=${p_age}s agent_progress_age=${a_age}s"
  elif [ -n "$wpid" ] && [ "$h_age" -le "$STALE_PROGRESS" ] && [ "$p_age" -gt "$active_stale" ] && [ "$a_age" -gt "$active_stale" ]; then
    if [ ! -f "$RT/stall-since" ]; then date +%s > "$RT/stall-since"; log "STALLED phase=$phase worker_pid=$wpid progress_age=$p_age""s"; fi
    stall_since="$(cat "$RT/stall-since" 2>/dev/null || echo 0)"; stall_age=$(( $(date +%s)-stall_since ))
    if [ "$stall_age" -ge "$ORPHAN_GRACE" ]; then
      log "STALLED_RECOVERY phase=$phase worker_pid=$wpid executor_pid=$epid"
      [ -n "$epid" ] && kill "$epid" 2>/dev/null || true
      kill "$wpid" 2>/dev/null || true
      rm -f "$RT/stall-since"
    else
      log "STALLED_GRACE phase=$phase worker_pid=$wpid age=$stall_age""s progress_age=$p_age""s"
    fi
  elif [ "$status" = "BLOCKED" ]; then
    log "WORKER_BLOCKED_NO_RESTART phase=$phase"
    rm -f "$PIDFILE"
    exit 0
  elif [ "$status" = "WAITING_FOR_GEMINI" ]; then
    log "WORKER_WAITING_FOR_GEMINI_NO_RESTART phase=$phase"
    rm -f "$PIDFILE"
    exit 0
  elif [ "$status" = "COMPLETE" ] || { [ "$phase" = "P30" ] && [ "$status" = "PASS" ]; }; then
    log "WORKER_NOT_RESTARTED phase=$phase status=$status"
    rm -f "$PIDFILE"
    exit 0
  elif [ -n "$epid" ]; then
    if [ ! -f "$RT/worker-death-since" ]; then
      date +%s > "$RT/worker-death-since"
      log "WORKER_DEAD_EXECUTOR_ALIVE phase=$phase executor_pid=$epid"
    else
      dead_since="$(cat "$RT/worker-death-since" 2>/dev/null || echo 0)"
      now_epoch="$(date +%s)"
      age=$((now_epoch - dead_since))
      if [ "$age" -ge "$ORPHAN_GRACE" ]; then
        log "ORPHAN_EXECUTOR_GRACE_EXPIRED phase=$phase executor_pid=$epid"
        kill "$epid" 2>/dev/null || true
        rm -f "$RT/worker-death-since"
      else
        log "RECOVERY_WAIT phase=$phase executor_pid=$epid age=${age}s"
      fi
    fi
  else
    rm -f "$RT/worker-death-since"
    log "WORKER_DEAD_RECOVERING phase=$phase status=$status"
    start_worker_session || true
  fi

  sleep "$INTERVAL"
done
