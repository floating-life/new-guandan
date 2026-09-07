# Contributing to new-guandan

Thanks for helping improve the project. Contributions are welcome for rules correctness, AI strategy, evaluation tooling, replay/analysis, local-first UX, tests, documentation, and performance.

## Before you start

1. Read `README.md` for the product and privacy boundaries.
2. Read `AGENTS.md` if you use an AI coding agent in this repository.
3. For non-trivial behavior changes, open an issue first so the intended rule/evaluation contract is explicit.

## Development and verification

Run the unified verification entry point before opening a pull request:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\verify.ps1
```

If your change touches evaluation data or release evidence, follow the stricter evidence rules documented in the roadmap and `todo.md`. Do not regenerate or reinterpret formal evaluation artifacts merely to make a gate pass.

## Fair-play and privacy invariants

Changes must preserve these boundaries:

- Runtime AI must not read cards or private state that would be hidden from a human player in the same seat.
- Optional cloud enhancement may only rank locally filtered legal candidates; it must not receive undisclosed hands.
- API keys must never be committed, stored in browser `localStorage`, or included in reports.
- Training/evaluation data must respect the repository's eligibility and sealing rules.

## Pull requests

A good PR should include:

- the problem and intended behavior;
- the smallest reasonable implementation;
- tests or reproducible validation;
- any effect on rules, hidden-information boundaries, evaluation closure, performance, or persistence;
- rollback notes for risky changes.

AI-assisted contributions are welcome. The contributor remains responsible for understanding, testing, and reviewing the submitted code.

## Scope

This project is deliberately local-first and research-oriented. Large platform changes, online account systems, monetization, or changes that weaken the fair-play/privacy model should be discussed before implementation.
