#!/usr/bin/env python3
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME=os.path.join(ROOT,"runtime")
KEY_NAMES=("GEMINI_API_KEY","GOOGLE_API_KEY")
KEY_FILE=os.path.expanduser("~/.config/ludomada/gemini-api-key")
DEFAULT_MODEL="gemini-2.5-pro"
ENDPOINT="https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

def now():
    return datetime.now(timezone.utc).isoformat()

def key_status():
    for name in KEY_NAMES:
        value=os.getenv(name)
        if value:
            return {"name":name,"set":True,"source":"environment"}
    try:
        with open(KEY_FILE,encoding="utf-8") as f:
            value=f.read().strip()
        if value:
            return {"name":"GEMINI_API_KEY","set":True,"source":"protected-file"}
    except Exception:
        pass
    return {"name":"GEMINI_API_KEY","set":False,"source":"absent"}

def load_key(status):
    if status.get("source")=="environment":
        return os.getenv(status["name"])
    with open(KEY_FILE,encoding="utf-8") as f:
        return f.read().strip()

def load_json(path, default=None):
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
    candidate=json.dumps(packet,indent=2,ensure_ascii=False)
    return """You are the independent final judge for ACEP/ASEP P28.
Review only the evidence in the supplied packet. Do not invent missing evidence.
Return exactly one JSON object with these keys:
verdict: one of GO, CORRECT, BLOCK
reason: concise factual explanation
issues: array of concrete issues
reviewed_commit: exact commit from packet
reviewed_workspace_hash: exact workspace hash from packet
Do not promote any phase. GO is valid only when the supplied evidence supports it.
Packet:
"""+candidate

def parse_verdict(text,packet):
    start=text.find("{")
    end=text.rfind("}")
    if start<0 or end<=start:
        raise ValueError("gemini-response-not-json")
    data=json.loads(text[start:end+1])
    verdict=data.get("verdict")
    if verdict not in ("GO","CORRECT","BLOCK"):
        raise ValueError("gemini-invalid-verdict")
    if data.get("reviewed_commit")!=packet.get("commit"):
        raise ValueError("gemini-commit-mismatch")
    if data.get("reviewed_workspace_hash")!=packet.get("workspace_hash"):
        raise ValueError("gemini-workspace-hash-mismatch")
    issues=data.get("issues",[])
    if not isinstance(issues,list):
        raise ValueError("gemini-issues-not-array")
    return {
        "phase":"P28",
        "source":"gemini",
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
        "generationConfig":{
            "responseMimeType":"application/json",
            "maxOutputTokens":1200
        }
    }).encode()
    req=urllib.request.Request(
        ENDPOINT.format(model=model),
        data=body,
        method="POST",
        headers={"Content-Type":"application/json","x-goog-api-key":key},
    )
    last_error=None
    for delay in (0,2,4):
        if delay:
            time.sleep(delay)
        try:
            with urllib.request.urlopen(req,timeout=90) as res:
                payload=json.loads(res.read().decode())
            break
        except urllib.error.HTTPError as exc:
            last_error=exc
            if exc.code != 503 or delay == 4:
                raise
    else:
        raise last_error
    texts=[]
    for candidate in payload.get("candidates",[]):
        for part in candidate.get("content",{}).get("parts",[]):
            if part.get("text"):
                texts.append(part["text"])
    if not texts:
        raise ValueError("gemini-empty-response")
    return "\n".join(texts)
def run():
    packet=load_json(packet_path(),{})
    existing=load_json(os.path.join(RUNTIME,"gemini-verdict.json"),{})
    if (existing.get("phase")=="P28" and existing.get("source")=="gemini"
            and existing.get("packet_digest")==packet_digest(packet)
            and existing.get("reviewed_commit")==packet.get("commit")
            and existing.get("reviewed_workspace_hash")==packet.get("workspace_hash")
            and existing.get("verdict") in ("GO","CORRECT","BLOCK")):
        return {"status":"EXISTING_VERDICT","verdict":existing.get("verdict"),
                "commit":existing.get("reviewed_commit"),
                "packet_digest":existing.get("packet_digest")}
    key=key_status()
    if not packet or packet.get("phase")!="P28":
        return {"status":"BLOCKED","reason":"p28-review-packet-missing-or-invalid","key_set":key["set"]}
    if not key["set"]:
        return {"status":"WAITING_FOR_GEMINI","reason":"GEMINI_API_KEY_ABSENT","key_set":False,
                "packet_digest":packet_digest(packet)}
    try:
        secret=load_key(key)
        response=call_gemini(build_prompt(packet),DEFAULT_MODEL,secret)
        verdict=parse_verdict(response,packet)
        atomic_json(os.path.join(RUNTIME,"gemini-verdict.json"),verdict)
        return {"status":"VERDICT_WRITTEN","verdict":verdict["verdict"],
                "commit":verdict["reviewed_commit"],"packet_digest":verdict["packet_digest"]}
    except urllib.error.HTTPError as e:
        try:
            body=e.read().decode(errors="replace")
            payload=json.loads(body)
            err=payload.get("error",{})
            detail=str(err.get("status") or err.get("message") or "http-error")[:300]
        except Exception:
            detail="http-error"
        return {"status":"WAITING_FOR_GEMINI","reason":"gemini-http-"+str(e.code)+":"+detail,
                "key_set":True}
    except Exception as e:
        return {"status":"WAITING_FOR_GEMINI","reason":"gemini-error-"+str(e)[:300],
                "key_set":True}

if __name__=="__main__":
    print(json.dumps(run(),indent=2,ensure_ascii=False))
