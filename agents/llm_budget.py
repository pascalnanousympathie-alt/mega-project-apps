#!/usr/bin/env python3
import json, os, time, tempfile, urllib.request
from pathlib import Path
from agents.url_safety import require_safe_http_url

ROOT=Path(__file__).resolve().parents[1]
BASE=os.environ.get("BANKR_BASE_URL","https://llm.bankr.bot/v1").rstrip("/")
CONFIG=Path.home()/".bankr"/"config.json"
def _env_float(name,default):
    try: return max(0.0,float(os.environ.get(name,str(default))))
    except Exception: return float(default)
PRICE_CACHE={"at":0.0,"data":{}}
PRICE_TTL=300.0

class BudgetError(RuntimeError):
    pass

def _key():
    try:
        data=json.loads(CONFIG.read_text(encoding="utf-8"))
        key=data.get("apiKey")
    except Exception as e:
        raise BudgetError("BUDGET_AUTH_UNAVAILABLE:"+type(e).__name__) from e
    if not isinstance(key,str) or not key:
        raise BudgetError("BUDGET_AUTH_ABSENT")
    return key

def _get(path):
    endpoint = require_safe_http_url(BASE + path)
    req=urllib.request.Request(endpoint,headers={"Authorization":"Bearer "+_key()})
    try:
        with urllib.request.urlopen(req,timeout=10) as r:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- request URL passed through require_safe_http_url
            return json.load(r)
    except Exception as e:
        raise BudgetError("BUDGET_ENDPOINT_UNAVAILABLE:"+path+":"+type(e).__name__) from e

def credits():
    data=_get("/credits")
    bal=float(data.get("effectiveBalanceUsd",data.get("balanceUsd",0)))
    daily=data.get("dailyBudget")
    return data,bal

def pricing(model):
    if time.time()-PRICE_CACHE["at"]>PRICE_TTL:
        PRICE_CACHE["data"]={x.get("id"):x.get("pricing") or {} for x in _get("/models").get("data",[]) if x.get("id")}
        PRICE_CACHE["at"]=time.time()
    if model in PRICE_CACHE["data"]:
        price=PRICE_CACHE["data"][model]
        vals=(float(price.get("input",0)),float(price.get("output",0)),float(price.get("cache_read",0)),float(price.get("cache_write",0)))
        if vals[0]<=0 and vals[1]<=0: raise BudgetError("MODEL_PRICE_INVALID:"+model)
        return vals
    data=_get("/models")
    for item in data.get("data",[]):
        if item.get("id")==model:
            price=item.get("pricing") or {}
            vals=(float(price.get("input",0)),float(price.get("output",0)),float(price.get("cache_read",0)),float(price.get("cache_write",0)))
            if vals[0]<=0 and vals[1]<=0: raise BudgetError("MODEL_PRICE_INVALID:"+model)
            return vals
    raise BudgetError("MODEL_PRICE_UNAVAILABLE:"+model)
def _state_path(phase):
    return ROOT/"runtime"/f"llm-budget-{phase}.json"

def _load_state(phase):
    p=_state_path(phase)
    if not p.exists():
        return {"phase":phase,"attempt_id":None,"spent_usd":0.0,"requests":0,"updated":time.time()}
    try:
        data=json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data,dict) or data.get("phase")!=phase:
            raise ValueError("budget-state-schema")
        return data
    except Exception as e:
        raise BudgetError("BUDGET_STATE_CORRUPT:"+type(e).__name__) from e

def _save_state(phase,data):
    p=_state_path(phase); p.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix=p.name+".",dir=str(p.parent),text=True)
    try:
        with os.fdopen(fd,"w",encoding="utf-8") as f:
            json.dump(data,f,indent=2); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,p)
        dfd=os.open(str(p.parent),os.O_RDONLY)
        try: os.fsync(dfd)
        finally: os.close(dfd)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def _token_count(value):
    try: return int(value or 0)
    except Exception: return 0

def estimate_input_tokens(messages):
    try:
        raw=json.dumps(messages,ensure_ascii=False,separators=(",",":"))
        return max(1,len(raw)//4)
    except Exception:
        return 1

def estimate_cost(model,messages,max_tokens):
    inp,out,_,_=pricing(model)
    return (estimate_input_tokens(messages)*inp + int(max_tokens)*out)/1_000_000
def before_request(phase,attempt_id,model,messages,max_tokens):
    data,balance=credits()
    state=_load_state(phase)
    if state.get("phase")!=phase:
        raise BudgetError("BUDGET_STATE_PHASE_MISMATCH")
    state["last_attempt_id"]=attempt_id
    if state.get("attempt_id") is None:
        state["attempt_id"]=attempt_id
    projected=estimate_cost(model,messages,max_tokens)
    spent=float(state.get("spent_usd",0))
    # ACEP does not impose a local credit reserve or per-phase spend cap.
    # The provider remains authoritative for actual credit availability and
    # any provider-side account/daily limits. We only record estimates/usage.
    state.update({"balance_before":balance,"projected_usd":projected,"model":model,"updated":time.time()})
    _save_state(phase,state)
    return {"effective_balance_usd":balance,"projected_usd":projected,"daily_budget":data.get("dailyBudget"),"spent_usd":spent}

def _usage_int(usage,*keys):
    for key in keys:
        if key in usage: return _token_count(usage.get(key))
    return 0

def record_usage(phase,attempt_id,model,usage):
    u=usage or {}
    inp=_usage_int(u,"prompt_tokens","input_tokens","inputTokens")
    out=_usage_int(u,"completion_tokens","output_tokens","outputTokens")
    details=u.get("prompt_tokens_details") or u.get("input_tokens_details") or {}
    cached=_usage_int(details,"cached_tokens","cache_read_input_tokens","cacheReadInputTokens","cache_read")
    cache_write=_usage_int(details,"cache_write_input_tokens","cacheWriteInputTokens","cache_write")
    pi,po,pcr,pcw=pricing(model)
    uncached=max(0,inp-cached-cache_write)
    cost=(uncached*pi+cached*pcr+cache_write*pcw+out*po)/1_000_000
    state=_load_state(phase)
    if state.get("phase")!=phase: raise BudgetError("BUDGET_STATE_PHASE_MISMATCH")
    state["last_attempt_id"]=attempt_id
    if state.get("attempt_id") is None: state["attempt_id"]=attempt_id
    state["spent_usd"]=round(float(state.get("spent_usd",0))+cost,9)
    state["requests"]=int(state.get("requests",0))+1
    state.update({"last_cost_usd":cost,"last_usage":u,"last_model":model,"updated":time.time()})
    _save_state(phase,state)
    return {"input_tokens":inp,"output_tokens":out,"cache_read_tokens":cached,"cache_write_tokens":cache_write,"cost_usd":cost,"phase_spend_usd":state["spent_usd"]}
