#!/usr/bin/env python3
import json, os, time, tempfile
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH=os.path.join(ROOT,"runtime","checkpoint.json")

def load():
    if not os.path.exists(PATH):
        return {"phase":"P00","status":"NEW","updated":0}
    try:
        with open(PATH,encoding="utf-8") as f: data=json.load(f)
        if not isinstance(data,dict) or not isinstance(data.get("phase"),str) or not isinstance(data.get("status"),str):
            raise ValueError("checkpoint-schema-invalid")
        return data
    except Exception as e:
        raise RuntimeError(f"CHECKPOINT_CORRUPT:{e}") from e

def save(phase,status,**extra):
    data=load()
    data.update({"phase":phase,"status":status,"updated":time.time(),**extra})
    directory=os.path.dirname(PATH); os.makedirs(directory,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix="checkpoint.",dir=directory)
    try:
        with os.fdopen(fd,"w",encoding="utf-8") as f:
            json.dump(data,f,indent=2); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,PATH)
        dfd=os.open(directory,os.O_RDONLY)
        try: os.fsync(dfd)
        finally: os.close(dfd)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    return data
if __name__=="__main__": print(json.dumps(load(),indent=2))
