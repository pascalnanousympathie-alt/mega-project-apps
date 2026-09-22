#!/usr/bin/env python3
import json, os, subprocess, time

ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROLES={
  'project_manager': {'focus':'scope, milestones, dependencies, blockers', 'model':'qwen3.8-flash', 'mode':'routine'},
  'senior_developer': {'focus':'architecture, code quality, tests, correctness', 'model':'deepseek-v4.1-flash', 'mode':'coding'},
  'devops': {'focus':'runtime, processes, builds, CI, deployment', 'model':'qwen3.8-flash', 'mode':'routine'},
  'security': {'focus':'secrets, auth, validation, abuse, supply chain', 'model':'deepseek-v4-pro', 'mode':'escalation'},
}

def snapshot():
    out={}
    try:
        out['git']=subprocess.check_output(['git','status','--short'],cwd=ROOT,text=True,stderr=subprocess.STDOUT,timeout=8)
        out['git_repo']=True
    except Exception as e:
        out['git']=f'ERROR: {e}'
        out['git_repo']=False
    try:
        files=[]
        for base,dirs,names in os.walk(ROOT):
            rel=os.path.relpath(base,ROOT)
            depth=0 if rel=='.' else rel.count(os.sep)+1
            if depth>2:
                dirs[:] = []
                continue
            dirs[:] = sorted(d for d in dirs if d not in {'.git','node_modules','runtime','__pycache__'})
            for name in sorted(names):
                path=os.path.join(base,name)
                files.append('./'+os.path.relpath(path,ROOT))
                if len(files)>=120:
                    break
            if len(files)>=120:
                break
        out['files']='\n'.join(files)
    except Exception as e:
        out['files']=f'ERROR: {e}'
    return out

def main():
    state=snapshot()
    print(json.dumps({'ts':time.time(),'gateway':'Bankr LLM Gateway','roles':ROLES,'evidence':state},indent=2,ensure_ascii=False))

if __name__=='__main__': main()
