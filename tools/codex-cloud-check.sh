#!/usr/bin/env bash
# Keep tools/verify.ps1 as the single source of verification commands.
set -euo pipefail
export POWERSHELL_TELEMETRY_OPTOUT=1

if (( $# > 1 )) || { (( $# == 1 )) && [[ "$1" != --preflight ]]; }; then
  echo 'Usage: bash tools/codex-cloud-check.sh [--preflight]' >&2
  exit 2
fi
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

for dependency in git node python pwsh; do
  command -v "$dependency" >/dev/null || {
    echo "[codex-check] Missing $dependency. Run bash tools/codex-cloud-setup.sh during environment setup." >&2
    exit 1
  }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1); console.log("[codex-check] Node " + process.version);'
python - <<'PY'
import sys
assert sys.version_info >= (3, 12), 'Python >=3.12 is required'
import torch
sys.path.insert(0, 'tools')
import train_learning_model
assert torch.tensor([1.0], device='cpu').item() == 1.0
print(f'[codex-check] Python {sys.version.split()[0]}; torch {torch.__version__}; CPU available')
PY
pwsh -NoLogo -NoProfile -NonInteractive -Command \
  'if ($PSVersionTable.PSVersion.Major -lt 7) { exit 1 }; Write-Output ("[codex-check] PowerShell " + $PSVersionTable.PSVersion)'
echo "[codex-check] Source $(git rev-parse HEAD)"

if [[ "${1:-}" == --preflight ]]; then
  exit 0
fi
echo '[codex-check] Running the existing default verification suite; this is not release evidence.'
exec pwsh -NoLogo -NoProfile -NonInteractive -File "$repo_root/tools/verify.ps1"
