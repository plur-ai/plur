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
