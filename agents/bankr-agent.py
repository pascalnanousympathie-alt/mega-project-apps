#!/usr/bin/env python3
import argparse, json, os, subprocess, sys, time, tempfile, urllib.request, urllib.error, signal, shlex, hashlib
from pathlib import Path
if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from supervisor.runtime_guard import lease_valid
from agents.llm_budget import before_request, record_usage, BudgetError
from agents.url_safety import require_safe_http_url
class BankrError(RuntimeError):
    pass

ROOT=Path(__file__).resolve().parents[1]
BASE=os.environ.get("BANKR_BASE_URL","https://llm.bankr.bot/v1").rstrip("/")
CONFIG=Path.home()/".bankr"/"config.json"

def key():
    with CONFIG.open(encoding="utf-8") as f:
        k=json.load(f).get("apiKey")
    if not isinstance(k,str) or not k: raise BankrError("Bankr API key absent")
    return k

def call(model,messages,tools=None,timeout=120,deadline=None,phase=None,attempt_id=None):
    max_tokens=int(os.environ.get("ACEP_MAX_TOKENS","5000"))
    body={"model":model,"messages":messages,"max_tokens":max_tokens,"temperature":0.1}
    if tools: body["tools"]=tools; body["tool_choice"]="auto"
    raw=json.dumps(body).encode()
    last=None
    max_attempts=int(os.environ.get("ACEP_MODEL_RETRIES","2"))
    for attempt in range(max_attempts):
        remaining=(deadline-time.time()) if deadline is not None else timeout
        if remaining <= 1:
            raise BankrError("Bankr overall deadline reached")
        request_timeout=max(1,min(timeout,int(remaining)))
        if phase and attempt_id:
            try:
                before_request(phase,attempt_id,model,messages,max_tokens)
            except BudgetError as e:
                raise BankrError("BUDGET_GUARD:"+str(e)) from e
        endpoint = require_safe_http_url(BASE + "/chat/completions")
        req=urllib.request.Request(endpoint,data=raw,
            headers={"Authorization":"Bearer "+key(),"Content-Type":"application/json"},method="POST")
        try:
            with urllib.request.urlopen(req,timeout=request_timeout) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- request URL passed through require_safe_http_url
                data=json.load(resp)
            if phase and attempt_id:
                try:
                    usage=record_usage(phase,attempt_id,model,data.get("usage") or {})
                    progress_event=f"usage={usage['input_tokens']}/{usage['output_tokens']} cost={usage['cost_usd']:.6f} phase_spend={usage['phase_spend_usd']:.6f}"
                except BudgetError as e:
                    raise BankrError("BUDGET_RECORD:"+str(e)) from e
            return data
        except urllib.error.HTTPError as e:
            detail=e.read().decode(errors="replace")[-2000:]
            last=BankrError(f"HTTP {e.code}: {detail}")
            if e.code not in (408,409,429,500,502,503,504): raise last
            if e.code == 429:
                raise last
        except (urllib.error.URLError, TimeoutError) as e:
            last=BankrError("Bankr transport: "+str(e))
        if attempt < max_attempts-1:
            remaining=(deadline-time.time()) if deadline is not None else timeout
            if remaining <= 1.5: break
            time.sleep(min(1.0*(attempt+1),max(0.1,remaining-1)))
    raise last or BankrError("Bankr request failed")

def lease_guard(phase):
    attempt=os.environ.get("ACEP_ATTEMPT_ID")
    owner=os.environ.get("ACEP_LEASE_OWNER")
    generation=os.environ.get("ACEP_LEASE_GENERATION")
    if not (attempt and owner and generation):
        return True
    try:
        return lease_valid(str(ROOT),phase,owner,int(generation))
    except Exception:
        return False

SENSITIVE_NAMES={".env",".env.local",".env.production",".npmrc",".pypirc","credentials.json","credentials.yml","secrets.json"}
SENSITIVE_DIRS={"secrets","credentials"}
def safe_path(p):
    x=(ROOT/p).resolve() if not os.path.isabs(p) else Path(p).resolve()
    if not str(x).startswith(str(ROOT)+os.sep): raise RuntimeError("path outside ACEP root")
    if any(part in x.parts for part in ("LudoMada",".ludomada-agent")): raise RuntimeError("protected path")
    if x.name in SENSITIVE_NAMES or any(part in SENSITIVE_DIRS for part in x.parts): raise RuntimeError("secret material access blocked")
    return x

TOOLS=[
{"type":"function","function":{"name":"read_file","description":"Read a text file in the ACEP repository.","parameters":{"type":"object","properties":{"path":{"type":"string"},"start":{"type":"integer"},"length":{"type":"integer"}},"required":["path"]}}},
{"type":"function","function":{"name":"write_file","description":"Write or append a text file in the ACEP repository.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"},"mode":{"type":"string","enum":["rewrite","append"]}},"required":["path","content"]}}},
{"type":"function","function":{"name":"run_command","description":"Run a repository command for inspection, editing, testing or validation. Working directory is ACEP root.","parameters":{"type":"object","properties":{"command":{"type":"string"},"timeout":{"type":"integer"}},"required":["command"]}}},
{"type":"function","function":{"name":"git_status","description":"Return git status and diff check for ACEP.","parameters":{"type":"object","properties":{}}}}]
def tool(name,args,command_cache=None,workspace_generation=0):
    if name=="read_file":
        p=safe_path(args["path"]); text=p.read_text(encoding="utf-8")
        lines=text.splitlines(); start=max(0,int(args.get("start",0))); length=min(500,int(args.get("length",120)))
        return "\n".join(f"{i+1}: {lines[i]}" for i in range(start,min(len(lines),start+length)))
    if name=="write_file":
        if os.environ.get("ACEP_READ_ONLY")=="1":
            raise RuntimeError("read-only role review")
        p=safe_path(args["path"]); p.parent.mkdir(parents=True,exist_ok=True)
        mode=args.get("mode","rewrite")
        if mode=="append":
            with p.open("a",encoding="utf-8") as f: f.write(args["content"])
        else:
            fd,tmp=tempfile.mkstemp(prefix=".acep-write-",dir=str(p.parent),text=True)
            try:
                with os.fdopen(fd,"w",encoding="utf-8") as f:
                    f.write(args["content"]); f.flush(); os.fsync(f.fileno())
                os.replace(tmp,p)
            finally:
                if os.path.exists(tmp): os.unlink(tmp)
        return {"ok":True,"path":str(p.relative_to(ROOT)),"mode":mode,"workspace_changed":True}
    if name=="git_status":
        a=subprocess.run(["git","status","--short"],cwd=ROOT,text=True,capture_output=True,timeout=30)
        b=subprocess.run(["git","diff","--check"],cwd=ROOT,text=True,capture_output=True,timeout=30)
        return {"status":a.stdout[-6000:],"diff_check_exit":b.returncode,"diff_check":b.stdout+b.stderr}
    if name=="run_command":
        cmd=args["command"]
        lowered=cmd.lower()
        command_cache=command_cache if command_cache is not None else {}
        import re
        expensive=bool(re.search(r"(^|[ 	])(npm[ ]+test|node[ ]+scripts/test-coverage[.]js|python3[ ]+tests/.*[.]py)([ 	]|$)",cmd))
        cache_key=(workspace_generation,hashlib.sha256(cmd.encode()).hexdigest()[:16])
        if expensive and cache_key in command_cache:
            cached=dict(command_cache[cache_key]); cached["cached"]=True
            return cached
        if any(x in cmd for x in ("git reset --hard","git clean -fd","rm -rf /","rm -rf LudoMada",".ludomada-agent")):
            raise RuntimeError("forbidden destructive/protected command")
        secret_patterns=(
            ".env", "proc/self/environ", "/.bankr/", "bankr/config.json",
            "printenv", " env", "api_key", "access_token", "client_secret"
        )
        if any(x in lowered for x in secret_patterns):
            raise RuntimeError("secret-material access blocked")
        lexer=shlex.shlex(cmd,posix=True,punctuation_chars=";&|><")
        lexer.whitespace_split=True
        argv=list(lexer)
        shell_tokens={";","&&","||","|","&",">",">>","<","<<"}
        if not argv:
            raise RuntimeError("empty command")
        if any(tok in shell_tokens for tok in argv):
            raise RuntimeError("shell operators are not allowed; use separate tool calls")
        executable=os.path.basename(argv[0])
        allowed_executables={
            "python3","python","node","npm","git","grep","rg","find","sed","awk",
            "cat","head","tail","cut","sort","uniq","wc","printf","pwd","ls",
            "stat","test"
        }
        if executable not in allowed_executables:
            raise RuntimeError("command executable not allowed")
        if os.environ.get("ACEP_READ_ONLY")=="1":
            blocked_tokens=("rm ","mv ","cp ","touch ","tee ","git checkout","git reset","git clean","git commit","git push",
                            "npm install","npm ci","pip install","curl -o","wget "," >"," >>","; rm","; mv","; cp")
            if any(x in cmd for x in blocked_tokens):
                raise RuntimeError("read-only role command blocked")
        requested=min(300,max(1,int(args.get("timeout",120))))
        global_deadline=float(os.environ.get("ACEP_AGENT_DEADLINE","0") or 0)
        remaining=(global_deadline-time.time()) if global_deadline else requested
        t=max(1,min(requested,int(max(1,remaining))))
        started_tool=time.time()
        p=subprocess.Popen(argv,cwd=ROOT,text=True,
                           stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                           start_new_session=True)
        try:
            out,err=p.communicate(timeout=t)
            rc=p.returncode
        except subprocess.TimeoutExpired as e:
            try:
                os.killpg(p.pid,signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                out,err=p.communicate(timeout=3)
            except Exception:
                out,err=getattr(e,"stdout","") or "",getattr(e,"stderr","") or ""
            rc=124
        result={"exit":rc,"stdout":(out or "")[-8000:],"stderr":(err or "")[-5000:],"duration_s":round(time.time()-started_tool,2),"cached":False,"command_hash":cache_key[1]}
        if expensive:
            command_cache[cache_key]=dict(result)
        return result
    raise RuntimeError("unknown tool "+name)

MODEL_FALLBACKS={
    "qwen3.8-flash":"deepseek-v4.1-flash",
    "deepseek-v4.1-flash":"deepseek-v4-pro",
}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--model",required=True); ap.add_argument("--phase",required=True)
    ap.add_argument("--prompt",required=True); ap.add_argument("--timeout",type=int,default=900)
    args=ap.parse_args(); started=time.time(); deadline=started+max(1,args.timeout)
    os.environ["ACEP_AGENT_DEADLINE"]=str(deadline)
    configured_steps=int(os.environ.get("ACEP_MAX_TOOL_STEPS","80"))
    adaptive_steps=max(80,args.timeout//5)
    max_steps=max(30,configured_steps,adaptive_steps)
    phase_progress=ROOT/"runtime"/f"agent-progress-{args.phase}.json"
    journal=ROOT/"runtime"/f"agent-progress-{args.phase}.jsonl"
    def progress(step, event, detail="",model_name=None):
        payload={"phase":args.phase,"model":model_name or active_model,"attempt_id":os.environ.get("ACEP_ATTEMPT_ID"),
                 "step":step,"max_steps":max_steps,"event":event,"detail":detail[:500],"updated":time.time()}
        tmp=phase_progress.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(payload),encoding="utf-8"); os.replace(tmp,phase_progress)
            with journal.open("a",encoding="utf-8") as jf:
                jf.write(json.dumps(payload,ensure_ascii=False)+"\n"); jf.flush()
        except Exception: pass
    system=("You are ACEP's repository execution agent. Work directly through the provided tools. "
            "Inspect before editing. Never touch LudoMada or .ludomada-agent. "
            "Make real changes, run tests, inspect failures, correct them, and verify git diff --check. "
            "Do not fabricate evidence. Reuse successful expensive test/coverage results when the workspace has not changed; "
            "do not rerun an identical expensive command unless a write changed the workspace or the prior result failed. "
            "Once the acceptance criteria, required tests, coverage and security evidence are already passing and no further "
            "code change is required, stop using tools and emit the completion token immediately. "
            "Only when the phase is genuinely complete and validated, include the exact token PHASE_COMPLETE:"+args.phase+" in your final response.")
    messages=[{"role":"system","content":system},{"role":"user","content":args.prompt}]
    seen_calls={}
    expensive_cache={}
    workspace_generation=0
    active_model=args.model
    fallback_visited={active_model}
    progress(0,"START",model_name=active_model)
    for step in range(max_steps):
        if not lease_guard(args.phase):
            progress(step,"LEASE_FENCE","lease no longer valid")
            print("BANKR_AGENT_ERROR: lease fence lost",file=sys.stderr,flush=True)
            return 7
        remaining=deadline-time.time()
        progress(step,"MODEL_CALL",model_name=active_model)
        model_started=time.time()
        if remaining <= 0:
            print("BANKR_AGENT_ERROR: overall timeout",file=sys.stderr); return 124
        try:
            data=call(active_model,messages,TOOLS,timeout=max(1,min(30,int(remaining))),deadline=deadline,phase=args.phase,attempt_id=os.environ.get("ACEP_ATTEMPT_ID"))
        except BankrError as e:
            err_text=str(e)
            progress(step,"MODEL_ERROR",f"elapsed={time.time()-model_started:.1f}s error={err_text[:180]}",model_name=active_model)
            fallback=MODEL_FALLBACKS.get(active_model)
            if (fallback and fallback not in fallback_visited and "HTTP 429" in err_text and
                    deadline-time.time() > 5):
                fallback_visited.add(fallback)
                progress(step,"MODEL_FALLBACK",f"{active_model}->{fallback}",model_name=fallback)
                active_model=fallback
                try:
                    data=call(active_model,messages,TOOLS,timeout=max(1,min(30,int(deadline-time.time()))),deadline=deadline,phase=args.phase,attempt_id=os.environ.get("ACEP_ATTEMPT_ID"))
                except BankrError as e2:
                    print(json.dumps({"ok":False,"phase":args.phase,"model":active_model,
                                      "primary_model":args.model,"error":str(e2),"elapsed":round(time.time()-started,2)}),file=sys.stderr,flush=True)
                    return 75
            else:
                print(json.dumps({"ok":False,"phase":args.phase,"model":active_model,
                                  "error":err_text,"elapsed":round(time.time()-started,2)}),file=sys.stderr,flush=True)
                return 75
        progress(step,"MODEL_RESULT",f"elapsed={time.time()-model_started:.1f}s",model_name=active_model)
        budget_usage=data.get("_acep_budget")
        if budget_usage:
            progress(step,"BUDGET_USAGE",json.dumps(budget_usage,separators=(",",":")),model_name=active_model)
        msg=data["choices"][0]["message"]; messages.append(msg)
        calls=msg.get("tool_calls") or []
        if not calls:
            content=msg.get("content") or ""
            print(content,flush=True)
            print(json.dumps({"ok":True,"phase":args.phase,"model":data.get("model",args.model),
                              "steps":step+1,"elapsed":round(time.time()-started,2),
                              "complete_token":("PHASE_COMPLETE:"+args.phase) in content}),
                  file=sys.stderr,flush=True)
            return 0
        for tc in calls:
            name=tc["function"]["name"]
            raw_args=tc["function"].get("arguments","{}")
            signature=name+"|"+raw_args
            seen_calls[signature]=seen_calls.get(signature,0)+1
            if seen_calls[signature] > 4:
                progress(step,"LOOP_GUARD",name,model_name=active_model)
                print(json.dumps({"ok":False,"phase":args.phase,"model":args.model,
                                  "error":"repeated identical tool call","tool":name,"step":step}),file=sys.stderr,flush=True)
                return 23
            progress(step,"TOOL_CALL",name,model_name=active_model)
            if not lease_guard(args.phase):
                progress(step,"LEASE_FENCE","lease no longer valid before tool")
                print("BANKR_AGENT_ERROR: lease fence lost",file=sys.stderr,flush=True)
                return 7
            try: result=tool(name,json.loads(raw_args),expensive_cache,workspace_generation)
            except Exception as e: result={"error":type(e).__name__+": "+str(e)}
            if isinstance(result,dict) and result.get("workspace_changed"):
                workspace_generation += 1
            if isinstance(result,dict) and "duration_s" in result:
                progress(step,"TOOL_RESULT",f"{name} duration={result['duration_s']}s exit={result.get('exit')} cached={result.get('cached',False)} hash={result.get('command_hash','')}",model_name=active_model)
            elif isinstance(result,str):
                progress(step,"TOOL_RESULT",f"{name} result=string len={len(result)}",model_name=active_model)
            messages.append({"role":"tool","tool_call_id":tc["id"],"content":json.dumps(result,ensure_ascii=False)})
    progress(max_steps,"LOOP_LIMIT")
    print(json.dumps({"ok":False,"phase":args.phase,"model":args.model,
                      "error":"tool loop limit reached","max_steps":max_steps}),file=sys.stderr,flush=True)
    return 22

if __name__=="__main__":
    raise SystemExit(main())
