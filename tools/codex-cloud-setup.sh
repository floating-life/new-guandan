#!/usr/bin/env bash
# Run in a disposable Codex Ubuntu environment, from any working directory.
set -euo pipefail
export POWERSHELL_TELEMETRY_OPTOUT=1

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ "$(uname -s)" != Linux ]]; then
  echo '[codex-setup] This installer is for Linux cloud environments only.' >&2
  exit 1
fi
for dependency in git node python; do
  command -v "$dependency" >/dev/null || {
    echo "[codex-setup] Missing $dependency; select Node 22 and Python 3.12 in the environment settings." >&2
    exit 1
  }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node >=22 is required"); process.exit(1); }'
python -c 'import sys; assert sys.version_info >= (3, 12), "Python >=3.12 is required"'

if ! command -v pwsh >/dev/null; then
  # Follow Microsoft's Ubuntu package-repository installation procedure.
  # Do not change the host's shell configuration or any agent permission mode.
  source /etc/os-release
  if [[ "$ID" != ubuntu || ! "$VERSION_ID" =~ ^[0-9]+\.[0-9]+$ ]]; then
    echo '[codex-setup] Install PowerShell 7 for this distribution before continuing.' >&2
    exit 1
  fi
  run_as_root=()
  if (( EUID != 0 )); then
    command -v sudo >/dev/null && sudo -n true || {
      echo '[codex-setup] PowerShell installation needs root or non-interactive sudo in the disposable container.' >&2
      exit 1
    }
    run_as_root=(sudo -n)
  fi
  "${run_as_root[@]}" apt-get update
  "${run_as_root[@]}" apt-get install -y ca-certificates curl
  setup_temp="$(mktemp -d)"
  trap 'rm -rf -- "$setup_temp"' EXIT
  curl --fail --show-error --location --retry 2 --connect-timeout 20 --max-time 120 \
    "https://packages.microsoft.com/config/ubuntu/$VERSION_ID/packages-microsoft-prod.deb" \
    --output "$setup_temp/packages-microsoft-prod.deb"
  "${run_as_root[@]}" dpkg -i "$setup_temp/packages-microsoft-prod.deb"
  "${run_as_root[@]}" apt-get update
  "${run_as_root[@]}" apt-get install -y powershell
fi

# The existing verification suite exercises small synthetic CPU training cases.
# Require torch up front so its adaptive skip guard cannot hide missing coverage.
if ! python -c 'import torch' >/dev/null 2>&1; then
  python -m pip install --disable-pip-version-check \
    torch --index-url https://download.pytorch.org/whl/cpu
fi

bash "$repo_root/tools/codex-cloud-check.sh" --preflight
echo '[codex-setup] Dependencies ready. No project tests, data collection, or research training were started.'
