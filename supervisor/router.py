#!/usr/bin/env python3
import os
import subprocess
import json
import time
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG=os.path.join(ROOT,"runtime","router.log")
def run_local(task):
    p=subprocess.run(task,cwd=ROOT,text=True,capture_output=True,timeout=120)
    rec={"time":time.time(),"kind":"local","exit":p.returncode,
         "stdout":p.stdout[-6000:],"stderr":p.stderr[-3000:]}
    os.makedirs(os.path.dirname(LOG),exist_ok=True)
    with open(LOG,"a") as f:
        f.write(json.dumps(rec)+"\n")
    return rec
def evidence():
    return [
        run_local(["git","status","--short"]),
        run_local(["git","diff","--stat"]),
        run_local(["python3","-m","compileall","-q","agents","supervisor"])
    ]
if __name__=="__main__":
    print(json.dumps(evidence(),indent=2))
