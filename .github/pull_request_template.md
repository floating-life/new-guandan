## What changed

Describe the problem and the smallest implementation that solves it.

## Validation

- [ ] I ran `pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\verify.ps1` or documented why it does not apply.
- [ ] I added or updated tests/evidence for behavior changes.
- [ ] I reviewed the diff for secrets, private data, and accidental generated artifacts.

## Invariants

- [ ] The change does not let runtime AI inspect information hidden from the acting seat.
- [ ] The change does not expose API keys or move them into browser `localStorage`.
- [ ] If evaluation/release evidence changed, the relevant closure, seeds, and provenance remain reproducible.

## Risk / rollback

Note performance, persistence, evaluation, privacy, or compatibility risks and the rollback path.
