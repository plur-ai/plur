"""
Multi-turn meta-engram extraction pipeline.

Pipeline state persists to ~/.plur/meta-pipeline-{session_id}.json
after each stage transition. Resumes on crash. 24h total TTL; 10-minute
per-stage TTL resets the pipeline if the LLM fails to call submit_analysis.
"""

import json
import logging
import os
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


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
    stage_updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "MetaPipelineState":
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


_STATE_TTL_SECONDS = 86400  # 24 hours total
_STAGE_TTL_SECONDS = 600    # 10 minutes per stage before auto-reset


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
            now = time.time()
            if now - state.created_at > _STATE_TTL_SECONDS:
                path.unlink(missing_ok=True)
                return None
            if now - state.stage_updated_at > _STAGE_TTL_SECONDS:
                logger.warning(
                    "meta-pipeline %s expired at stage %d (>%ds inactivity) — resetting",
                    session_id, state.stage, _STAGE_TTL_SECONDS,
                )
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
            # Stage 5 with preserved meta_engrams is a retry-pending state,
            # not a normal resume. The caller has no prompts to process — they
            # must call submit_analysis with an empty body to re-attempt the
            # previously-failed saves.
            if existing.stage == 5 and existing.meta_engrams and not existing.pending_prompts:
                return {
                    "status": "retry_pending",
                    "message": (
                        f"Previous run had {len(existing.meta_engrams)} unfinished "
                        f"meta-engram saves. Call submit_analysis with an empty "
                        f"body ([]) to retry them."
                    ),
                    "stage": 5,
                    "failed_engrams": existing.meta_engrams,
                }
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
        logger.info("meta-pipeline %s started at stage 1 (%d engrams)", session_id, len(engrams))

        return {
            "status": "prompts_ready",
            "stage": 1,
            "stage_name": "structural_analysis",
            "total_stages": 6,
            "prompts": prompts,
            "message": (
                f"Process these {len(prompts)} prompts and "
                "call plur_meta_submit_analysis({'responses': [...]}) within this turn to proceed. "
                "Skipping this call will cause the pipeline to reset after 10 minutes."
            ),
        }

    def submit_analysis(self, session_id: str, responses: list[str] | None) -> dict:
        state = self._load_state(session_id)
        if not state:
            return {
                "status": "no_active_pipeline",
                "message": "No extraction in progress. Call plur_extract_meta first.",
            }

        # Stage 5 = retry-pending. Ignore any responses passed in; the retry
        # operates on `state.meta_engrams` (the preserved failed engrams), not
        # on response data. Don't pollute collected_responses with garbage.
        if state.stage == 5:
            if responses:
                logger.warning(
                    "meta_pipeline: stage-5 submit_analysis received %d response(s); "
                    "ignoring (stage 5 is retry-only, operates on preserved engrams)",
                    len(responses),
                )
        else:
            # Dedup responses against what's already collected (idempotent
            # resubmit safety) AND guard against None for MCP wrappers that
            # pass None instead of [].
            seen = set(state.collected_responses)
            for r in (responses or []):
                if r not in seen:
                    seen.add(r)
                    state.collected_responses.append(r)

        _must_call_msg = (
            "You MUST call plur_meta_submit_analysis({'responses': [...]}) within this turn to proceed. "
            "Skipping this call will cause the pipeline to reset after 10 minutes."
        )

        if state.stage == 1:
            state.stage = 2
            clusters = self._cluster_triples(state.collected_responses)
            state.clusters = clusters
            state.collected_responses = []

            if len(clusters) == 0:
                self._cleanup_state(session_id)
                return {
                    "status": "complete",
                    "meta_engrams": [],
                    "count": 0,
                    "saved": 0,
                    "failed": 0,
                    "message": "No clusters found.",
                }

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
            state.stage_updated_at = time.time()
            self._save_state(state)
            logger.info("meta-pipeline %s advanced to stage 3 (%d clusters)", session_id, len(clusters))
            return {
                "status": "prompts_ready",
                "stage": 3,
                "stage_name": "structural_alignment",
                "prompts": prompts,
                "message": f"Process these {len(prompts)} alignment prompts. " + _must_call_msg,
            }

        elif state.stage == 3:
            state.stage = 4
            aligned = self._filter_alignments(state.collected_responses)
            state.collected_responses = []

            if len(aligned) == 0:
                self._cleanup_state(session_id)
                return {
                    "status": "complete",
                    "meta_engrams": [],
                    "count": 0,
                    "saved": 0,
                    "failed": 0,
                    "message": "No alignments passed quality gate.",
                }

            prompts = []
            for alignment in aligned:
                prompts.append(
                    f"Formulate a meta-engram from this alignment:\n"
                    f"Skeleton: {alignment}\n\n"
                    f"Return JSON: {{\"statement\": \"...\", \"falsification\": \"...\", "
                    f"\"domains\": [...], \"confidence\": <0-1>}}"
                )
            state.pending_prompts = prompts
            state.stage_updated_at = time.time()
            self._save_state(state)
            logger.info("meta-pipeline %s advanced to stage 4 (%d alignments)", session_id, len(aligned))
            return {
                "status": "prompts_ready",
                "stage": 4,
                "stage_name": "formulation",
                "prompts": prompts,
                "message": f"Process these {len(prompts)} formulation prompts. " + _must_call_msg,
            }

        elif state.stage == 4:
            state.stage = 5
            meta_engrams = self._parse_meta_engrams(state.collected_responses)
            state.meta_engrams = meta_engrams
            state.collected_responses = []

            if len(meta_engrams) == 0:
                self._cleanup_state(session_id)
                return {
                    "status": "complete",
                    "meta_engrams": [],
                    "count": 0,
                    "saved": 0,
                    "failed": 0,
                    "message": "No meta-engrams passed formulation.",
                }

            return self._save_and_finalize(state, meta_engrams, retry_round=False)

        elif state.stage == 5:
            # Retry path: caller is re-submitting after partial-save failure.
            # state.meta_engrams holds only the engrams that previously failed.
            # Ignore any new responses — we operate on preserved state only.
            if not state.meta_engrams:
                self._cleanup_state(session_id)
                return {
                    "status": "error",
                    "message": "Stage-5 retry called but no failed engrams preserved.",
                }
            return self._save_and_finalize(state, state.meta_engrams, retry_round=True)

        else:
            self._cleanup_state(session_id)
            return {"status": "error", "message": f"Unexpected stage: {state.stage}"}

    # ------------------------------------------------------------------
    # save helpers
    # ------------------------------------------------------------------

    # Bound wall-time exposure under sustained contention. After this many
    # CONSECUTIVE failures in a single save loop, abort the remaining engrams
    # and surface partial results immediately so the caller isn't blocked for
    # `len(meta_engrams) × bridge_timeout` seconds.
    _MAX_CONSECUTIVE_SAVE_FAILURES = 3

    def _save_and_finalize(self, state: 'MetaPipelineState', engrams_to_save: list[dict],
                           retry_round: bool) -> dict:
        """Run the save loop with a consecutive-failure circuit breaker, then
        either clean up state (all good) or preserve it for retry (partial)."""
        session_id = state.session_id
        saved_count = 0
        failed_count = 0
        skipped_count = 0
        failed_engrams: list[dict] = []
        consecutive_failures = 0
        circuit_broke = False

        if not state.dry_run:
            for idx, me in enumerate(engrams_to_save):
                if circuit_broke:
                    # Remaining engrams are deferred, not failed — caller can
                    # retry them later via stage-5 resubmit.
                    skipped_count += 1
                    failed_engrams.append(me)
                    continue
                try:
                    self._bridge.learn(me["statement"], scope="global",
                                       type="architectural",
                                       domain=me.get("domain", "meta"))
                    saved_count += 1
                    consecutive_failures = 0
                except Exception as e:
                    failed_count += 1
                    consecutive_failures += 1
                    failed_engrams.append(me)
                    logger.warning(
                        "meta_pipeline: failed to save meta-engram (%s): %s",
                        me.get("statement", "")[:60], e,
                        exc_info=True,
                    )
                    if consecutive_failures >= self._MAX_CONSECUTIVE_SAVE_FAILURES:
                        circuit_broke = True
                        remaining = len(engrams_to_save) - idx - 1
                        logger.warning(
                            "meta_pipeline: circuit-breaker tripped after %d "
                            "consecutive failures; deferring %d remaining engrams",
                            consecutive_failures, remaining,
                        )

        any_unfinished = failed_count > 0 or skipped_count > 0
        if not any_unfinished:
            self._cleanup_state(session_id)
            state_status = "cleaned"
        else:
            # Preserve only the unfinished engrams so the next retry round
            # targets exactly them. Guard _save_state in case disk is gone —
            # we still want to return a structured response.
            state.meta_engrams = failed_engrams
            try:
                self._save_state(state)
                state_status = "preserved_for_retry"
            except Exception as save_err:
                logger.error(
                    "meta_pipeline: failed to persist retry state (%s); "
                    "in-memory failed_engrams returned but not recoverable on next session",
                    save_err, exc_info=True,
                )
                state_status = "preservation_failed"

        total = len(engrams_to_save)
        message = (
            f"Retry round: re-attempted {total} previously-failed meta-engrams."
            if retry_round
            else f"Extracted {total} meta-engrams."
        )
        if state.dry_run:
            message += " (dry run — not saved)"
        elif any_unfinished:
            parts = [f"Saved {saved_count}"]
            if failed_count:
                parts.append(f"{failed_count} failed")
            if skipped_count:
                parts.append(f"{skipped_count} deferred (circuit breaker)")
            message += " " + ", ".join(parts) + "."
            if state_status == "preserved_for_retry":
                message += " Resubmit with an empty body to retry."
            elif state_status == "preservation_failed":
                message += " WARNING: state file write failed; retry data lost."

        return {
            "status": "complete",
            "meta_engrams": engrams_to_save,
            "count": total,
            "saved": saved_count,
            "failed": failed_count,
            "skipped": skipped_count,
            "failed_engrams": failed_engrams,
            "state": state_status,
            "circuit_broke": circuit_broke,
            "message": message,
        }

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
