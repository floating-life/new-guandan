# Security Policy

## Supported code

Security fixes are applied to the current `main` branch. The project is local-first, but security-sensitive areas include the local HTTP gateway, replay/persistence handling, optional cloud-enhancement configuration, API-key handling, and hidden-information boundaries.

## Reporting a vulnerability

Please do not publish exploit details, API keys, private data, or a working proof of concept in a public issue.

Use GitHub's private vulnerability reporting / security advisory flow for this repository when available. If that option is unavailable, open a public issue titled **Security contact requested** with no sensitive technical details; the maintainer will establish a private channel before details are shared.

## What to include privately

- affected component and revision;
- reproduction conditions;
- security or privacy impact;
- whether hidden information, local files, credentials, or remote requests are involved;
- a minimal proof of concept if safe to share privately.

The maintainer will prioritize reproducibility, containment, regression coverage, and a clear release note for confirmed security defects.
