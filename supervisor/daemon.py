#!/usr/bin/env python3
import os
import time
import json
import subprocess
import datetime
from checkpoint import load, save
from quota import mode
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG=os.path.join(ROOT,"runtime","supervisor.log")
INTERVAL=int(os.getenv("SUPERVISOR_INTERVAL","300"))
def record(rec):
    os.makedirs(os.path.dirname(LOG),exist_ok=True)
    with open(LOG,"a") as f:
        f.write(json.dumps(rec)+"\n")
def cycle():
    before=load()
    worker_path=os.path.join(ROOT,"runtime","worker-state.json")
    try:
        with open(worker_path,encoding="utf-8") as f:
            worker=json.load(f)
    except Exception:
        worker={}
    p=subprocess.run(["python3",os.path.join(ROOT,"supervisor","judge.py")],
                     cwd=ROOT,text=True,capture_output=True,timeout=60)
    rec={"time":datetime.datetime.now().isoformat(),
         "exit":p.returncode,"gemini_mode":mode("gemini"),
         "deepseek_mode":mode("deepseek"),"groq_mode":mode("groq"),
         "cerebras_mode":mode("cerebras"),"phase":before.get("phase","P00")}
    try:
        rec.update(json.loads(p.stdout))
    except Exception:
        rec["raw"]=p.stdout[-4000:]
        rec["error"]=p.stderr[-2000:]
    record(rec)
    phase=worker.get("phase") or rec.get("phase") or before.get("phase","P00")
    rec["live_worker_status"]=worker.get("status")
    rec["live_worker_phase"]=worker.get("phase")
    rec["state_authority"]="worker-state"
    print(json.dumps(rec))
if __name__=="__main__":
    while True:
        try:
            cycle()
        except Exception as e:
            record({"time":datetime.datetime.now().isoformat(),
                    "event":"daemon_error","error":str(e)})
        time.sleep(INTERVAL)
