#!/usr/bin/env python3
import json, os, subprocess, time
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def run():
    p=subprocess.run(['python3',os.path.join(ROOT,'agents','agent.py')],cwd=ROOT,text=True,capture_output=True,timeout=30)
    if p.returncode:
        raise RuntimeError(p.stderr[-3000:])
    data=json.loads(p.stdout)
    return {'ts':time.time(),'verdict':'REVIEW_READY','issues':[],'type':'local-role-evidence','roles':data['roles'],'evidence':data['evidence'],
            'note':'This module reports observations only; it never authorizes phase promotion.'}

if __name__=='__main__': print(json.dumps(run(),indent=2,ensure_ascii=False))
