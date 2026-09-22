#!/usr/bin/env python3
import json, os, subprocess, time, re, sys, signal
from datetime import datetime, timezone

ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from supervisor.runtime_guard import lease_valid
RT=os.path.join(ROOT,'runtime')
STATE=os.path.join(RT,'worker-state.json')
LOG=os.path.join(RT,'agent-executor.log')
BANKR_AGENT=os.path.join(ROOT,'agents','bankr-agent.py')
TIMEOUT=int(os.environ.get('ACEP_AGENT_TIMEOUT','1200'))
FORBIDDEN=('LudoMada','.ludomada-agent')

def now(): return datetime.now(timezone.utc).isoformat()
def log(msg):
    with open(LOG,'a',encoding='utf-8') as f: f.write(now()+' '+msg+'\n')
def load_json(path, default=None):
    try:
        with open(path,encoding='utf-8') as f: return json.load(f)
    except Exception: return default if default is not None else {}
def run(cmd,timeout=120):
    p=subprocess.Popen(cmd,cwd=ROOT,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    try:
        out,err=p.communicate(timeout=timeout)
        return {'cmd':' '.join(cmd),'exit':p.returncode,'stdout':out[-6000:],'stderr':err[-3000:]}
    except subprocess.TimeoutExpired:
        try: os.killpg(p.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        try: out,err=p.communicate(timeout=3)
        except Exception: out,err='',''
        return {'cmd':' '.join(cmd),'exit':124,'stdout':(out or '')[-3000:],'stderr':'TIMEOUT'+(('\n'+(err or '')[-2000:]) if err else '')}
def git_changed(): return run(['git','status','--short'],30).get('stdout','')
def forbidden_change(): return [x for x in git_changed().splitlines() if any(part in x for part in FORBIDDEN)]

def phase_prompt(phase,task,owner,objective):
    return f'''You are the execution team for ACEP mega-project phase {phase}.\nPhase: {task}\nOwner: {owner}\nObjective: {objective}\n\nWork directly in the current repository. Inspect MASTER_PLAN_P00_P30.md, PLAN.md and existing code first. Implement the phase completely, not just a plan. Run appropriate tests and security checks. Do NOT touch LudoMada or .ludomada-agent; it is protected. Use only evidence that actually exists. Do not fabricate PASS, tests, payments, credentials or deployment results. Preserve resumability and existing runtime/supervisor files unless the phase requires a justified change. At the end, report exact files changed and exact commands/results used. Only if implementation and tests are genuinely complete, print the exact token PHASE_COMPLETE:{phase}'''

def model_for_phase(phase):
    selected=os.environ.get("ACEP_SELECTED_MODEL")
    if selected:
        return selected
    try:
        from agents.model_router import model_for_phase as route
    except ModuleNotFoundError:
        from model_router import model_for_phase as route
    forced_phase=os.environ.get("ACEP_MODEL_PHASE")
    override=os.environ.get("ACEP_MODEL") if forced_phase==phase else None
    return route(phase,override)

ROLE_MODELS={
    "project_manager":"qwen3.8-flash",
    "senior_developer":"deepseek-v4.1-flash",
    "devops":"qwen3.8-flash",
    "security":"deepseek-v4-pro",
}
ROLE_FOCUS={
    "project_manager":"scope, dependencies, acceptance criteria and blockers; do not modify files.",
    "senior_developer":"architecture, implementation correctness and test coverage; review only.",
    "devops":"runtime, build/test execution, reproducibility and operational evidence; review only.",
    "security":"secrets, authz, validation, injection, replay/idempotency and protected paths; review only.",
}

def role_review(role,phase,task,objective,model,attempt_id,lease_owner,lease_generation):
    focus=ROLE_FOCUS[role]
    token=f"ROLE_REVIEW_PASS:{role}:{phase}"
    prompt=(f"You are ACEP role reviewer: {role}. Phase {phase}: {task}. Objective: {objective}. "
            f"Review the repository state and evidence after the implementation agent. Focus only on {focus} "
            f"Do not modify any file. Run only bounded read-only inspection/tests needed for your role. "
            f"Do not trust a completion token by itself. Report concrete findings. "
            f"Only when your role review passes, output the exact token {token}.")
    env=os.environ.copy(); env.update({
        "ACEP_ATTEMPT_ID":attempt_id,
        "ACEP_LEASE_OWNER":lease_owner,
        "ACEP_LEASE_GENERATION":str(lease_generation),
        "ACEP_READ_ONLY":"1",
        "ACEP_MAX_TOOL_STEPS":"8",
        "ACEP_MAX_TOKENS":"1400",
    })
    log(f"{phase} ROLE_REVIEW_START role={role} model={model}")
    p=subprocess.Popen(["python3",BANKR_AGENT,"--model",model,"--phase",phase,
                        "--timeout","180","--prompt",prompt],
                       cwd=ROOT,text=True,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                       start_new_session=True)
    try:
        out,err=p.communicate(timeout=190)
    except subprocess.TimeoutExpired:
        try: os.killpg(p.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        out,err="","TIMEOUT"
        rc=124
    else:
        rc=p.returncode
    out=(out or "")[-6000:]; err=(err or "")[-3000:]
    ok=(rc==0 and token in out)
    log(f"{phase} ROLE_REVIEW_END role={role} exit={rc} pass={ok}")
    return {"role":role,"model":model,"exit":rc,"pass":ok,"stdout":out,"stderr":err,"token":token}

def required_review_roles(phase,owner):
    roles=[]
    first=owner.lower().split("+")[0].strip()
    if "project manager" not in first:
        roles.append("project_manager")
    if "senior developer" not in first:
        roles.append("senior_developer")
    if "devops" not in first:
        roles.append("devops")
    if "security" not in first:
        roles.append("security")
    return roles

def dispatch(phase,task,owner,objective):
    model=model_for_phase(phase)
    if model=='gemini-checkpoint-only':
        log(f'{phase} BLOCKED checkpoint-only')
        return {'exit':1,'complete_token':False,'stdout':'','stderr':'Gemini checkpoint-only','model':model}
    log(f'{phase} DISPATCH provider=bankr model={model}')
    prompt=phase_prompt(phase,task,owner,objective)
    p=None
    try:
        p=subprocess.Popen(['python3',BANKR_AGENT,'--model',model,'--phase',phase,'--timeout',str(TIMEOUT),'--prompt',prompt],
                           cwd=ROOT,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                           start_new_session=True)
        out,err=p.communicate(timeout=TIMEOUT)
        out=(out or '')[-12000:]; err=(err or '')[-6000:]
        with open(os.path.join(RT,'agent-last-output.txt'),'w',encoding='utf-8') as f: f.write(out+'\n--- STDERR ---\n'+err)
        complete=f'PHASE_COMPLETE:{phase}' in out
        log(f'{phase} BANKR_DIRECT_EXIT={p.returncode} COMPLETE_TOKEN={complete} model={model}')
        return {'exit':p.returncode,'complete_token':complete,'stdout':out,'stderr':err,'model':model}
    except subprocess.TimeoutExpired:
        if p is not None:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                out,err=p.communicate(timeout=5)
            except Exception:
                out,err='',''
        else:
            out,err='',''
        log(f'{phase} BANKR_DIRECT_TIMEOUT model={model}')
        return {'exit':124,'complete_token':False,'stdout':(out or '')[-12000:],'stderr':'TIMEOUT'+(('\n'+(err or '')[-3000:]) if err else ''),'model':model}

def tests():
    results=[run(['python3','-m','compileall','-q','agents','supervisor'],120)]
    pkg=os.path.join(ROOT,'package.json')
    if os.path.exists(pkg):
        data=load_json(pkg,{})
        if 'test' in data.get('scripts',{}): results.append(run(['npm','test','--','--runInBand'],900))
    return results

def security():
    results=[
        run(['git','diff','--check'],60),
        run(['node','scripts/secret-scan.js'],120),
    ]
    blocked_paths=forbidden_change()
    status='PASS' if all(x['exit']==0 for x in results) and not blocked_paths else 'BLOCKED'
    return {'status':status,'results':results,
            'reason':'protected-change' if blocked_paths else ''}

def main():
    st=load_json(STATE,{})
    phase=st.get('phase','P04'); task=st.get('task',phase); owner=st.get('owner','local agents'); objective=st.get('objective','')
    if phase=='P30' and st.get('status')=='COMPLETE': return 0
    if forbidden_change(): log(f'{phase} BLOCKED protected-change-before-dispatch'); return 2
    attempt_id=os.environ.get('ACEP_ATTEMPT_ID'); lease_owner=os.environ.get('ACEP_LEASE_OWNER'); lease_generation=os.environ.get('ACEP_LEASE_GENERATION')
    if not (attempt_id and lease_owner and lease_generation and lease_valid(ROOT,phase,lease_owner,int(lease_generation))):
        log(f'{phase} BLOCKED lease-fence-before-dispatch'); return 6
    result=dispatch(phase,task,owner,objective)
    if not lease_valid(ROOT,phase,lease_owner,int(lease_generation)):
        log(f'{phase} BLOCKED lease-fence-after-dispatch'); return 7
    if forbidden_change(): log(f'{phase} BLOCKED protected-change-after-dispatch'); return 4
    role_reviews=[]
    if result['exit']==0 and result['complete_token']:
        reviewer_roles=required_review_roles(phase,owner)
        for role in reviewer_roles:
            if not lease_valid(ROOT,phase,lease_owner,int(lease_generation)):
                log(f'{phase} BLOCKED lease-fence-before-role-review'); return 8
            rr=role_review(role,phase,task,objective,ROLE_MODELS[role],attempt_id,lease_owner,int(lease_generation))
            role_reviews.append(rr)
            if not rr['pass']:
                break
    tr=tests(); sec=security(); all_tests=all(x['exit']==0 for x in tr)
    roles_ok=(result['exit']==0 and result['complete_token'] and bool(role_reviews) and all(x['pass'] for x in role_reviews))
    complete=roles_ok and all_tests and sec['status']=='PASS'
    evidence={'phase':phase,'agent':result,'role_reviews':role_reviews,'tests':tr,'security':sec,'git_status':git_changed(),
              'role_protocol':{'primary_owner':owner,'required_reviews':required_review_roles(phase,owner)}}
    if complete:
        marker={'phase':phase,'status':'PASS','completed':now(),'attempt_id':attempt_id,'evidence':evidence}
        tmp=os.path.join(RT,f'.phase-{phase}-complete.json.tmp.{os.getpid()}')
        try:
            with open(tmp,'w',encoding='utf-8') as f:
                json.dump(marker,f,indent=2); f.flush(); os.fsync(f.fileno())
            os.replace(tmp,os.path.join(RT,f'phase-{phase}-complete.json'))
        finally:
            if os.path.exists(tmp): os.unlink(tmp)
        log(f'{phase} REAL_PASS marker-created'); return 0
    with open(os.path.join(RT,f'phase-{phase}-blocked.json'),'w',encoding='utf-8') as f: json.dump({'phase':phase,'status':'BLOCKED','updated':now(),'evidence':evidence},f,indent=2)
    log(f'{phase} BLOCKED validation'); return 5

if __name__=='__main__': raise SystemExit(main())
