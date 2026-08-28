param(
  [switch]$FullData,
  [string]$Dataset = 'data/selfplay-20260901.jsonl',
  [string]$Model = 'data/value-model-20260901-experimental.json',
  [string]$GatedModel = 'data/value-model-20260901-gated.json',
  [string]$ABReport = 'data/value-model-20260901-ab.json',
  [string]$ContinuousCheckpoint = 'data/value-model-20260901-continuous.checkpoint.json'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$stepCount = 0
function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Action
  )
  Write-Host ("[verify] {0}" -f $Name)
  try {
    & $Action
    if ($LASTEXITCODE -ne 0) {
      throw "exit code $LASTEXITCODE"
    }
    $script:stepCount += 1
  } catch {
    Write-Error ("[verify] FAILED: {0}: {1}" -f $Name, $_.Exception.Message)
    exit 1
  }
}

function Resolve-RequiredProjectFile {
  param(
    [string]$Name,
    [string]$Value
  )
  $candidate = if ([System.IO.Path]::IsPathRooted($Value)) { $Value } else { Join-Path $root $Value }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "$Name is required for -FullData but was not found: $candidate"
  }
  return (Resolve-Path -LiteralPath $candidate).Path
}

Invoke-Step 'git diff --check' {
  git diff --check
}

Invoke-Step 'JavaScript/MJS syntax' {
  $files = @(Get-ChildItem -Path js, tools -File -Recurse |
    Where-Object { $_.Extension -in @('.js', '.mjs') })
  foreach ($file in $files) {
    node --check $file.FullName
    if ($LASTEXITCODE -ne 0) { throw "syntax error: $($file.FullName)" }
  }
}

Invoke-Step 'Python syntax' {
  $files = @(Get-ChildItem -Path tools -Filter *.py -File -Recurse)
  foreach ($file in $files) {
    python -m py_compile $file.FullName
    if ($LASTEXITCODE -ne 0) { throw "syntax error: $($file.FullName)" }
  }
}

Invoke-Step 'PowerShell syntax' {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $root 'start-lan.ps1'),
    [ref]$tokens,
    [ref]$errors
  ) | Out-Null
  if ($errors.Count) { throw (($errors | ForEach-Object { $_.Message }) -join '; ') }
}

$nodeTests = @(
  'js/rules.test.js',
  'js/ai.test.js',
  'js/ai.hybrid.test.js',
  'js/opponent-model.test.js',
  'js/value-model-gate.test.js',
  'js/value-model-persistence.test.js',
  'js/ai.worker.test.js',
  'js/ai.worker.integration.test.js',
  'js/game.test.js',
  'js/stats.test.js',
  'js/ui.static.test.js',
  'js/llm.test.js',
  'js/llm.integration.test.js',
  'js/integration.test.js',
  'tools/test_replay_external_to_v2.mjs',
  'tools/test_validate_external_adapter_dataset.mjs',
  'tools/test_validate_external_replay_policy.mjs'
)
foreach ($test in $nodeTests) {
  Invoke-Step "node $test" {
    node $test
  }
}

$pythonTests = @(
  'lan_server.test.py',
  'tools/test_import_botzone_guandan.py',
  'tools/test_import_njupt_data.py',
  'tools/download_njupt_archives.py --self-test'
)
foreach ($test in $pythonTests) {
  Invoke-Step "python $test" {
    $parts = $test -split ' '
    python @parts
  }
}

if ($FullData) {
  $datasetPath = Resolve-RequiredProjectFile 'Dataset' $Dataset
  $modelPath = Resolve-RequiredProjectFile 'Model' $Model
  $gatedModelPath = Resolve-RequiredProjectFile 'GatedModel' $GatedModel
  $abReportPath = Resolve-RequiredProjectFile 'ABReport' $ABReport
  $continuousCheckpointPath = Resolve-RequiredProjectFile 'ContinuousCheckpoint' $ContinuousCheckpoint
  $adapter = Join-Path $root '训练数据/验证/external-adapter-trajectory-v1.jsonl'
  $status = Join-Path $root '训练数据/验证/external-wind-action-audit-status.json'
  $externalTrajectory = Join-Path $root '训练数据/验证/external-trajectory-v2.jsonl'
  $externalStatus = Join-Path $root '训练数据/验证/external-replay-status.json'
  Invoke-Step 'strict self-play dataset' {
    node tools/validate_value_dataset.mjs $datasetPath
  }
  Invoke-Step 'experimental value model schema' {
    node tools/validate_value_model.mjs $modelPath
  }
  Invoke-Step 'gated value model schema' {
    node tools/validate_value_model.mjs $gatedModelPath
  }
  Invoke-Step 'value model evidence bundle' {
    node tools/validate_value_evidence.mjs --model $modelPath --report $abReportPath --continuous-checkpoint $continuousCheckpointPath
  }
  if ((Test-Path $adapter) -and (Test-Path $status)) {
    Invoke-Step 'external adapter isolation' {
      node tools/validate_external_adapter_dataset.mjs --trajectory $adapter --status $status
    }
  } else { Write-Host '[verify] skip external adapter isolation (files not present)' }
  if ((Test-Path $externalTrajectory) -and (Test-Path $externalStatus)) {
    Invoke-Step 'external replay isolation policy' {
      node tools/validate_external_replay_policy.mjs --trajectory $externalTrajectory --status $externalStatus
    }
  } else { Write-Host '[verify] skip external replay isolation policy (files not present)' }
}

Write-Host ("[verify] OK: {0} checks" -f $stepCount)
