#!/usr/bin/env python3
import json, os, subprocess, time, signal, threading, uuid, sys
from datetime import datetime, timezone

ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from supervisor.runtime_guard import atomic_json, load_json as rg_load, new_attempt_id, cpu_ticks, process_alive, acquire_lease, renew_lease, release_lease
from supervisor.gemini_bridge import run as run_gemini_bridge
RT=os.path.join(ROOT,"runtime"); os.makedirs(RT,exist_ok=True)
STATE=os.path.join(RT,"worker-state.json")
LOG=os.path.join(RT,"worker.log")
NEXT=os.path.join(RT,"next-task.json")
LOCK=os.path.join(RT,"worker.lock")
HEARTBEAT=30
LEASE_TTL=90

TASKS=[
("P04","Data model & persistence","Senior Developer","Users, wallets, ledger, games, rooms, transactions, audit records."),
("P05","Authentication & authorization","Senior Developer","Identity, sessions/tokens, roles and service authorization."),
("P06","Central wallet & ledger","Senior Developer","Balance, immutable ledger, idempotency and reconciliation interfaces."),
("P07","Multiplayer gateway","Senior Developer","WebSocket/session lifecycle, rooms, reconnect and authoritative state."),
("P08","DominoMada core","Senior Developer","Rules, turn engine, online/offline modes and persistence."),
("P09","LotoMada core","Senior Developer","Ticket validation, shuffle, draw/win logic and prize accounting."),
("P10","RamiMada core","Senior Developer","Deck, groups/runs, turn/discard validation and persistence."),
("P11","Shared API contracts","Senior Developer + DevOps","Versioned REST/WebSocket contracts, errors and idempotency."),
("P12","Payment abstraction","Senior Developer + Security","MVola/Airtel/Orange/Binance adapters behind one interface."),
("P13","Payment reconciliation","Senior Developer + Security","Pending/success/failure states and duplicate protection."),
("P14","Wallet/game integration","Senior Developer + PM","Entry fees, prizes, commissions, refunds and atomicity."),
("P15","Client/UI integration","Senior Developer + PM","Login, home, lobby, wallet, waiting room, game and profile."),
("P16","Localization","PM + Senior Developer","Malagasy/French/English and currency/format consistency."),
("P17","Offline/manual modes","Senior Developer + Security","Deterministic local state and tamper protection."),
("P18","Automated tests","Senior Developer + DevOps","Unit/integration coverage for rules, wallet, payments and gateway."),
("P19","End-to-end tests","DevOps + Senior Developer","Auth to lobby/game/wallet/payment/reconciliation flows."),
("P20","Security audit","Security Auditor","Secrets, authz, injection, validation, replay and dependency audit."),
("P21","Performance/reliability","DevOps + Senior Developer","Concurrency, reconnects, DB pool, backpressure and limits."),
("P22","Failure/recovery drills","DevOps + Security","Restart, crash, network loss and duplicate callback recovery."),
("P23","Build/release reproducibility","DevOps + Security","Clean build, versioning, artifacts, signing and checksums."),
("P24","CI/CD","DevOps + PM","Tests/build/security gates and deployment rules."),
("P25","Observability","DevOps + Security","Logs, health checks, metrics, audit trails and leakage checks."),
("P26","Production/payment readiness","PM + DevOps + Security","Provider readiness, environment separation and reconciliation."),
("P27","Release candidate","PM + all agents","Freeze candidate, regression and evidence pack."),
("P28","Final independent judge","External judge (Gemini/Groq)","Evidence/diffs/results review; no gate bypass."),
("P29","Launch & monitored rollout","DevOps + PM","Approved launch, smoke test, monitoring and rollback."),
("P30","Continuous operations","PM + DevOps","Long-running surveillance and controlled improvements."),
]

def now(): return datetime.now(timezone.utc).isoformat()
def load_state(): return rg_load(STATE,{})
def save(obj): atomic_json(STATE,obj)
def checkpoint_sync(obj):
    from supervisor.checkpoint import save as checkpoint_save
    status=obj.get("status","HEARTBEAT")
    terminal=status in ("BLOCKED","COMPLETE")
    checkpoint_save(obj.get("phase","P00"),status,
                    source="worker",worker_pid=None if terminal else os.getpid(),
                    worker_updated=obj.get("updated") or obj.get("updated_at"),
                    attempt_id=obj.get("attempt_id"),
                    attempt_number=obj.get("attempt_number"))
def log(msg):
    with open(LOG,"a") as f: f.write(now()+" "+msg+"\\n")
def run(cmd,timeout=60):
    p=subprocess.Popen(cmd,cwd=ROOT,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    try:
        out,err=p.communicate(timeout=timeout)
        rc=p.returncode
    except subprocess.TimeoutExpired:
        try: os.killpg(p.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        try: out,err=p.communicate(timeout=3)
        except Exception: out,err="",""
        rc=124
    return {"cmd":" ".join(cmd),"exit":rc,"stdout":(out or "")[-3000:],"stderr":(err or "")[-1500:]}
def evidence():
    return [run(["git","status","--short"]),run(["git","diff","--stat"]),run(["python3","-m","compileall","-q","agents","supervisor"])]
def phase_index(phase):
    for i,(p,*_) in enumerate(TASKS):
        if p==phase: return i
    return 0
def completion_marker(phase, expected_attempt_id=None):
    path=os.path.join(RT,"phase-"+phase+"-complete.json")
    if not os.path.exists(path): return None
    d=rg_load(path,{})
    if d.get("phase")!=phase or d.get("status")!="PASS":
        return None
    marker_attempt=d.get("attempt_id")
    if expected_attempt_id is not None and marker_attempt != expected_attempt_id:
        return None
    return d
def next_task(i):
    phase,name,owner,objective=TASKS[i]
    d={"phase":phase,"task":name,"owner":owner,"objective":objective,"required":"Create real completion evidence.","generated":now()}
    atomic_json(NEXT,d); return d

def ensure_git_baseline():
    head=run(["git","rev-parse","--verify","HEAD"],15)
    tracked=run(["git","ls-files"],30)
    if head["exit"]==0 and tracked["stdout"].strip():
        return {"status":"EXISTING","head":head["stdout"].strip()}
    for protected in ("LudoMada",".ludomada-agent"):
        if os.path.exists(os.path.join(ROOT,protected)):
            return {"status":"BLOCKED","reason":"protected-root-present","path":protected}
    secret=run(["node","scripts/secret-scan.js"],120)
    if secret["exit"]!=0:
        return {"status":"BLOCKED","reason":"secret-scan-before-baseline","secret":secret}
    add=run(["git","add","-A"],120)
    if add["exit"]!=0:
        return {"status":"BLOCKED","reason":"git-add","add":add}
    commit=run(["git","-c","user.name=ACEP Pipeline","-c","user.email=acep@localhost",
                "commit","-m","ACEP local baseline after verified P18"],120)
    if commit["exit"]!=0:
        return {"status":"BLOCKED","reason":"git-commit","commit":commit}
    new_head=run(["git","rev-parse","--verify","HEAD"],15)
    status=run(["git","status","--short"],30)
    if new_head["exit"]!=0 or status["stdout"].strip():
        return {"status":"BLOCKED","reason":"baseline-postcheck","head":new_head,"status_check":status}
    return {"status":"CREATED","head":new_head["stdout"].strip(),"status_check":status}
def claim_lock():
    try:
        fd=os.open(LOCK,os.O_CREAT|os.O_EXCL|os.O_WRONLY); os.write(fd,str(os.getpid()).encode()); os.close(fd); return True
    except FileExistsError:
        try:
            with open(LOCK) as f: pid=int(f.read().strip())
            if process_alive(pid,"supervisor/worker.py"): return False
        except Exception:
            pass
        try: os.remove(LOCK)
        except FileNotFoundError: pass
        return claim_lock()
def release_lock(*_):
    try:
        with open(LOCK,encoding="utf-8") as f: owner_pid=f.read().strip()
        if owner_pid==str(os.getpid()):
            os.remove(LOCK)
    except FileNotFoundError:
        pass
def stop_worker(*_):
    release_lock()
    raise SystemExit(0)
def heartbeat_loop(stop,phase,attempt_id,owner,generation,box,attempt_path,model):
    last_ticks=None; counter=0
    while not stop.wait(15):
        st=load_state()
        if st.get("phase")!=phase or st.get("attempt_id")!=attempt_id: continue
        ep=box.get("pid"); ticks=cpu_ticks(ep) if ep else None
        if ticks is not None and ticks != last_ticks:
            counter += 1; last_ticks=ticks; st["last_progress_at"]=now(); st["progress_counter"]=counter
        progress_path=os.path.join(RT,f"agent-progress-{phase}.json")
        agent_progress=rg_load(progress_path,{})
        if agent_progress.get("attempt_id")==attempt_id:
            try:
                p_epoch=float(agent_progress.get("updated",0))
                current_epoch=time.time()
                if p_epoch and p_epoch <= current_epoch and p_epoch > 0:
                    from datetime import datetime, timezone
                    p_iso=datetime.fromtimestamp(p_epoch,timezone.utc).isoformat()
                    old_iso=st.get("last_progress_at","")
                    if not old_iso or p_iso > old_iso:
                        st["last_progress_at"]=p_iso
                    st["agent_progress_step"]=int(agent_progress.get("step",0))
                    st["agent_progress_event"]=agent_progress.get("event")
            except Exception:
                pass
        st["heartbeat_at"]=now(); st["updated_at"]=now(); st["executor_pid"]=ep; st["status"]="RUNNING";
        st["state_authority"]="worker"; st["state_version"]=2; save(st)
        attempt=rg_load(attempt_path,{})
        if attempt.get("attempt_id")==attempt_id:
            attempt.update({"worker_pid":os.getpid(),"executor_pid":ep,"model":model,
                            "last_heartbeat":st["heartbeat_at"],"last_progress":st.get("last_progress_at"),
                            "status":"RUNNING","state_version":2})
            atomic_json(attempt_path,attempt)
        lease_ok=renew_lease(ROOT,phase,owner,generation,LEASE_TTL)
        if not lease_ok:
            st=load_state()
            if st.get("phase")==phase and st.get("attempt_id")==attempt_id:
                st["status"]="BLOCKED"
                st["failure_reason"]="LEASE_LOST"
                st["updated_at"]=now()
                st["state_authority"]="worker"
                st["state_version"]=2
                save(st)
                checkpoint_sync(st)
                log(f"{phase} LEASE_LOST attempt_id={attempt_id} generation={generation}")
            ep=box.get("pid")
            if ep and process_alive(ep,"agents/executor.py"):
                try:
                    os.killpg(int(ep),signal.SIGTERM)
                    log(f"{phase} EXECUTOR_TERMINATE_ON_LEASE_LOSS pid={ep}")
                except ProcessLookupError:
                    pass
                try:
                    time.sleep(1)
                    if process_alive(ep,"agents/executor.py"):
                        os.killpg(int(ep),signal.SIGKILL)
                        log(f"{phase} EXECUTOR_KILL_ON_LEASE_LOSS pid={ep}")
                except ProcessLookupError:
                    pass
            stop.set()
            continue
        checkpoint_sync(st)

def main():
    if not claim_lock(): log("WORKER_ALREADY_RUNNING"); return 2
    signal.signal(signal.SIGTERM,stop_worker); signal.signal(signal.SIGINT,stop_worker)
    owner="worker:"+str(os.getpid())+":"+uuid.uuid4().hex[:8]
    log("PERSISTENT_WORKER_STARTED owner="+owner)
    st=load_state(); current=st.get("phase","P03"); i=phase_index(current)
    if current=="P03" and st.get("status")=="PASS": i=0
    while i < len(TASKS):
        phase,name,owner_role,objective=TASKS[i]
        attempt_path=os.path.join(RT,"phase-"+phase+"-attempt.json")
        attempt_snapshot=rg_load(attempt_path,{})
        marker=completion_marker(phase)
        if phase != "P28":
            if attempt_snapshot.get("attempt_id"):
                marker=completion_marker(phase,attempt_snapshot.get("attempt_id"))
            else:
                marker=None
        if phase=="P28" and not marker:
            bridge_result=run_gemini_bridge()
            log(f"P28 EXTERNAL_JUDGE status={bridge_result.get('status')} source={bridge_result.get('source','')} reason={bridge_result.get('reason','')}")
            verdict_path=os.path.join(RT,"gemini-verdict.json")
            verdict=rg_load(verdict_path,{})
            if verdict.get("phase")!="P28" or verdict.get("source") not in ("gemini","groq"):
                waiting={"phase":"P28","task":name,"owner":owner_role,"status":"WAITING_FOR_EXTERNAL_JUDGE",
                         "updated":now(),"reason":"external-judge-checkpoint-required",
                         "state_authority":"worker","state_version":2}
                save(waiting); checkpoint_sync(waiting); time.sleep(HEARTBEAT); continue
            if verdict.get("verdict")!="GO":
                blocked={"phase":"P28","task":name,"owner":owner_role,"status":"BLOCKED",
                         "updated":now(),"reason":"gemini-verdict-"+str(verdict.get("verdict")),
                         "gemini_verdict":verdict,"state_authority":"worker","state_version":2}
                atomic_json(os.path.join(RT,"phase-P28-blocked.json"),blocked)
                save(blocked); checkpoint_sync(blocked); log("P28 EXTERNAL_JUDGE_BLOCKED"); release_lock(); return 5
            packet=evidence()
            if not all(x["exit"]==0 for x in packet):
                blocked={"phase":"P28","task":name,"owner":owner_role,"status":"BLOCKED",
                         "updated":now(),"reason":"local-evidence-gate-failed","evidence":packet,
                         "state_authority":"worker","state_version":2}
                atomic_json(os.path.join(RT,"phase-P28-blocked.json"),blocked)
                save(blocked); checkpoint_sync(blocked); return 5
            marker={"phase":"P28","status":"PASS","completed":now(),"source":verdict.get("source"),"verdict":verdict,
                    "local_evidence":packet}
            atomic_json(os.path.join(RT,"phase-P28-complete.json"),marker)
            log("P28 REAL_PASS external-"+str(verdict.get("source")))
            i+=1; continue
        if marker:
            ev=evidence()
            if all(x["exit"]==0 for x in ev):
                baseline={"status":"SKIPPED"}
                if phase=="P18":
                    baseline=ensure_git_baseline()
                    if baseline["status"]=="BLOCKED":
                        blocked={"phase":phase,"task":name,"owner":owner_role,"status":"BLOCKED","updated":now(),
                                 "reason":"git-baseline-failed","evidence":ev,"git_baseline":baseline,
                                 "state_authority":"worker","state_version":2}
                        save(blocked); checkpoint_sync(blocked); log("P18 BLOCKED git-baseline")
                        release_lock(); return 5
                    ev.append({"git_baseline":baseline})
                done={"phase":phase,"task":name,"status":"PASS","finished":now(),"evidence":ev,"completion":marker,
                      "state_authority":"worker","state_version":2}; save(done); checkpoint_sync(done); log(f"{phase} PASS completion-evidence"); i+=1; continue
            save({"phase":phase,"task":name,"status":"BLOCKED","updated":now(),"evidence":ev}); time.sleep(HEARTBEAT); continue
        next_task(i); ev=evidence()
        if not all(x["exit"]==0 for x in ev):
            blocked_state={"phase":phase,"task":name,"owner":owner_role,"status":"BLOCKED","updated":now(),"evidence":ev}; save(blocked_state); checkpoint_sync(blocked_state); time.sleep(HEARTBEAT); continue
        attempt_path=os.path.join(RT,"phase-"+phase+"-attempt.json"); attempt=attempt_snapshot
        if attempt and (attempt.get("phase") != phase or not attempt.get("attempt_id") or "attempt_number" not in attempt):
            log(f"{phase} RECOVERING_MALFORMED_ATTEMPT")
            attempt={}
        if int(attempt.get("attempt_number",0)) >= 3 and attempt.get("status") in ("FAILED","BLOCKED"):
            blocked={"phase":phase,"task":name,"owner":owner_role,"status":"BLOCKED","updated":now(),
                     "objective":objective,"attempt_id":attempt.get("attempt_id"),
                     "attempt_number":attempt.get("attempt_number"),"failure_reason":"CIRCUIT_BREAKER_MAX_ATTEMPTS",
                     "evidence":ev}
            atomic_json(os.path.join(RT,"phase-"+phase+"-blocked.json"),blocked)
            save(blocked); checkpoint_sync(blocked); log(f"{phase} CIRCUIT_BREAKER_BLOCKED attempt_number={attempt.get('attempt_number')}"); release_lock(); return 5
        if (not attempt) or time.time() >= attempt.get("retry_after_epoch",0):
            attempt_id=attempt.get("attempt_id") or new_attempt_id()
            recovering_same_attempt=bool(attempt and attempt.get("status")=="RUNNING" and
                                        attempt.get("worker_pid") and not process_alive(attempt.get("worker_pid"),"supervisor/worker.py"))
            if recovering_same_attempt and attempt.get("executor_pid") and process_alive(attempt.get("executor_pid"),"agents/executor.py"):
                log(f"{phase} RECOVERY_WAIT_EXECUTOR_ALIVE pid={attempt.get('executor_pid')}")
                time.sleep(HEARTBEAT)
                continue
            try:
                from agents.model_router import model_for_phase as _route_model
                forced_phase=os.environ.get("ACEP_MODEL_PHASE")
                override_model=os.environ.get("ACEP_MODEL") if forced_phase==phase else None
                base_model=attempt.get("model") or override_model or _route_model(phase)
                previous_failures=int(attempt.get("attempt_number",0)) if attempt else 0
                selected_model="deepseek-v4-pro" if base_model=="deepseek-v4.1-flash" and previous_failures>=2 else base_model
            except Exception:
                forced_phase=os.environ.get("ACEP_MODEL_PHASE")
                override_model=os.environ.get("ACEP_MODEL") if forced_phase==phase else None
                selected_model=attempt.get("model") or override_model or "qwen3.8-flash"
            ok,lease=acquire_lease(ROOT,phase,owner,attempt_id,LEASE_TTL)
            if not ok: log(f"{phase} LEASE_DENIED"); time.sleep(HEARTBEAT); continue
            prior_attempt_number=int(attempt.get("attempt_number",0))
            attempt_number=prior_attempt_number if recovering_same_attempt else prior_attempt_number+1
            attempt={"phase":phase,"attempt_id":attempt_id,"attempt_number":attempt_number,"worker_pid":os.getpid(),"executor_pid":None,"started":now(),"last_heartbeat":now(),"last_progress":now(),"model":selected_model,"status":"RUNNING","result":None,"failure_reason":None,"generation":lease["generation"],"lease_owner":owner,"started_epoch":time.time(),"state_version":2}
            atomic_json(attempt_path,attempt)
            save({"phase":phase,"task":name,"owner":owner_role,"status":"RUNNING","started":attempt["started"],"objective":objective,"attempt_id":attempt_id,"attempt_number":attempt_number,"worker_pid":os.getpid(),"executor_pid":None,"heartbeat_at":now(),"last_progress_at":now(),"progress_counter":0,"lease_generation":lease["generation"],"lease_owner":owner,"model":selected_model,"state_authority":"worker","state_version":2})
            checkpoint_sync({"phase":phase,"status":"RUNNING","attempt_id":attempt_id,"attempt_number":attempt_number,"worker_pid":os.getpid(),"executor_pid":None,"updated_at":now(),"state_authority":"worker","state_version":2})
            log(f"{phase} AGENT_EXECUTION_STARTED attempt_id={attempt_id} attempt_number={attempt_number}")
            box={"pid":None}; stop=threading.Event(); hb=threading.Thread(target=heartbeat_loop,args=(stop,phase,attempt_id,owner,lease["generation"],box,attempt_path,selected_model),daemon=True); hb.start()
            env=os.environ.copy(); env.update({"ACEP_ATTEMPT_ID":attempt_id,"ACEP_LEASE_OWNER":owner,"ACEP_LEASE_GENERATION":str(lease["generation"]),"ACEP_SELECTED_MODEL":selected_model})
            try:
                p=subprocess.Popen(["python3",os.path.join(ROOT,"agents","executor.py")],cwd=ROOT,text=True,env=env,start_new_session=True); box["pid"]=p.pid
                st=load_state(); st.update({"executor_pid":p.pid,"heartbeat_at":now(),"updated_at":now(),"model":selected_model,"state_authority":"worker","state_version":2}); save(st)
                attempt_now=rg_load(attempt_path,{})
                if attempt_now.get("attempt_id")==attempt_id:
                    attempt_now.update({"executor_pid":p.pid,"model":selected_model,"last_heartbeat":now()}); atomic_json(attempt_path,attempt_now)
                executor_wait=max(1500,int(os.environ.get("ACEP_WORKER_EXECUTOR_TIMEOUT","1500")))
                rc=p.wait(timeout=executor_wait); result={"cmd":"python3 agents/executor.py","exit":rc}
            except subprocess.TimeoutExpired:
                try: os.killpg(p.pid,signal.SIGKILL)
                except ProcessLookupError: pass
                try: p.wait(timeout=5)
                except Exception: pass
                result={"cmd":"python3 agents/executor.py","exit":124}
            finally:
                stop.set(); hb.join(timeout=2)
            final_state=load_state(); attempt["executor_pid"]=box.get("pid"); attempt["model"]=selected_model; attempt["last_heartbeat"]=now(); attempt["last_progress"]=final_state.get("last_progress_at")
            phase_done = completion_marker(phase,attempt_id) if phase != "P28" else completion_marker(phase)
            attempt["status"]="PASS" if result["exit"]==0 and phase_done else "FAILED"; attempt["result"]=result; attempt["failure_reason"]=None if attempt["status"]=="PASS" else "executor_exit="+str(result["exit"]); attempt["completed_at"]=now() if attempt["status"]=="PASS" else None; attempt["retry_after_epoch"]=0 if attempt["status"]=="PASS" else time.time()+60
            attempt["state_version"]=2; atomic_json(attempt_path,attempt); log(f"{phase} AGENT_EXECUTOR_EXIT={result['exit']} attempt_id={attempt_id} model={selected_model}")
            if attempt["status"]=="PASS":
                release_lease(ROOT,phase,owner,lease["generation"])
                final_state=load_state(); final_state.update({"status":"PASS","state_authority":"worker","state_version":2,"updated_at":now()}); save(final_state); checkpoint_sync(final_state)
            else:
                waiting_state={"phase":phase,"task":name,"owner":owner_role,"status":"WAITING","updated":now(),"objective":objective,"attempt_id":attempt_id,"attempt_number":attempt_number,"worker_pid":os.getpid(),"executor_pid":box.get("pid"),"heartbeat_at":now(),"last_progress_at":attempt["last_progress"],"reason":"bounded-retry-window","failure_reason":attempt["failure_reason"],"model":selected_model,"state_authority":"worker","state_version":2}
                save(waiting_state); checkpoint_sync(waiting_state)
        else:
            waiting_window={"phase":phase,"task":name,"owner":owner_role,"status":"WAITING","updated":now(),"objective":objective,"attempt_id":attempt.get("attempt_id"),"attempt_number":attempt.get("attempt_number"),"reason":"retry-window-15m","state_authority":"worker","state_version":2}
            save(waiting_window)
            checkpoint_sync(waiting_window)
        for _ in range(HEARTBEAT):
            time.sleep(1)
            if completion_marker(phase): break
    save({"phase":"P30","task":"Continuous operations","status":"COMPLETE","finished":now()}); log("P04_P30_EXECUTOR_COMPLETE"); release_lock(); return 0
if __name__=="__main__": raise SystemExit(main())
