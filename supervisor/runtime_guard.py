import json, os, tempfile, uuid, time, fcntl
from datetime import datetime, timezone

def now(): return datetime.now(timezone.utc).isoformat()
def atomic_json(path, data):
    directory=os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix=os.path.basename(path)+".", dir=directory)
    try:
        with os.fdopen(fd,"w",encoding="utf-8") as f:
            json.dump(data,f,indent=2,sort_keys=True); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,path)
        dfd=os.open(directory,os.O_RDONLY)
        try: os.fsync(dfd)
        finally: os.close(dfd)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
def load_json(path, default=None):
    try:
        with open(path,encoding="utf-8") as f: return json.load(f)
    except Exception: return {} if default is None else default
def load_json_strict(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path,encoding="utf-8") as f:
            data=json.load(f)
        if not isinstance(data,dict):
            raise ValueError("runtime-state-schema-invalid")
        return data
    except Exception as e:
        raise RuntimeError("RUNTIME_STATE_CORRUPT:"+str(e)) from e
def new_attempt_id(): return uuid.uuid4().hex
def pid_alive(pid):
    try: os.kill(int(pid),0); return True
    except Exception: return False
def process_matches(pid,needle):
    try:
        with open(f"/proc/{int(pid)}/cmdline","rb") as f:
            raw=f.read().replace(b"\0",b" ").decode(errors="replace")
        return needle in raw
    except Exception:
        return False
def process_alive(pid,needle=None):
    return pid_alive(pid) and (needle is None or process_matches(pid,needle))
def cpu_ticks(pid):
    try:
        fields=open(f"/proc/{int(pid)}/stat",encoding="utf-8").read().split()
        return int(fields[13])+int(fields[14])
    except Exception: return None
def lease_path(root,phase): return os.path.join(root,"runtime",f"phase-{phase}-lease.json")
def _lease_guard(path):
    lock_path=path+".lock"
    os.makedirs(os.path.dirname(path),exist_ok=True)
    return open(lock_path,"a+")
def acquire_lease(root,phase,owner,attempt_id,ttl=90):
    path=lease_path(root,phase); now_epoch=time.time()
    with _lease_guard(path) as guard:
        fcntl.flock(guard.fileno(),fcntl.LOCK_EX)
        try:
            cur=load_json_strict(path)
        except RuntimeError as e:
            return False,{"phase":phase,"status":"CORRUPT","error":str(e)}
        if cur and cur.get("lease_until",0)>now_epoch and cur.get("owner_id")!=owner:
            old_owner=str(cur.get("owner_id",""))
            old_pid=None
            if old_owner.startswith("worker:"):
                try: old_pid=int(old_owner.split(":")[1])
                except Exception: old_pid=None
            if not (old_pid and not process_alive(old_pid,"supervisor/worker.py")):
                return False,cur
            cur=dict(cur)
            cur["recovered_from_dead_owner"]=old_owner
            cur["recovered_at"]=now()
        generation=int(cur.get("generation",0))+1
        data={"phase":phase,"attempt_id":attempt_id,"owner_id":owner,"generation":generation,
              "leased_at":now(),"lease_until":time.time()+ttl}
        if cur.get("recovered_from_dead_owner"):
            data["recovered_from_dead_owner"]=cur["recovered_from_dead_owner"]
            data["recovered_at"]=cur.get("recovered_at",now())
        atomic_json(path,data)
        fcntl.flock(guard.fileno(),fcntl.LOCK_UN)
        return True,data
def renew_lease(root,phase,owner,generation,ttl=90):
    path=lease_path(root,phase)
    with _lease_guard(path) as guard:
        fcntl.flock(guard.fileno(),fcntl.LOCK_EX)
        try:
            cur=load_json_strict(path)
        except RuntimeError:
            return False
        if cur.get("owner_id")!=owner or int(cur.get("generation",-1))!=int(generation):
            fcntl.flock(guard.fileno(),fcntl.LOCK_UN); return False
        cur["lease_until"]=time.time()+ttl; cur["renewed_at"]=now(); atomic_json(path,cur)
        fcntl.flock(guard.fileno(),fcntl.LOCK_UN); return True
def lease_valid(root,phase,owner,generation):
    cur=load_json(lease_path(root,phase),{})
    return cur.get("owner_id")==owner and int(cur.get("generation",-1))==int(generation) and cur.get("lease_until",0)>time.time()
def release_lease(root,phase,owner,generation):
    path=lease_path(root,phase)
    with _lease_guard(path) as guard:
        fcntl.flock(guard.fileno(),fcntl.LOCK_EX)
        try:
            cur=load_json_strict(path)
        except RuntimeError:
            return False
        if cur.get("owner_id")==owner and int(cur.get("generation",-1))==int(generation):
            try: os.remove(path)
            except FileNotFoundError: pass
            fcntl.flock(guard.fileno(),fcntl.LOCK_UN)
            return True
        fcntl.flock(guard.fileno(),fcntl.LOCK_UN)
        return False
