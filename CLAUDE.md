# CLAUDE.md

Operating instructions for all projects in this directory. Two pillars: (1) token-optimal model allocation, (2) engineering behavioral guidelines.

---

## 1. Token-Optimal Allocation System

Fable is the orchestrator and brain. It does the thinking; cheaper models do the legwork; Codex provides independent validation. The goal is harmony between quality and token usage — never burn Fable-tier tokens on Haiku-tier work, and never trust Haiku-tier output on Fable-tier decisions.

### Roles

| Tier | Model | Role | Typical tasks |
|------|-------|------|---------------|
| Brain | **Fable** (main loop) | Orchestration, architecture, planning, hard debugging, final synthesis and judgment | Decomposing tasks, design decisions, reviewing/integrating subagent output, anything ambiguous or high-stakes |
| Mid | **Sonnet** (subagent) | Well-scoped implementation | Writing a feature from a clear spec, multi-file refactors with defined boundaries, test suites, data pipelines from a defined schema |
| Low | **Haiku** (subagent) | Mechanical, high-volume, low-ambiguity work | Codebase searches/exploration, summarizing files or docs, boilerplate, renames, formatting, simple scripts, collecting facts |
| Validator | **Codex** (`codex:codex-rescue` agent / `codex` skill) | Independent second opinion from a different model family | Validating non-trivial implementations, second diagnosis when stuck, adversarial review before merge |

### Routing rules

1. **Fable decides, delegates, and verifies.** Every delegated task gets a self-contained prompt (subagents have no conversation context) and explicit success criteria. Fable always reviews returned work before accepting it.
2. **Route by ambiguity, not by size.** A large but mechanical task → Haiku. A small but subtle task (concurrency, numerics, API design) → keep in Fable.
3. **Don't delegate trivial work.** If the task is smaller than the prompt needed to describe it (one-line edit, reading one known file), do it inline. Delegation overhead must be smaller than the work delegated.
4. **Parallelize cheap work.** Independent Haiku/Sonnet tasks launch concurrently in a single message, not sequentially.
5. **Escalate on failure.** If Haiku output is wrong or low-quality, retry once with Sonnet; if Sonnet fails, Fable takes it over directly. Never loop a cheap model on a task it has already failed.
6. **Codex validation triggers:** (a) implementation of anything with correctness risk (data transformations, stats/ML logic, security-sensitive code), (b) Fable is stuck after two debugging attempts, (c) user asks for a review. Skip Codex for trivial or throwaway code.
7. **Exploration is always cheap-tier.** "Find where X is defined," "summarize this repo," "what does this script do" → Haiku/Explore agents. Fable receives conclusions, not file dumps.

### Mechanics

- Use the `Agent` tool with `model: "haiku"` or `model: "sonnet"` for delegation; omit `model` only when the task genuinely needs Fable-tier reasoning in an isolated context.
- Use the `Explore` agent type for read-only searches.
- Use `codex:codex-rescue` for validation passes; give it the diff/files and the original requirements, ask it to refute correctness.

---

## 2. Engineering Workflow

Behavioral guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 2.1 Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2.2 Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 2.3 Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 2.4 Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## 3. Project Source: Portfolio PRD Prompt Pack

Projects in this directory come from the prompt pack in `prompts/`. The workflow:

> **Fable 5 plans → gstack builds.** Take a project's PRD from `prompts/03-android-kotlin.md`, scope it into a build-ready spec, then run the gstack loop (`/office-hours → /autoplan → implement → /review → /qa → /ship`).

- The `<verification_gates>` in each project PRD are the **loop terminators** — the concrete green signal (passing tests, clean build, SMOKE.md walkthrough) that tells the loop the work is done.
- **One project per session.** Don't start the next until the current one's gates are green.
- This directory is the **Android/Kotlin** subject area: Jetpack Compose, Room, Hilt, Coroutines/Flow, clean architecture (ui/domain/data), offline-first.
- Recommended build order: KnowFlow → FocusGrid → ReceiptIQ → MacroLens → AccessCheck.
- Android can't be browser-QA'd: "done" = builds + JVM unit tests pass + Room DAO instrumentation tests pass + Compose previews render + manual SMOKE.md walkthrough passes on an emulator.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, clarifying questions come before implementation rather than after mistakes — and Fable's token spend concentrates on decisions and verification, not mechanical work.
