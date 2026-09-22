#!/usr/bin/env python3
import json, os, time
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE=os.path.join(ROOT,"runtime","quota-state.json")
DEFAULT={"gemini":"CHECKPOINT_ONLY","bankr":"NORMAL","deepseek":"NORMAL","groq":"NORMAL","cerebras":"NORMAL"}
def load():
    if not os.path.exists(STATE):
        return {"updated":time.time(),"providers":DEFAULT.copy()}
    try:
        with open(STATE,encoding="utf-8") as f: data=json.load(f)
        if not isinstance(data,dict) or not isinstance(data.get("providers"),dict):
            raise ValueError("quota-schema-invalid")
        return data
    except Exception as e:
        raise RuntimeError("QUOTA_STATE_CORRUPT:"+str(e)) from e
def save(data):
    os.makedirs(os.path.dirname(STATE),exist_ok=True)
    tmp=STATE+".tmp"
    with open(tmp,"w",encoding="utf-8") as f:
        json.dump(data,f,indent=2); f.flush(); os.fsync(f.fileno())
    os.replace(tmp,STATE)
    dfd=os.open(os.path.dirname(STATE),os.O_RDONLY)
    try: os.fsync(dfd)
    finally: os.close(dfd)
def mode(provider):
    return load().get("providers",DEFAULT).get(provider,"NORMAL")
def set_mode(provider,value):
    d=load(); d.setdefault("providers",DEFAULT.copy())[provider]=value
    d["updated"]=time.time(); save(d)
def allow(provider,kind="normal"):
    m=mode(provider)
    if m=="OFF": return False
    if m=="CRITICAL_ONLY": return kind=="critical"
    if m=="CHECKPOINT_ONLY": return kind in ("checkpoint","critical")
    return True
if __name__=="__main__":
    print(json.dumps(load(),indent=2))
