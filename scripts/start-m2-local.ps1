# Run only after stopping the existing Next.js dev server (Ctrl+C).
# Local-only QA launcher. Does not read or modify hosted Supabase resources.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  $occupied = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  if ($occupied) {
    throw 'Port 3000 is occupied. Stop the existing Next.js server in its terminal (Ctrl+C), then rerun this local launcher.'
  }

  # Windows PowerShell 5.1 can promote non-fatal native stderr (stopped optional services)
  # into a terminating ErrorRecord when ErrorActionPreference is Stop.
  # Redirect CLI stderr inside cmd.exe instead; capture stdout with keys only in memory.
  $raw = & cmd.exe /d /c 'supabase status -o env 2>NUL'
  if ($LASTEXITCODE -ne 0) {
    throw 'Local Supabase stack is not running. Run supabase start first.'
  }
  $config = @{}
  foreach ($line in $raw) {
    if ($line -match '^([A-Z][A-Z0-9_]*)=(.*)$') {
      $config[$Matches[1]] = $Matches[2].Trim('"').Trim("'")
    }
  }
  if ($config['API_URL'] -ne 'http://127.0.0.1:54321' -or
      -not $config['PUBLISHABLE_KEY'].StartsWith('sb_publishable_') -or
      -not $config['SECRET_KEY'].StartsWith('sb_secret_')) {
    throw 'Local-only guard failed. Refusing to start Next.js against an unknown Supabase target.'
  }

  $env:NEXT_PUBLIC_SUPABASE_URL = $config['API_URL']
  $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = $config['PUBLISHABLE_KEY']
  $env:SUPABASE_SECRET_KEY = $config['SECRET_KEY']
  $env:NEXT_PUBLIC_ALLOW_LOCAL_SUPABASE_HTTP = 'true'

  Write-Host 'PestLaunch M2 local browser QA' -ForegroundColor Green
  Write-Host 'Supabase target: http://127.0.0.1:54321'
  Write-Host 'App URL: http://localhost:3000/login'
  Write-Host 'Hosted project not configured by this launcher.'
  Write-Host 'Press Ctrl+C to stop.'
  & npm.cmd run dev
} finally {
  Pop-Location
}
