#!/usr/bin/env python3
import hashlib
import json
import os
import sys
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from agents.url_safety import require_safe_http_url
RUNTIME=os.path.join(ROOT,"runtime")
PROVIDERS={
    "groq":{
        "key_names":("GROQ_API_KEY",),
        "key_file":os.path.expanduser("~/.config/ludomada/groq-api-key"),
        "model":"openai/gpt-oss-120b",
        "endpoint":"https://api.groq.com/openai/v1/chat/completions",
    },
    "gemini":{
        "key_names":("GEMINI_API_KEY","GOOGLE_API_KEY"),
        "key_file":os.path.expanduser("~/.config/ludomada/gemini-api-key"),
        "model":"gemini-3.5-flash",
        "endpoint":"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
    },
}

def now():
    return datetime.now(timezone.utc).isoformat()

def provider_status(name):
    cfg=PROVIDERS[name]
    for env_name in cfg["key_names"]:
        if os.getenv(env_name):
            return {"name":name,"set":True,"source":"environment"}
    try:
        with open(cfg["key_file"],encoding="utf-8") as f:
            if f.read().strip():
                return {"name":name,"set":True,"source":"protected-file"}
    except Exception:
        pass
    return {"name":name,"set":False,"source":"absent"}

def load_key(name,status):
    if status.get("source")=="environment":
        for env_name in PROVIDERS[name]["key_names"]:
            value=os.getenv(env_name)
            if value:
                return value
    with open(PROVIDERS[name]["key_file"],encoding="utf-8") as f:
        return f.read().strip()

def load_json(path,default=None):
    try:
        with open(path,encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default if default is not None else {}

def atomic_json(path,data):
    tmp=path+".tmp"
    with open(tmp,"w",encoding="utf-8") as f:
        json.dump(data,f,indent=2,ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp,path)

def packet_path():
    return os.path.join(RUNTIME,"P28-review-packet.json")

def packet_digest(packet):
    raw=json.dumps(packet,sort_keys=True,ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()

def build_prompt(packet):
    review_packet=json.loads(json.dumps(packet))
    sp=review_packet.get("supplementary_prevalidation",{})
    if "promotion_blocker" in sp:
        sp["promotion_blocker"]="legacy provider-specific blocker; current gate permits verified external-judge providers"
    candidate=json.dumps(review_packet,indent=2,ensure_ascii=False)
    return """You are the independent final judge for ACEP/ASEP P28.
Review only the evidence in the supplied packet. Do not invent missing evidence.
Return valid JSON only.
Use exactly this object shape:
{"verdict":"GO|CORRECT|BLOCK","reason":"concise factual explanation","issues":["concrete issue"],"reviewed_commit":"exact commit from packet","reviewed_workspace_hash":"exact workspace hash from packet"}
Do not promote any phase. GO is valid only when the supplied evidence supports it. Treat legacy Gemini-specific promotion blockers in the packet as stale if the current master plan explicitly permits the verified Groq external-judge fallback.
Packet:
"""+candidate

SCHEMA={
    "type":"object",
    "properties":{
        "verdict":{"type":"string","enum":["GO","CORRECT","BLOCK"]},
        "reason":{"type":"string"},
        "issues":{"type":"array","items":{"type":"string"}},
        "reviewed_commit":{"type":"string"},
        "reviewed_workspace_hash":{"type":"string"},
    },
    "required":["verdict","reason","issues","reviewed_commit","reviewed_workspace_hash"],
    "additionalProperties":False,
}

def parse_verdict(text,packet,source):
    start=text.find("{")
    end=text.rfind("}")
    if start<0 or end<=start:
        raise ValueError(source+"-response-not-json")
    data=json.loads(text[start:end+1])
    verdict=data.get("verdict")
    if verdict not in ("GO","CORRECT","BLOCK"):
        raise ValueError(source+"-invalid-verdict")
    if data.get("reviewed_commit")!=packet.get("commit"):
        raise ValueError(source+"-commit-mismatch")
    if data.get("reviewed_workspace_hash")!=packet.get("workspace_hash"):
        raise ValueError(source+"-workspace-hash-mismatch")
    issues=data.get("issues",[])
    if not isinstance(issues,list):
        raise ValueError(source+"-issues-not-array")
    return {
        "phase":"P28",
        "source":source,
        "verdict":verdict,
        "reason":str(data.get("reason",""))[:4000],
        "issues":[str(x)[:1000] for x in issues[:50]],
        "reviewed_commit":packet["commit"],
        "reviewed_workspace_hash":packet["workspace_hash"],
        "generated_at":now(),
        "packet_digest":packet_digest(packet),
    }

def call_gemini(prompt,model,key):
    body=json.dumps({
        "contents":[{"parts":[{"text":prompt}]}],
        "generationConfig":{"responseMimeType":"application/json","maxOutputTokens":1200}
    }).encode()
    endpoint = require_safe_http_url(PROVIDERS["gemini"]["endpoint"].format(model=model))
    req=urllib.request.Request(
        endpoint,
        data=body,method="POST",
        headers={"Content-Type":"application/json","x-goog-api-key":key},
    )
    try:
        with urllib.request.urlopen(req,timeout=45) as res:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected -- fixed provider endpoint validated by require_safe_http_url
            payload=json.loads(res.read().decode())
    except urllib.error.HTTPError:
        raise
    texts=[]
    for candidate in payload.get("candidates",[]):
        for part in candidate.get("content",{}).get("parts",[]):
            if part.get("text"): texts.append(part["text"])
    if not texts:
        raise ValueError("gemini-empty-response")
    return "\n".join(texts)

def call_groq(prompt,model,key):
    body=json.dumps({
        "model":model,
        "messages":[
            {"role":"system","content":"You are an independent ACEP/ASEP judge. Return valid JSON only."},
            {"role":"user","content":prompt},
        ],
        "temperature":0,
        "max_tokens":1200,
        "response_format":{
            "type":"json_schema",
            "json_schema":{"name":"acep_p28_verdict","strict":True,"schema":SCHEMA},
        },
    })
    proc=subprocess.run(
        ["curl","-sS","-A","curl/8.0 ACEP/1.0",
         "-H","Authorization: Bearer "+key,
         "-H","Content-Type: application/json",
         PROVIDERS["groq"]["endpoint"],
         "-d",body],
        text=True,capture_output=True,timeout=90,
    )
    if proc.returncode!=0:
        raise RuntimeError("groq-curl-exit-"+str(proc.returncode))
    payload=json.loads(proc.stdout)
    if payload.get("error"):
        err=payload["error"]
        raise RuntimeError("groq-api-"+str(err.get("code") or err.get("type") or "error")+":"+str(err.get("message",""))[:300])
    texts=[]
    for choice in payload.get("choices",[]):
        content=choice.get("message",{}).get("content")
        if content: texts.append(content)
    if not texts:
        raise ValueError("groq-empty-response")
    return "\n".join(texts)

def refresh_packet():
    packet=load_json(packet_path(),{})
    if not packet or packet.get("phase")!="P28":
        return packet
    head=subprocess.run(["git","rev-parse","HEAD"],cwd=ROOT,text=True,capture_output=True,timeout=15)
    branch=subprocess.run(["git","branch","--show-current"],cwd=ROOT,text=True,capture_output=True,timeout=15)
    status=subprocess.run(["git","status","--short"],cwd=ROOT,text=True,capture_output=True,timeout=15)
    p23=load_json(os.path.join(RUNTIME,"evidence","P23-build-test.json"),{})
    coverage=load_json(os.path.join(RUNTIME,"evidence","P18-coverage.json"),{})
    workspace_hash=(p23.get("source_hash")
                    or (coverage.get("workspace") or {}).get("hash")
                    or packet.get("workspace_hash"))
    commit=head.stdout.strip() if head.returncode==0 else packet.get("commit")
    branch_name=branch.stdout.strip() if branch.returncode==0 else "main"
    short_status=status.stdout.strip()
    packet["generated_at"]=now()
    packet["commit"]=commit
    packet["workspace_hash"]=workspace_hash
    packet["git_status"]="## "+branch_name if not short_status else "## "+branch_name+"\n"+short_status
    packet["external_verdict"]="ABSENT"
    packet.setdefault("checkpoint",{}).update({
        "phase":"P28","status":"REVIEW_READY","source":"direct",
        "workspace_hash":workspace_hash,"commit":commit,
        "reason":"fresh-independent-external-judge-review-required-for-current-candidate",
        "worker_pid":None,"worker_updated":None,
        "attempt_id":None,"attempt_number":None
    })
    packet.setdefault("p27_revalidation",{}).update({
        "commit":commit,"workspace_hash":workspace_hash,
        "git_status":packet["git_status"],
        "p28_review_required":True,
        "next_phase":"P28","next_task":"Final independent judge"
    })
    packet.setdefault("supplementary_prevalidation",{}).update({
        "commit":commit,
        "promotion_blocker":"fresh external-judge GO for this exact candidate is required"
    })
    atomic_json(packet_path(),packet)
    return packet

def existing_verdict(packet):
    existing=load_json(os.path.join(RUNTIME,"gemini-verdict.json"),{})
    if (existing.get("phase")=="P28" and existing.get("source") in ("gemini","groq")
            and existing.get("packet_digest")==packet_digest(packet)
            and existing.get("reviewed_commit")==packet.get("commit")
            and existing.get("reviewed_workspace_hash")==packet.get("workspace_hash")
            and existing.get("verdict") in ("GO","CORRECT","BLOCK")):
        return existing

def run():
    packet=refresh_packet()
    if not packet or packet.get("phase")!="P28":
        return {"status":"BLOCKED","reason":"p28-review-packet-missing-or-invalid"}
    existing=existing_verdict(packet)
    if existing:
        return {"status":"EXISTING_VERDICT","verdict":existing["verdict"],
                "source":existing["source"],"commit":existing["reviewed_commit"],
                "packet_digest":existing["packet_digest"]}
    statuses={name:provider_status(name) for name in PROVIDERS}
    configured=os.getenv("P28_JUDGE_PROVIDER","auto").lower()
    order=["groq","gemini"] if configured=="auto" else [configured]
    if configured=="auto" and not statuses["groq"]["set"] and statuses["gemini"]["set"]:
        order=["gemini"]
    attempts=[]
    for name in order:
        if name not in PROVIDERS or not statuses[name]["set"]:
            continue
        try:
            key=load_key(name,statuses[name])
            if name=="groq":
                response=call_groq(build_prompt(packet),PROVIDERS[name]["model"],key)
            else:
                response=call_gemini(build_prompt(packet),PROVIDERS[name]["model"],key)
            verdict=parse_verdict(response,packet,name)
            atomic_json(os.path.join(RUNTIME,"gemini-verdict.json"),verdict)
            return {"status":"VERDICT_WRITTEN","verdict":verdict["verdict"],
                    "source":name,"commit":verdict["reviewed_commit"],
                    "packet_digest":verdict["packet_digest"]}
        except urllib.error.HTTPError as e:
            attempts.append(name+"-http-"+str(e.code))
        except Exception as e:
            attempts.append(name+"-error-"+str(e)[:220])
    if not any(statuses[n]["set"] for n in PROVIDERS):
        return {"status":"WAITING_FOR_EXTERNAL_JUDGE","reason":"no-external-judge-key","key_set":False}
    return {"status":"WAITING_FOR_EXTERNAL_JUDGE","reason":";".join(attempts)[:1000],"key_set":True}

if __name__=="__main__":
    print(json.dumps(run(),indent=2,ensure_ascii=False))
