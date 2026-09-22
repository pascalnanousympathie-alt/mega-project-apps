from pathlib import Path
import json, os, tempfile, time, unittest, sys, multiprocessing
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path: sys.path.insert(0, ROOT)
from supervisor.runtime_guard import atomic_json, load_json, acquire_lease, renew_lease, lease_valid, release_lease

class ReliabilityHardening(unittest.TestCase):
    def test_atomic_json_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            path=os.path.join(d,"state.json")
            atomic_json(path,{"phase":"P17","status":"RUNNING","n":1})
            self.assertEqual(load_json(path)["n"],1)
            atomic_json(path,{"phase":"P18","status":"RUNNING","n":2})
            self.assertEqual(load_json(path)["phase"],"P18")

    def test_lease_fencing_and_takeover(self):
        with tempfile.TemporaryDirectory() as d:
            ok,a=acquire_lease(d,"P17","owner-A","attempt-A",ttl=2)
            self.assertTrue(ok); self.assertTrue(lease_valid(d,"P17","owner-A",a["generation"]))
            denied,b=acquire_lease(d,"P17","owner-B","attempt-B",ttl=2)
            self.assertFalse(denied); self.assertEqual(b["owner_id"],"owner-A")
            time.sleep(2.1)
            ok2,b2=acquire_lease(d,"P17","owner-B","attempt-B",ttl=2)
            self.assertTrue(ok2); self.assertFalse(lease_valid(d,"P17","owner-A",a["generation"]))
            self.assertTrue(lease_valid(d,"P17","owner-B",b2["generation"]))
            self.assertTrue(release_lease(d,"P17","owner-B",b2["generation"]))

    def test_process_identity(self):
        from supervisor.runtime_guard import process_alive
        self.assertTrue(process_alive(os.getpid(),"python3"))
        self.assertFalse(process_alive(os.getpid(),"this-command-does-not-match"))

    def test_dead_worker_lease_takeover_without_waiting_expiry(self):
        with tempfile.TemporaryDirectory() as d:
            dead_pid=9999999
            ok,a=acquire_lease(d,"P18",f"worker:{dead_pid}:old","attempt-old",ttl=60)
            self.assertTrue(ok)
            ok2,b=acquire_lease(d,"P18",f"worker:{os.getpid()}:new","attempt-new",ttl=60)
            self.assertTrue(ok2)
            self.assertEqual(b["recovered_from_dead_owner"],a["owner_id"])
            self.assertFalse(lease_valid(d,"P18",a["owner_id"],a["generation"]))

    def test_lease_acquisition_is_single_winner_under_concurrency(self):
        with tempfile.TemporaryDirectory() as d:
            ctx=multiprocessing.get_context("fork"); barrier=ctx.Barrier(2); queue=ctx.Queue()
            def contender(owner):
                barrier.wait()
                ok,lease=acquire_lease(d,"P19",owner,"attempt-"+owner,ttl=10)
                queue.put((owner,ok,lease.get("generation")))
            a=ctx.Process(target=contender,args=("owner-A",)); b=ctx.Process(target=contender,args=("owner-B",))
            a.start(); b.start(); a.join(); b.join()
            results=[queue.get(),queue.get()]
            self.assertEqual(sum(1 for _,ok,_ in results if ok),1)

    def test_lease_renewal_fails_closed_when_ownership_changes(self):
        with tempfile.TemporaryDirectory() as d:
            ok,a=acquire_lease(d,"P21","owner-A","attempt-A",ttl=60); self.assertTrue(ok)
            self.assertFalse(renew_lease(d,"P21","owner-B",a["generation"],ttl=60))
            self.assertTrue(renew_lease(d,"P21","owner-A",a["generation"],ttl=60))

    def test_lease_corruption_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            path=os.path.join(d,"runtime","phase-P20-lease.json")
            os.makedirs(os.path.dirname(path),exist_ok=True); Path(path).write_text("{corrupt",encoding="utf-8")
            ok,data=acquire_lease(d,"P20","owner-A","attempt-A",ttl=60)
            self.assertFalse(ok); self.assertEqual(data.get("status"),"CORRUPT")

    def test_completion_marker_is_attempt_bound(self):
        import supervisor.worker as worker
        old_rt=worker.RT
        with tempfile.TemporaryDirectory() as d:
            worker.RT=d
            Path(d,"phase-P18-complete.json").write_text(json.dumps({"phase":"P18","status":"PASS","attempt_id":"attempt-old"}),encoding="utf-8")
            self.assertIsNone(worker.completion_marker("P18","attempt-new"))
            self.assertEqual(worker.completion_marker("P18","attempt-old")["status"],"PASS")
        worker.RT=old_rt

    def test_bankr_run_command_blocks_shell_operators_and_allows_safe_argv(self):
        import importlib.util
        spec=importlib.util.spec_from_file_location("bankr_agent",os.path.join(ROOT,"agents","bankr-agent.py"))
        mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        with self.assertRaises(RuntimeError):
            mod.tool("run_command",{"command":"python3 -c 'print(1)' ; touch nope","timeout":5})
        result=mod.tool("run_command",{"command":"python3 -c 'print(123)'","timeout":5})
        self.assertEqual(result["exit"],0); self.assertEqual(result["stdout"].strip(),"123")

    def test_terminal_checkpoint_does_not_keep_worker_pid(self):
        import supervisor.worker as worker
        import supervisor.checkpoint as checkpoint
        old_rt=worker.RT; old_cp=checkpoint.PATH
        with tempfile.TemporaryDirectory() as d:
            worker.RT=d; checkpoint.PATH=os.path.join(d,"checkpoint.json")
            worker.checkpoint_sync({"phase":"P18","status":"BLOCKED","attempt_id":"a","attempt_number":3,"updated_at":worker.now()})
            with open(checkpoint.PATH,encoding="utf-8") as f:
                self.assertIsNone(json.load(f).get("worker_pid"))
        worker.RT=old_rt; checkpoint.PATH=old_cp

    def test_recovery_helper_exists_and_has_bash_shebang(self):
        p=Path(ROOT)/"runtime"/"recover-phase.sh"
        self.assertTrue(p.exists())
        self.assertTrue(p.read_text(encoding="utf-8").startswith("#!/data/data/com.termux/files/usr/bin/bash"))

    def test_checkpoint_corruption_is_not_silently_defaulted(self):
        import supervisor.checkpoint as cp
        old=cp.PATH
        with tempfile.TemporaryDirectory() as d:
            cp.PATH=os.path.join(d,"checkpoint.json")
            atomic_json(cp.PATH,{"phase":"P17","status":"RUNNING","updated":time.time()})
            self.assertEqual(cp.load()["phase"],"P17")
            Path(cp.PATH).write_text("{corrupt",encoding="utf-8")
            with self.assertRaises(RuntimeError): cp.load()
        cp.PATH=old

    def test_waiting_checkpoint_keeps_worker_identity(self):
        import supervisor.worker as worker
        import supervisor.checkpoint as checkpoint
        old_rt=worker.RT; old_cp=checkpoint.PATH
        with tempfile.TemporaryDirectory() as d:
            worker.RT=d; checkpoint.PATH=os.path.join(d,"checkpoint.json")
            worker.checkpoint_sync({"phase":"P18","status":"WAITING","attempt_id":"a","attempt_number":1,"updated_at":worker.now()})
            saved=checkpoint.load()
            self.assertEqual(saved["status"],"WAITING")
            self.assertEqual(saved.get("attempt_id"),"a")
        worker.RT=old_rt; checkpoint.PATH=old_cp

    def test_watchdog_distinguishes_active_tool_calls(self):
        src=(Path(ROOT)/"runtime"/"acep-watchdog.sh").read_text(encoding="utf-8")
        self.assertIn('if [ "$a_event" = "TOOL_CALL" ]; then active_stale=420; fi',src)
        self.assertIn('a_event="$(agent_progress_event "$phase" "$attempt_id")"',src)

    def test_bankr_fallback_chain_and_progress_use_active_model(self):
        src=(Path(ROOT)/"agents"/"bankr-agent.py").read_text(encoding="utf-8")
        self.assertIn("fallback_visited={active_model}",src)
        self.assertIn("fallback not in fallback_visited",src)
        self.assertIn("model_name or active_model",src)

    def test_recovery_helper_has_single_instance_lock(self):
        src=(Path(ROOT)/"runtime"/"recover-phase.sh").read_text(encoding="utf-8")
        self.assertIn("flock -n 8",src)
        self.assertIn("recovery-already-running",src)

    def test_lease_loss_terminates_executor_group(self):
        src=(Path(ROOT)/"supervisor"/"worker.py").read_text(encoding="utf-8")
        self.assertIn("EXECUTOR_TERMINATE_ON_LEASE_LOSS",src)
        self.assertIn("EXECUTOR_KILL_ON_LEASE_LOSS",src)
        self.assertIn("os.killpg(int(ep),signal.SIGTERM)",src)
        self.assertIn("os.killpg(int(ep),signal.SIGKILL)",src)

    def test_supervisor_pid_file_is_identity_checked(self):
        src=(Path(ROOT)/"runtime"/"launch.sh").read_text(encoding="utf-8")
        self.assertIn("SUPERVISOR_START_FAILED_PID_IDENTITY",src)
        self.assertIn("supervisor/daemon.py",src)
        self.assertIn('rm -f "$PIDFILE"',src)

    def test_watchdog_validates_existing_worker_session(self):
        src=(Path(ROOT)/"runtime"/"acep-watchdog.sh").read_text(encoding="utf-8")
        self.assertIn("worker_session_matches()",src)
        self.assertIn("WORKER_SESSION_EXISTS_VALID",src)
        self.assertIn("WORKER_SESSION_STALE_CLEANUP",src)

    def test_bankr_long_run_guards_and_observability(self):
        src=(Path(ROOT)/"agents"/"bankr-agent.py").read_text(encoding="utf-8")
        self.assertIn("max_attempts=int(os.environ.get(\"ACEP_MODEL_RETRIES\",\"2\"))",src)
        self.assertIn("if e.code == 429:",src)
        self.assertIn("MODEL_ERROR",src)
        self.assertIn("MODEL_RESULT",src)
        self.assertIn("TOOL_RESULT",src)
        self.assertIn("expensive_cache",src)
        self.assertIn("workspace_generation",src)

    def test_p18_avoids_known_qwen_rate_limit_path(self):
        src=(Path(ROOT)/"agents"/"model_router.py").read_text(encoding="utf-8")
        self.assertIn("'P18':'deepseek-v4.1-flash'",src)

if __name__=="__main__":
    unittest.main()
