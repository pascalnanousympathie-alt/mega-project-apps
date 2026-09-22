#!/bin/bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p runtime
PIDFILE="runtime/supervisor.pid"
LOCKFILE="runtime/supervisor.lockfile"
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "SUPERVISOR_ALREADY_RUNNING"
  exit 0
fi
nohup python3 supervisor/daemon.py > runtime/supervisor.stdout 2>&1 &
pid=$!
sleep 1
if kill -0 "$pid" 2>/dev/null &&
   tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'supervisor/daemon.py'; then
  printf '%s\n' "$pid" > "$PIDFILE"
  echo "SUPERVISOR_STARTED PID=$pid"
else
  rm -f "$PIDFILE"
  echo "SUPERVISOR_START_FAILED_PID_IDENTITY"
  exit 1
fi
