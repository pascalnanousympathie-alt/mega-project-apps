#!/usr/bin/env python3
import json, os, urllib.request, urllib.error, ssl
from typing import Any

BASE_URL = os.environ.get('BANKR_BASE_URL', 'https://llm.bankr.bot/v1').rstrip('/')
CONFIG = os.path.expanduser('~/.bankr/config.json')

class BankrError(RuntimeError):
    pass

def _key() -> str:
    try:
        with open(CONFIG, encoding='utf-8') as f:
            data=json.load(f)
        key=data.get('apiKey')
    except Exception as e:
        raise BankrError(f'Bankr config unavailable: {type(e).__name__}') from e
    if not isinstance(key,str) or not key:
        raise BankrError('Bankr API key absent')
    return key

def chat(model: str, prompt: str, *, max_tokens: int=900, temperature: float=0.1, timeout: int=120) -> dict[str, Any]:
    body={
        'model': model,
        'messages':[{'role':'user','content':prompt}],
        'max_tokens': max_tokens,
        'temperature': temperature,
    }
    req=urllib.request.Request(
        BASE_URL + '/chat/completions',
        data=json.dumps(body).encode('utf-8'),
        headers={'Authorization': 'Bearer ' + _key(), 'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context()) as resp:
            raw=resp.read().decode('utf-8')
            data=json.loads(raw)
            choices=data.get('choices') or []
            content=''
            if choices:
                msg=choices[0].get('message') or {}
                c=msg.get('content','')
                content=c if isinstance(c,str) else json.dumps(c,ensure_ascii=False)
            return {
                'ok': True,
                'model': data.get('model', model),
                'content': content,
                'usage': data.get('usage', {}),
                'id': data.get('id'),
            }
    except urllib.error.HTTPError as e:
        detail=''
        try: detail=e.read().decode('utf-8')[-1200:]
        except Exception: pass
        raise BankrError(f'HTTP {e.code}: {detail}') from e
    except urllib.error.URLError as e:
        raise BankrError(f'Network error: {e.reason}') from e
