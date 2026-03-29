"""
Multi-turn meta-engram extraction pipeline.

Pipeline state persists to ~/.plur/meta-pipeline-{session_id}.json
after each stage transition. Resumes on crash. 24h TTL on state files.
"""

import json
import os
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any


@dataclass
class MetaPipelineState:
    session_id: str
    stage: int = 0
    engrams: list[dict] = field(default_factory=list)
    clusters: list[dict] = field(default_factory=list)
    pending_prompts: list[str] = field(default_factory=list)
    collected_responses: list[str] = field(default_factory=list)
    meta_engrams: list[dict] = field(default_factory=list)
    dry_run: bool = False
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "MetaPipelineState":
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


_STATE_TTL_SECONDS = 86400  # 24 hours


class MetaPipeline:
    def __init__(self, bridge: Any, plur_path: str | None = None):
        self._bridge = bridge
        self._plur_path = plur_path or os.environ.get("PLUR_PATH") or os.path.expanduser("~/.plur")

    def _state_path(self, session_id: str) -> Path:
        return Path(self._plur_path) / f"meta-pipeline-{session_id}.json"

    def _load_state(self, session_id: str) -> MetaPipelineState | None:
        path = self._state_path(session_id)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text())
            state = MetaPipelineState.from_dict(data)
            if time.time() - state.created_at > _STATE_TTL_SECONDS:
                path.unlink(missing_ok=True)
                return None
            return state
        except Exception:
            return None

    def _save_state(self, state: MetaPipelineState):
        path = self._state_path(state.session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state.to_dict()))

    def _cleanup_state(self, session_id: str):
        self._state_path(session_id).unlink(missing_ok=True)

    def start_extraction(self, session_id: str, dry_run: bool = False) -> dict:
        existing = self._load_state(session_id)
        if existing and existing.stage > 0:
            return {
                "status": "resuming",
                "message": f"Pipeline interrupted at stage {existing.stage}/6. Resuming.",
                "stage": existing.stage,
                "prompts": existing.pending_prompts,
            }

        result = self._bridge.list_engrams()
        engrams = result.get("engrams", [])

        if len(engrams) < 5:
            return {
                "status": "insufficient_data",
                "message": f"Need at least 5 engrams for meta-extraction, found {len(engrams)}.",
            }

        prompts = []
        for engram in engrams:
            prompts.append(
                f"Extract relational triples from this engram:\n"
                f"ID: {engram['id']}\n"
                f"Statement: {engram['statement']}\n"
                f"Domain: {engram.get('domain', 'unknown')}\n\n"
                f"Return JSON: {{\"id\": \"{engram['id']}\", \"subject\": \"...\", "
                f"\"predicate\": \"...\", \"object\": \"...\", \"outcome\": \"...\"}}"
            )

        state = MetaPipelineState(
            session_id=session_id, stage=1, engrams=engrams,
            pending_prompts=prompts, dry_run=dry_run,
        )
        self._save_state(state)

        return {
            "status": "prompts_ready",
            "stage": 1,
            "stage_name": "structural_analysis",
            "total_stages": 6,
            "prompts": prompts,
            "message": f"Process these {len(prompts)} prompts and call plur_meta_submit_analysis with your responses.",
        }

    def submit_analysis(self, session_id: str, responses: list[str]) -> dict:
        state = self._load_state(session_id)
        if not state:
            return {
                "status": "no_active_pipeline",
                "message": "No extraction in progress. Call plur_extract_meta first.",
            }

        state.collected_responses.extend(responses)

        if state.stage == 1:
            state.stage = 2
            clusters = self._cluster_triples(state.collected_responses)
            state.clusters = clusters
            state.collected_responses = []

            if len(clusters) == 0:
                self._cleanup_state(session_id)
                return {"status": "complete", "meta_engrams": [], "message": "No clusters found."}

            prompts = []
            for i, cluster in enumerate(clusters):
                members = "\n".join(f"- {m}" for m in cluster.get("members", []))
                prompts.append(
                    f"Find the common relational skeleton across these engrams:\n"
                    f"{members}\n\n"
                    f"Return JSON: {{\"cluster_id\": {i}, \"skeleton\": \"...\", "
                    f"\"systematicity\": <1-5>, \"alignment_scores\": [...]}}"
                )
            state.stage = 3
            state.pending_prompts = prompts
            self._save_state(state)
            return {"status": "prompts_ready", "stage": 3, "stage_name": "structural_alignment", "prompts": prompts, "message": f"Process these {len(prompts)} alignment prompts."}

        elif state.stage == 3:
            state.stage = 4
            aligned = self._filter_alignments(state.collected_responses)
            state.collected_responses = []

            if len(aligned) == 0:
                self._cleanup_state(session_id)
                return {"status": "complete", "meta_engrams": [], "message": "No alignments passed quality gate."}

            prompts = []
            for alignment in aligned:
                prompts.append(
                    f"Formulate a meta-engram from this alignment:\n"
                    f"Skeleton: {alignment}\n\n"
                    f"Return JSON: {{\"statement\": \"...\", \"falsification\": \"...\", "
                    f"\"domains\": [...], \"confidence\": <0-1>}}"
                )
            state.pending_prompts = prompts
            self._save_state(state)
            return {"status": "prompts_ready", "stage": 4, "stage_name": "formulation", "prompts": prompts, "message": f"Process these {len(prompts)} formulation prompts."}

        elif state.stage == 4:
            state.stage = 5
            meta_engrams = self._parse_meta_engrams(state.collected_responses)
            state.meta_engrams = meta_engrams
            state.collected_responses = []

            if len(meta_engrams) == 0:
                self._cleanup_state(session_id)
                return {"status": "complete", "meta_engrams": [], "message": "No meta-engrams passed formulation."}

            if not state.dry_run:
                for me in meta_engrams:
                    try:
                        self._bridge.learn(me["statement"], scope="global", type="architectural", domain=me.get("domain", "meta"))
                    except Exception:
                        pass

            self._cleanup_state(session_id)
            return {
                "status": "complete",
                "meta_engrams": meta_engrams,
                "count": len(meta_engrams),
                "message": f"Extracted {len(meta_engrams)} meta-engrams." + (" (dry run — not saved)" if state.dry_run else ""),
            }

        else:
            self._cleanup_state(session_id)
            return {"status": "error", "message": f"Unexpected stage: {state.stage}"}

    def _cluster_triples(self, responses: list[str]) -> list[dict]:
        triples = []
        for resp in responses:
            try:
                data = json.loads(resp)
                triples.append(data)
            except (json.JSONDecodeError, KeyError):
                continue

        if len(triples) < 2:
            return []

        clusters: dict[str, list] = {}
        for triple in triples:
            key = triple.get("predicate", "unknown").lower().strip()
            if key not in clusters:
                clusters[key] = []
            clusters[key].append(triple.get("statement", str(triple)))

        return [{"predicate": k, "members": v} for k, v in clusters.items() if len(v) >= 2]

    def _filter_alignments(self, responses: list[str]) -> list[str]:
        aligned = []
        for resp in responses:
            try:
                data = json.loads(resp)
                if data.get("systematicity", 0) >= 2:
                    aligned.append(data.get("skeleton", resp))
            except (json.JSONDecodeError, KeyError):
                continue
        return aligned

    def _parse_meta_engrams(self, responses: list[str]) -> list[dict]:
        results = []
        for resp in responses:
            try:
                data = json.loads(resp)
                if data.get("statement") and data.get("confidence", 0) > 0.3:
                    results.append(data)
            except (json.JSONDecodeError, KeyError):
                continue
        return results
