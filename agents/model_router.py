#!/usr/bin/env python3
ROLE_MODELS={
  'project_manager':'qwen3.8-flash',
  'senior_developer':'deepseek-v4.1-flash',
  'devops':'qwen3.8-flash',
  'security':'deepseek-v4-pro',
}
# DeepSeek Flash is the default implementation/coding worker.
# DeepSeek Pro is reserved for explicit security phases or escalation after
# repeated unresolved execution attempts.
PHASE_ROUTES={
  'P04':'deepseek-v4.1-flash','P05':'deepseek-v4.1-flash','P06':'deepseek-v4.1-flash','P07':'deepseek-v4.1-flash',
  'P08':'deepseek-v4.1-flash','P09':'deepseek-v4.1-flash','P10':'deepseek-v4.1-flash','P11':'deepseek-v4.1-flash',
  'P12':'deepseek-v4.1-flash','P13':'deepseek-v4.1-flash','P14':'deepseek-v4.1-flash',
  'P15':'deepseek-v4.1-flash','P16':'deepseek-v4.1-flash','P17':'deepseek-v4.1-flash','P18':'deepseek-v4.1-flash','P19':'deepseek-v4.1-flash',
  'P20':'deepseek-v4-pro',
  'P21':'deepseek-v4.1-flash',
  'P22':'deepseek-v4-pro',
  'P23':'deepseek-v4.1-flash','P24':'deepseek-v4.1-flash','P25':'deepseek-v4.1-flash',
  'P26':'deepseek-v4-pro',
  'P27':'deepseek-v4.1-flash',
  'P28':'gemini-checkpoint-only',
  'P29':'deepseek-v4.1-flash','P30':'deepseek-v4.1-flash',
}

def model_for_phase(phase, override=None):
    return override or PHASE_ROUTES.get(phase,'deepseek-v4.1-flash')
