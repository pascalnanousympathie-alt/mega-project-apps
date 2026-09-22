#!/usr/bin/env python3
import json
import os
import subprocess
import time
from quota import mode
from checkpoint import load, save
from gemini_bridge import run as run_gemini_bridge
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def evidence_review():
    p=subprocess.run(["python3",os.path.join(ROOT,"agents","debate.py")],
                     cwd=ROOT,text=True,capture_output=True,timeout=30)
    if p.returncode:
        return {"verdict":"ERROR","error":p.stderr[-2000:]}
    data=json.loads(p.stdout)
    return {"verdict":"REVIEW_READY","issues":data.get("issues",[]),
            "roles":data.get("roles",{}),"evidence":data.get("evidence",{})}

def gemini_verdict(phase):
    path=os.path.join(ROOT,"runtime","gemini-verdict.json")
    try:
        with open(path,encoding="utf-8") as f: d=json.load(f)
    except Exception:
        return {"verdict":"WAITING_FOR_GEMINI","phase":phase,"error":"missing runtime/gemini-verdict.json"}
    if d.get("phase")!=phase or d.get("source") not in ("gemini","groq"):
        return {"verdict":"BLOCK","phase":phase,"error":"invalid external judge verdict schema"}
    if d.get("verdict") not in ("GO","CORRECT","BLOCK"):
        return {"verdict":"BLOCK","phase":phase,"error":"invalid Gemini verdict value"}
    return d

def main():
    before=load(); phase=before.get("phase","P00")
    result=evidence_review()
    result["supervisor"]="evidence-collector"
    result["external_judge_mode"]=mode("gemini")
    result["checkpoint_before"]=before
    if phase=="P28":
        result["checkpoint_kind"]="external-judge"
        result["external_judge"]=run_gemini_bridge()
        result["external_verdict"]=gemini_verdict(phase)
        if result["external_verdict"].get("verdict") in ("GO","CORRECT","BLOCK"):
            result["checkpoint_write"]="worker-only; judge does not mutate checkpoint state"
    else:
        result["checkpoint_kind"]="observe-only"
        result["note"]="Local evidence review never declares GO and never promotes a phase."
    print(json.dumps(result,indent=2,ensure_ascii=False))
if __name__=="__main__":
    main()
