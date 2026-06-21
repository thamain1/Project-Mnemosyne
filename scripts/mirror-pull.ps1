# =============================================================================
# mirror-pull.ps1 — bring the Mnemosyne strategy (and OPTIONALLY the memory brain)
# onto THIS machine.
#
#   .\mirror-pull.ps1                       # DRY: preview the strategy install (no writes)
#   .\mirror-pull.ps1 -Apply                # install STRATEGY ONLY: hooks + CLAUDE.md rules.
#                                           #   Does NOT touch project memory — SAFE on a machine
#                                           #   working its own project (e.g. IntelliOptics 2.5).
#   .\mirror-pull.ps1 -Apply -FullMemory    # ALSO overwrite this machine's memory with the shared
#                                           #   brain. DESTRUCTIVE to local memory — continuity
#                                           #   machines ONLY. Backs up first.
#
# Secrets in pulled memory are {{VAULTED → get_secret('id')}} pointers; fetch real values via the
# Mnemosyne MCP get_secret tool. Prereq: repo cloned + mcp\.env.local present (from setup).
# =============================================================================
param(
  [switch]$Apply,
  [switch]$FullMemory,
  [string]$MemoryDir = "$env:USERPROFILE\.claude\projects\c--Dev\memory",
  [string]$ClaudeMd  = "$env:USERPROFILE\.claude\CLAUDE.md"
)
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot
Write-Host "repo: $RepoRoot" -ForegroundColor Cyan

# 1. latest code
Write-Host "Pulling latest repo..." -ForegroundColor Cyan
git pull --ff-only

# 2. STRATEGY install (hooks + CLAUDE.md + settings) — safe, no memory, no DB
$gArgs = @('scripts/install-governance.mjs'); if ($Apply) { $gArgs += '--apply' }
node @gArgs
if ($LASTEXITCODE -ne 0) { Write-Error "governance install failed (see above)." }

# 3. OPTIONAL full memory restore (DESTRUCTIVE to local memory)
if ($FullMemory) {
  if (-not $Apply) {
    Write-Host "`n-FullMemory requires -Apply. Re-run with both to restore memory." -ForegroundColor Yellow
  } else {
    Write-Host "`n*** -FullMemory: this OVERWRITES this machine's memory with the shared brain. ***" -ForegroundColor Red
    Write-Host "*** If this machine is working its OWN project, this will lose its place.      ***" -ForegroundColor Red
    $ans = Read-Host "Type EXACTLY 'overwrite-memory' to proceed, anything else to skip"
    if ($ans -ne 'overwrite-memory') {
      Write-Host "Skipped memory restore (strategy was still installed)." -ForegroundColor Yellow
    } else {
      if (-not (Test-Path 'mcp\.env.local')) { Write-Error "mcp\.env.local not found — run setup-mnemosyne-mcp.ps1 first." }
      if (-not (Test-Path 'node_modules\@supabase\supabase-js')) { Write-Host "npm ci (for the restore)..." -ForegroundColor Cyan; npm ci }
      $Staging = Join-Path $RepoRoot '.mirror-restore'
      $env:MIRROR_RESTORE_DIR = $Staging
      node --env-file=mcp/.env.local scripts/mirror-restore.mjs
      if ($LASTEXITCODE -ne 0) { Write-Error "restore reported a failure — not copying memory." }
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      if (Test-Path $ClaudeMd)  { Copy-Item $ClaudeMd "$ClaudeMd.bak-$stamp" }
      if (Test-Path $MemoryDir) { Copy-Item $MemoryDir "$MemoryDir.bak-$stamp" -Recurse } else { New-Item -ItemType Directory -Force -Path $MemoryDir | Out-Null }
      if (Test-Path "$Staging\CLAUDE.md") { Copy-Item "$Staging\CLAUDE.md" $ClaudeMd -Force }
      Copy-Item "$Staging\memory\*" $MemoryDir -Recurse -Force
      Write-Host "memory restored into $MemoryDir (backup made)." -ForegroundColor Green
    }
  }
}

Write-Host "`nRestart Claude Code on this machine to load the changes." -ForegroundColor Green
