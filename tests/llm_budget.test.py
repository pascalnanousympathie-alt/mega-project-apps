import os,sys,tempfile,unittest
from pathlib import Path
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path: sys.path.insert(0,ROOT)
import agents.llm_budget as budget

class LlmBudget(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.old_state=budget._state_path
        self.old_credits=budget.credits
        self.old_pricing=budget.pricing
        budget._state_path=lambda phase: Path(self.tmp.name)/f"{phase}.json"
        budget.pricing=lambda model:(0.15,0.47,0.016,0.20)

    def tearDown(self):
        budget._state_path=self.old_state
        budget.credits=self.old_credits
        budget.pricing=self.old_pricing
        self.tmp.cleanup()

    def test_reserve_guard_fails_closed(self):
        budget.credits=lambda:({"dailyBudget":None},0.04)
        result=budget.before_request("P18","a1","qwen3.8-flash",[{"role":"user","content":"x"}],100)
        self.assertEqual(result["effective_balance_usd"],0.04)

    def test_daily_budget_guard(self):
        budget.credits=lambda:({"dailyBudget":{"exceeded":True}},1.0)
        result=budget.before_request("P18","a1","qwen3.8-flash",[{"role":"user","content":"x"}],100)
        self.assertTrue(result["daily_budget"]["exceeded"])
    def test_attempt_recovery_cannot_reset_phase_spend(self):
        budget.credits=lambda:({"dailyBudget":None},1.0)
        first=budget.before_request("P18","a1","qwen3.8-flash",[{"role":"user","content":"x"*400}],100)
        budget.record_usage("P18","a1","qwen3.8-flash",{"prompt_tokens":1,"completion_tokens":1000000})
        second=budget.before_request("P18","a2","qwen3.8-flash",[{"role":"user","content":"x"}],100)
        self.assertEqual(first["spent_usd"],0.0)
        self.assertGreater(second["spent_usd"],0.47)
        self.assertGreater(budget._load_state("P18")["spent_usd"],0.47)

    def test_record_usage_calculates_cached_cost(self):
        budget.credits=lambda:({"dailyBudget":None},1.0)
        budget.before_request("P18","a1","qwen3.8-flash",[{"role":"user","content":"x"}],100)
        rec=budget.record_usage("P18","a1","qwen3.8-flash",{
            "prompt_tokens":1000,"completion_tokens":100,
            "prompt_tokens_details":{"cached_tokens":400,"cache_write_input_tokens":100}
        })
        expected=((500*0.15)+(400*0.016)+(100*0.20)+(100*0.47))/1_000_000
        self.assertAlmostEqual(rec["cost_usd"],expected,places=9)
        self.assertEqual(rec["input_tokens"],1000)
        self.assertEqual(rec["cache_read_tokens"],400)

    def test_phase_budget_is_hard(self):
        budget.credits=lambda:({"dailyBudget":None},1.0)
        budget.before_request("P18","a1","qwen3.8-flash",[{"role":"user","content":"x"}],100)
        budget.record_usage("P18","a1","qwen3.8-flash",{"prompt_tokens":0,"completion_tokens":650000})
        result=budget.before_request("P18","a1","qwen3.8-flash",[{"role":"user","content":"x"}],1)
        self.assertGreater(result["spent_usd"],0.30)

if __name__=="__main__":
    unittest.main()
