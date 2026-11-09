param([int]$Port = 3090)

$ErrorActionPreference = 'SilentlyContinue'
$root  = Split-Path -Parent $PSScriptRoot
$state = Join-Path $root '.tools'
$runJson = Join-Path $state 'run.json'

Write-Host ''
Write-Host '  正在停止演示 ...' -ForegroundColor White

if (Test-Path $runJson) {
  try {
    $run = Get-Content $runJson -Raw | ConvertFrom-Json
    foreach ($id in @($run.server, $run.tunnel)) {
      if ($id) {
        $p = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($p -and ($p.ProcessName -in @('node', 'ngrok', 'cloudflared'))) {
          Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        }
      }
    }
  } catch { }
  Remove-Item $runJson -Force -ErrorAction SilentlyContinue
}

foreach ($name in @('ngrok', 'cloudflared')) {
  Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

$owners = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
foreach ($procId in $owners) {
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
}

Start-Sleep -Milliseconds 600
$left = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($left) {
  Write-Host "  端口 $Port 还有进程在监听，可能不是本项目的程序，没有动它。" -ForegroundColor Yellow
} else {
  Write-Host '  已停止：公网地址失效，本机服务也已关闭。' -ForegroundColor Green
}
Write-Host ''
