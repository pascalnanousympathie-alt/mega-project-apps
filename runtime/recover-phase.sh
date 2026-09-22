#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RT="$ROOT/runtime"
PHASE="${1:-}"
REASON="${2:-manual-safe-recovery}"
if [[ ! "$PHASE" =~ ^P(0[4-9]|1[0-9]|2[0-7])$ ]]; then
  echo "RECOVERY_BLOCKED invalid-phase=$PHASE"
  exit 2
fi
if [ ! -f "$RT/worker-state.json" ]; then
  echo "RECOVERY_BLOCKED missing-worker-state"
  exit 3
fi
cd "$ROOT"
exec 8>"$RT/recovery.lockfile"
if ! flock -n 8; then
  echo "RECOVERY_BLOCKED recovery-already-running"
  exit 4
fi
python3 - "$ROOT" "$PHASE" "$REASON" <<'PY'
import json, os, sys, time, shutil
from pathlib import Path
root=Path(sys.argv[1]); phase=sys.argv[2]; reason=sys.argv[3]
rt=root/"runtime"; state_path=rt/"worker-state.json"
def read(path, default=None):
    if not path.exists(): return {} if default is None else default
    with path.open(encoding="utf-8") as f: return json.load(f)
state=read(state_path)
if state.get("phase") != phase or state.get("status") != "BLOCKED":
    raise SystemExit(f"RECOVERY_BLOCKED state={state.get('phase')}/{state.get('status')}")
complete=rt/f"phase-{phase}-complete.json"
if complete.exists():
    raise SystemExit("RECOVERY_BLOCKED phase-already-complete")
wpid=state.get("worker_pid"); epid=state.get("executor_pid")
def alive(pid, needle):
    if not pid: return False
    try:
        os.kill(int(pid),0)
        raw=Path(f"/proc/{int(pid)}/cmdline").read_bytes().replace(b"\0",b" ").decode(errors="replace")
        return needle in raw
    except Exception:
        return False
if alive(wpid,"supervisor/worker.py") or alive(epid,"agents/executor.py"):
    raise SystemExit("RECOVERY_BLOCKED live-worker-or-executor")
if shutil.which("tmux"):
    probe=os.system("tmux has-session -t acep-worker >/dev/null 2>&1")
    if probe == 0:
        raise SystemExit("RECOVERY_BLOCKED worker-session-exists")
import subprocess
proc_lines=subprocess.check_output(["ps","-eo","pid,args"],text=True).splitlines()
procs=[]
for line in proc_lines:
    parts=line.strip().split(None,1)
    if not parts: continue
    try: pid=int(parts[0])
    except ValueError: continue
    if pid==os.getpid(): continue
    cmdline=parts[1] if len(parts)>1 else ""
    if "supervisor/worker.py" in cmdline or "agents/executor.py" in cmdline:
        procs.append(line.strip())
if procs:
    raise SystemExit("RECOVERY_BLOCKED acep-worker-process-exists")
day=time.strftime("%Y%m%d")
hist=rt/"history"/f"{phase}-{day}"; hist.mkdir(parents=True,exist_ok=True)
for name in (f"phase-{phase}-attempt.json",f"phase-{phase}-blocked.json",f"phase-{phase}-lease.json"):
    src=rt/name
    if src.exists():
        dst=hist/name
        tmp=dst.with_suffix(dst.suffix+".tmp")
        tmp.write_bytes(src.read_bytes())
        tmp.replace(dst)
        src.unlink()
state.update({
    "phase":phase,
    "status":"WAITING",
    "worker_pid":None,
    "executor_pid":None,
    "lease_owner":None,
    "lease_generation":None,
    "failure_reason":None,
    "recovery_reason":reason,
    "recovery_requested_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
    "recovery_count":int(state.get("recovery_count",0))+1,
    "state_authority":"worker",
    "state_version":2
})
tmp=state_path.with_suffix(".recovery.tmp")
with tmp.open("w",encoding="utf-8") as f:
    json.dump(state,f,indent=2); f.flush(); os.fsync(f.fileno())
os.replace(tmp,state_path)
from supervisor.checkpoint import save as checkpoint_save
checkpoint_save(phase,"WAITING",source="safe-recovery",worker_pid=None,
                worker_updated=state["recovery_requested_at"],
                attempt_id=None,attempt_number=0)
print(json.dumps({"phase":phase,"status":"RECOVERED","recovery_count":state["recovery_count"],
                  "reason":reason,"history":str(hist.relative_to(root))}))
PY
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "RECOVERY_BLOCKED python=$RC"
  exit "$RC"
fi
if command -v tmux >/dev/null 2>&1; then
  if tmux has-session -t acep-worker 2>/dev/null; then
    echo "RECOVERY_BLOCKED worker-session-already-exists"
    exit 4
  fi
  tmux new-session -d -s acep-worker "cd '$ROOT' && exec python3 supervisor/worker.py"
  echo "RECOVERY_STARTED phase=$PHASE session=acep-worker"
else
  echo "RECOVERY_READY phase=$PHASE tmux=ABSENT"
  exit 0
fi
