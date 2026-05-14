"""Tests for multi-turn meta-engram extraction pipeline."""

import json
import os
import shutil
import tempfile
import time
import pytest
from unittest.mock import MagicMock
from plur_hermes.meta_pipeline import MetaPipeline, MetaPipelineState


class TestMetaPipeline:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.bridge = MagicMock()
        self.pipeline = MetaPipeline(self.bridge, plur_path=self.tmpdir)

    def teardown_method(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_start_with_insufficient_engrams(self):
        self.bridge.list_engrams.return_value = {"engrams": [{"id": "1", "statement": "a"}], "count": 1}
        result = self.pipeline.start_extraction("sess-1")
        assert result["status"] == "insufficient_data"

    def test_start_returns_prompts(self):
        engrams = [{"id": f"ENG-{i}", "statement": f"statement {i}", "domain": "test"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}
        result = self.pipeline.start_extraction("sess-1")
        assert result["status"] == "prompts_ready"
        assert result["stage"] == 1
        assert len(result["prompts"]) == 5

    def test_state_persists_to_disk(self):
        engrams = [{"id": f"ENG-{i}", "statement": f"s{i}", "domain": "t"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}
        self.pipeline.start_extraction("sess-1")
        assert os.path.exists(os.path.join(self.tmpdir, "meta-pipeline-sess-1.json"))

    def test_submit_with_no_pipeline(self):
        result = self.pipeline.submit_analysis("sess-none", ["response"])
        assert result["status"] == "no_active_pipeline"

    def test_resume_after_crash(self):
        engrams = [{"id": f"ENG-{i}", "statement": f"s{i}", "domain": "t"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}
        self.pipeline.start_extraction("sess-1")
        pipeline2 = MetaPipeline(self.bridge, plur_path=self.tmpdir)
        result = pipeline2.start_extraction("sess-1")
        assert result["status"] == "resuming"
        assert result["stage"] == 1

    def test_full_pipeline_flow(self):
        engrams = [{"id": f"ENG-{i}", "statement": f"statement {i}", "domain": "test"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}

        r1 = self.pipeline.start_extraction("sess-flow")
        assert r1["status"] == "prompts_ready"

        triples = [json.dumps({"id": f"ENG-{i}", "subject": "X", "predicate": "causes", "object": "Y", "outcome": "Z", "statement": f"s{i}"}) for i in range(5)]
        r2 = self.pipeline.submit_analysis("sess-flow", triples)
        assert r2["status"] == "prompts_ready"
        assert r2["stage"] == 3

        alignments = [json.dumps({"cluster_id": 0, "skeleton": "X causes Y", "systematicity": 3, "alignment_scores": [0.8]})]
        r3 = self.pipeline.submit_analysis("sess-flow", alignments)
        assert r3["status"] == "prompts_ready"
        assert r3["stage"] == 4

        formulations = [json.dumps({"statement": "When X, then Y", "falsification": "If not X, Y still occurs", "domains": ["test"], "confidence": 0.8})]
        r4 = self.pipeline.submit_analysis("sess-flow", formulations)
        assert r4["status"] == "complete"
        assert r4["count"] == 1

    def test_dry_run_does_not_save(self):
        engrams = [{"id": f"ENG-{i}", "statement": f"s{i}", "domain": "t"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}
        self.pipeline.start_extraction("sess-dry", dry_run=True)
        triples = [json.dumps({"id": f"ENG-{i}", "predicate": "causes", "statement": f"s{i}"}) for i in range(5)]
        self.pipeline.submit_analysis("sess-dry", triples)
        alignments = [json.dumps({"skeleton": "X causes Y", "systematicity": 3})]
        self.pipeline.submit_analysis("sess-dry", alignments)
        formulations = [json.dumps({"statement": "test", "confidence": 0.9})]
        result = self.pipeline.submit_analysis("sess-dry", formulations)
        assert result["status"] == "complete"
        self.bridge.learn.assert_not_called()

    def test_learn_failures_are_counted_not_silently_swallowed(self, caplog):
        """When bridge.learn() fails (e.g. PlurLockError), the failure must
        be logged and reflected in the response — not silently dropped."""
        import logging
        engrams = [{"id": f"ENG-{i}", "statement": f"s{i}", "domain": "t"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}
        # Make every learn() call raise — simulates sustained lock contention.
        self.bridge.learn.side_effect = RuntimeError("Failed to acquire lock")

        self.pipeline.start_extraction("sess-fail")
        triples = [json.dumps({"id": f"ENG-{i}", "predicate": "causes", "statement": f"s{i}"}) for i in range(5)]
        self.pipeline.submit_analysis("sess-fail", triples)
        alignments = [json.dumps({"skeleton": "X causes Y", "systematicity": 3})]
        self.pipeline.submit_analysis("sess-fail", alignments)
        formulations = [
            json.dumps({"statement": "When X, then Y", "confidence": 0.9}),
            json.dumps({"statement": "When A, then B", "confidence": 0.9}),
        ]
        with caplog.at_level(logging.WARNING, logger="plur_hermes.meta_pipeline"):
            result = self.pipeline.submit_analysis("sess-fail", formulations)

        assert result["status"] == "complete"
        assert result["count"] == 2
        assert result["saved"] == 0
        assert result["failed"] == 2
        assert "2 failed" in result["message"]
        # State must be preserved (not cleaned up) so the caller can retry.
        assert result["state"] == "preserved_for_retry"
        # Both failures must be in the logs — no silent swallow.
        warning_records = [r for r in caplog.records if "failed to save meta-engram" in r.message]
        assert len(warning_records) == 2
        # exc_info must be attached so stacktraces survive to ops dashboards.
        assert all(r.exc_info is not None for r in warning_records), \
            "logger.warning must include exc_info=True so tracebacks aren't lost"

    def test_partial_failure_preserves_state_and_failed_engrams(self):
        """When some saves succeed and some fail, the pipeline state is
        preserved with ONLY the failed engrams — so a retry doesn't
        duplicate-write the successful ones."""
        engrams = [{"id": f"ENG-{i}", "statement": f"s{i}", "domain": "t"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}

        call_count = [0]
        def learn_side_effect(*args, **kwargs):
            call_count[0] += 1
            # First save succeeds, second fails, third succeeds
            if call_count[0] == 2:
                raise RuntimeError("Failed to acquire lock")
            return {"id": f"ENG-{call_count[0]}"}
        self.bridge.learn.side_effect = learn_side_effect

        self.pipeline.start_extraction("sess-partial")
        triples = [json.dumps({"id": f"ENG-{i}", "predicate": "causes", "statement": f"s{i}"}) for i in range(5)]
        self.pipeline.submit_analysis("sess-partial", triples)
        alignments = [json.dumps({"skeleton": "X causes Y", "systematicity": 3})]
        self.pipeline.submit_analysis("sess-partial", alignments)
        formulations = [
            json.dumps({"statement": "First", "confidence": 0.9}),
            json.dumps({"statement": "Second-fails", "confidence": 0.9}),
            json.dumps({"statement": "Third", "confidence": 0.9}),
        ]
        result = self.pipeline.submit_analysis("sess-partial", formulations)

        assert result["saved"] == 2
        assert result["failed"] == 1
        assert len(result["failed_engrams"]) == 1
        assert result["failed_engrams"][0]["statement"] == "Second-fails"
        assert result["state"] == "preserved_for_retry"

        # State file should still exist on disk for recovery
        state_path = os.path.join(self.tmpdir, "meta-pipeline-sess-partial.json")
        assert os.path.exists(state_path), "Partial-failure state must be persisted"

    def test_all_success_cleans_up_state(self):
        """Happy path: when all saves succeed, state is cleaned up as before."""
        engrams = [{"id": f"ENG-{i}", "statement": f"s{i}", "domain": "t"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}
        self.bridge.learn.return_value = {"id": "ENG-X"}

        self.pipeline.start_extraction("sess-ok")
        triples = [json.dumps({"id": f"ENG-{i}", "predicate": "causes", "statement": f"s{i}"}) for i in range(5)]
        self.pipeline.submit_analysis("sess-ok", triples)
        alignments = [json.dumps({"skeleton": "X causes Y", "systematicity": 3})]
        self.pipeline.submit_analysis("sess-ok", alignments)
        formulations = [json.dumps({"statement": "OK", "confidence": 0.9})]
        result = self.pipeline.submit_analysis("sess-ok", formulations)

        assert result["saved"] == 1
        assert result["failed"] == 0
        assert result["state"] == "cleaned"
        state_path = os.path.join(self.tmpdir, "meta-pipeline-sess-ok.json")
        assert not os.path.exists(state_path), "Successful pipeline must clean up state"

    def test_circuit_breaker_aborts_after_max_consecutive_failures(self):
        """Bound wall-time: after N consecutive failures the save loop must abort
        and defer remaining engrams as 'skipped', not 'failed'."""
        engrams = [{"id": f"ENG-{i}", "statement": f"s{i}", "domain": "t"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}
        self.bridge.learn.side_effect = RuntimeError("Failed to acquire lock")

        self.pipeline.start_extraction("sess-circuit")
        triples = [json.dumps({"id": f"ENG-{i}", "predicate": "causes", "statement": f"s{i}"}) for i in range(5)]
        self.pipeline.submit_analysis("sess-circuit", triples)
        alignments = [json.dumps({"skeleton": "X causes Y", "systematicity": 3})]
        self.pipeline.submit_analysis("sess-circuit", alignments)
        # 10 engrams to formulate; if every save fails, circuit breaker should
        # trip at 3 failures and defer the remaining 7.
        formulations = [
            json.dumps({"statement": f"stmt-{i}", "confidence": 0.9})
            for i in range(10)
        ]
        result = self.pipeline.submit_analysis("sess-circuit", formulations)

        assert result["circuit_broke"] is True
        assert result["failed"] == 3  # exactly the max consecutive failures
        assert result["skipped"] == 7
        assert result["saved"] == 0
        # Bridge.learn must NOT have been called more than 3 times under contention
        assert self.bridge.learn.call_count == 3, \
            f"Circuit breaker failed to bound: bridge.learn called {self.bridge.learn.call_count} times"

    def test_stage_5_retry_resumes_only_failed_engrams(self):
        """After partial failure, calling submit_analysis with an empty body
        must retry ONLY the previously-failed engrams (not re-run the full pipeline)."""
        engrams = [{"id": f"ENG-{i}", "statement": f"s{i}", "domain": "t"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}

        # First call: third engram fails, others succeed
        call_state = {"n": 0}
        def first_learn(*args, **kwargs):
            call_state["n"] += 1
            if call_state["n"] == 3:
                raise RuntimeError("Failed to acquire lock")
            return {"id": f"ENG-{call_state['n']}"}
        self.bridge.learn.side_effect = first_learn

        self.pipeline.start_extraction("sess-retry")
        triples = [json.dumps({"id": f"ENG-{i}", "predicate": "causes", "statement": f"s{i}"}) for i in range(5)]
        self.pipeline.submit_analysis("sess-retry", triples)
        alignments = [json.dumps({"skeleton": "X causes Y", "systematicity": 3})]
        self.pipeline.submit_analysis("sess-retry", alignments)
        formulations = [
            json.dumps({"statement": "first", "confidence": 0.9}),
            json.dumps({"statement": "second", "confidence": 0.9}),
            json.dumps({"statement": "third-fails", "confidence": 0.9}),
            json.dumps({"statement": "fourth", "confidence": 0.9}),
            json.dumps({"statement": "fifth", "confidence": 0.9}),
        ]
        first_result = self.pipeline.submit_analysis("sess-retry", formulations)
        assert first_result["saved"] == 4
        assert first_result["failed"] == 1
        assert first_result["state"] == "preserved_for_retry"

        # Retry: now bridge.learn succeeds for everything
        self.bridge.learn.side_effect = None
        self.bridge.learn.return_value = {"id": "ENG-RETRY"}
        retry_result = self.pipeline.submit_analysis("sess-retry", [])

        assert retry_result["status"] == "complete"
        assert retry_result["count"] == 1, \
            "Retry should target ONLY the 1 previously-failed engram, not re-run the full pipeline"
        assert retry_result["saved"] == 1
        assert retry_result["failed"] == 0
        assert retry_result["state"] == "cleaned"
        # State file gone after successful retry
        state_path = os.path.join(self.tmpdir, "meta-pipeline-sess-retry.json")
        assert not os.path.exists(state_path)

    def test_stage_5_crash_resume_via_start_extraction_returns_retry_pending(self):
        """If a process crashed mid-retry leaving stage=5 state on disk,
        a fresh start_extraction call must tell the caller to retry, not
        return useless empty prompts."""
        from plur_hermes.meta_pipeline import MetaPipelineState
        # Simulate a crash-resume scenario: write a state file with stage 5
        # and one preserved failed engram, no pending prompts.
        crashed_state = MetaPipelineState(
            session_id="sess-crash",
            stage=5,
            meta_engrams=[{"statement": "still-pending", "domain": "meta"}],
            pending_prompts=[],
        )
        self.pipeline._save_state(crashed_state)

        result = self.pipeline.start_extraction("sess-crash")

        assert result["status"] == "retry_pending"
        assert result["stage"] == 5
        assert len(result["failed_engrams"]) == 1
        assert "submit_analysis" in result["message"]
        assert "[]" in result["message"]  # tells caller to pass empty body

    def test_stage_5_ignores_nonempty_responses(self, caplog):
        """A misdirected caller passing real response data to a stage-5
        retry must not pollute collected_responses or break the retry."""
        import logging
        # Set up partial-failure state at stage 5
        engrams = [{"id": f"ENG-{i}", "statement": f"s{i}", "domain": "t"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}
        self.bridge.learn.side_effect = RuntimeError("Failed to acquire lock")

        self.pipeline.start_extraction("sess-confused")
        triples = [json.dumps({"id": f"ENG-{i}", "predicate": "causes", "statement": f"s{i}"}) for i in range(5)]
        self.pipeline.submit_analysis("sess-confused", triples)
        alignments = [json.dumps({"skeleton": "X causes Y", "systematicity": 3})]
        self.pipeline.submit_analysis("sess-confused", alignments)
        formulations = [json.dumps({"statement": "to-retry", "confidence": 0.9})]
        self.pipeline.submit_analysis("sess-confused", formulations)

        # Now the state is stage=5, preserved. Caller mistakenly resubmits with junk:
        self.bridge.learn.side_effect = None
        self.bridge.learn.return_value = {"id": "ENG-RETRY"}
        garbage = ["random response data", "more junk"]
        with caplog.at_level(logging.WARNING, logger="plur_hermes.meta_pipeline"):
            result = self.pipeline.submit_analysis("sess-confused", garbage)

        # Retry still completes correctly despite garbage input
        assert result["status"] == "complete"
        assert result["saved"] == 1
        # Warning should have been logged about ignored responses
        assert any("stage-5 submit_analysis received" in r.message for r in caplog.records), \
            "Stage-5 should warn when responses are passed"

    def test_submit_analysis_handles_none_responses(self):
        """MCP wrappers may pass None for empty input. Must not raise TypeError."""
        engrams = [{"id": f"ENG-{i}", "statement": f"s{i}", "domain": "t"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}
        self.pipeline.start_extraction("sess-none")
        # Pass None instead of []
        result = self.pipeline.submit_analysis("sess-none", None)
        # No crash. The pipeline either advances normally or returns sane status.
        assert "status" in result

    def test_retry_round_can_itself_partially_fail(self):
        """A stage-5 retry that itself partially fails must re-preserve the
        remaining-failed engrams for ANOTHER retry round."""
        engrams = [{"id": f"ENG-{i}", "statement": f"s{i}", "domain": "t"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}

        # Initial: fail engram #2, fail engram #3
        first_calls = {"n": 0}
        def first_round(*args, **kwargs):
            first_calls["n"] += 1
            if first_calls["n"] in (2, 3):
                raise RuntimeError("Failed to acquire lock")
            return {"id": f"ENG-{first_calls['n']}"}
        self.bridge.learn.side_effect = first_round

        self.pipeline.start_extraction("sess-multi-retry")
        triples = [json.dumps({"id": f"ENG-{i}", "predicate": "causes", "statement": f"s{i}"}) for i in range(5)]
        self.pipeline.submit_analysis("sess-multi-retry", triples)
        alignments = [json.dumps({"skeleton": "X causes Y", "systematicity": 3})]
        self.pipeline.submit_analysis("sess-multi-retry", alignments)
        formulations = [
            json.dumps({"statement": f"f-{i}", "confidence": 0.9}) for i in range(4)
        ]
        first_result = self.pipeline.submit_analysis("sess-multi-retry", formulations)
        assert first_result["saved"] == 2
        assert first_result["failed"] == 2
        assert first_result["state"] == "preserved_for_retry"

        # Retry round 1: only one of the two still fails
        second_calls = {"n": 0}
        def second_round(*args, **kwargs):
            second_calls["n"] += 1
            if second_calls["n"] == 1:
                raise RuntimeError("Failed to acquire lock")
            return {"id": "ENG-RETRY"}
        self.bridge.learn.side_effect = second_round
        second_result = self.pipeline.submit_analysis("sess-multi-retry", [])

        assert second_result["status"] == "complete"
        assert second_result["count"] == 2  # the 2 previously-failed engrams
        assert second_result["saved"] == 1
        assert second_result["failed"] == 1
        assert second_result["state"] == "preserved_for_retry"

        # Retry round 2: this time everything succeeds
        self.bridge.learn.side_effect = None
        self.bridge.learn.return_value = {"id": "ENG-FINAL"}
        third_result = self.pipeline.submit_analysis("sess-multi-retry", [])
        assert third_result["status"] == "complete"
        assert third_result["saved"] == 1
        assert third_result["state"] == "cleaned"

    def test_save_state_failure_returns_structured_response(self):
        """If _save_state itself raises (disk full, permissions), the partial-save
        path must still return a structured response — not propagate the exception."""
        from unittest.mock import patch
        engrams = [{"id": f"ENG-{i}", "statement": f"s{i}", "domain": "t"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}
        self.bridge.learn.side_effect = RuntimeError("Failed to acquire lock")

        self.pipeline.start_extraction("sess-disk")
        triples = [json.dumps({"id": f"ENG-{i}", "predicate": "causes", "statement": f"s{i}"}) for i in range(5)]
        self.pipeline.submit_analysis("sess-disk", triples)
        alignments = [json.dumps({"skeleton": "X causes Y", "systematicity": 3})]
        self.pipeline.submit_analysis("sess-disk", alignments)
        formulations = [json.dumps({"statement": f"f-{i}", "confidence": 0.9}) for i in range(2)]

        # Patch _save_state to raise only on the partial-failure cleanup branch
        # (stage 5). Stage transitions during earlier submit_analysis calls
        # already happened OUTSIDE this patch, so we don't need to count them.
        original_save = self.pipeline._save_state
        def flaky_save(state):
            if state.stage == 5:
                raise OSError("[Errno 28] No space left on device")
            return original_save(state)
        with patch.object(self.pipeline, "_save_state", side_effect=flaky_save):
            result = self.pipeline.submit_analysis("sess-disk", formulations)

        # Must NOT raise. Must return a structured response with a warning state.
        assert result["status"] == "complete"
        assert result["state"] == "preservation_failed"
        assert "state file write failed" in result["message"].lower()

    def test_stage_ttl_resets_pipeline(self):
        engrams = [{"id": f"ENG-{i}", "statement": f"s{i}", "domain": "t"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}
        self.pipeline.start_extraction("sess-ttl")

        # Simulate stage expiry by backdating stage_updated_at in the state file
        state_path = os.path.join(self.tmpdir, "meta-pipeline-sess-ttl.json")
        data = json.loads(open(state_path).read())
        data["stage_updated_at"] = time.time() - 700  # past 10-minute TTL
        open(state_path, "w").write(json.dumps(data))

        # start_extraction should return fresh prompts, not "resuming"
        result = self.pipeline.start_extraction("sess-ttl")
        assert result["status"] == "prompts_ready"
        assert result["stage"] == 1

    def test_prompts_ready_includes_must_call_instruction(self):
        engrams = [{"id": f"ENG-{i}", "statement": f"s{i}", "domain": "t"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}
        result = self.pipeline.start_extraction("sess-instr")
        assert "plur_meta_submit_analysis" in result["message"]

    def test_idempotent_submission_deduplicates_within_call(self):
        """Duplicate responses in a single submit call are stored only once."""
        engrams = [{"id": f"ENG-{i}", "statement": f"statement {i}", "domain": "test"} for i in range(5)]
        self.bridge.list_engrams.return_value = {"engrams": engrams, "count": 5}
        self.pipeline.start_extraction("sess-idem")

        # Inject pre-existing response into state to verify cross-call dedup too
        state_path = os.path.join(self.tmpdir, "meta-pipeline-sess-idem.json")
        data = json.loads(open(state_path).read())
        data["collected_responses"] = ['{"id":"ENG-0","predicate":"causes","statement":"s0"}']
        open(state_path, "w").write(json.dumps(data))

        # Submit same response again (should be deduped) plus one new one
        responses = [
            '{"id":"ENG-0","predicate":"causes","statement":"s0"}',  # duplicate
            '{"id":"ENG-1","predicate":"causes","statement":"s1"}',  # new
        ]
        self.pipeline.submit_analysis("sess-idem", responses)

        # State advances to stage 3; collected_responses reset — verify only 2 triples
        # were processed (not 3), so cluster has exactly 2 members
        state_path2 = os.path.join(self.tmpdir, "meta-pipeline-sess-idem.json")
        data2 = json.loads(open(state_path2).read())
        assert data2["stage"] == 3
        # Clusters formed from 2 triples (not 3 — the duplicate was skipped)
        assert len(data2["clusters"]) == 1
        assert len(data2["clusters"][0]["members"]) == 2
