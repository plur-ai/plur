# Whole-codebase architecture and refactoring audit — 2026-09-03

Branch: `refactor/architecture-audit` (from `origin/main` @ 33af9de). Report is filled in as the work proceeds; the BEFORE column is measured on that commit.

## Baseline (measured)

| Metric | Value |
|---|---|
| Production TS/Python lines (packages + scripts + infra + benchmark + examples) | 64,580 lines / 38,677 code lines / 286 files |
| Test lines | 77,724 lines / 57,709 code lines / 407 files |
| `packages/core/src/index.ts` | 9,344 lines; `Plur` class 8,626 lines, 187 methods (106 public), 25 fields |
| `packages/mcp/src/tools.ts` | 3,782 lines; `getAllToolDefinitions` is one 2,811-line function |
| Functions > 100 lines | 56 (19 over 200) |
| Core public named exports | 430 (wrappers in this repo use 65) |
| Import cycles (runtime + type) | 2 |
| Distinct `PLUR_*` env vars in prod code | 50 |
| Whole-corpus YAML writers | 2 (`saveEngrams`, `YamlStore.save`) |
| Storage-shaped interfaces | 3 (`PrimaryStore`, `EngramStore`, `StorageAdapter`) |
| Verbatim cross-package duplicates | core↔claw telemetry (3 files, ~530 lines), hermes↔langchain `learner.py` (157 lines, byte-identical) |
| Test suite (`pnpm test`) | 348 files passed / 15 skipped; 4,693 tests passed / 159 skipped / 0 failed; 478 s |

(continued below as work lands)
