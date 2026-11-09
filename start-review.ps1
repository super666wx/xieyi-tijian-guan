# 以「评审模式」启动：开启账号口令 +（可选）公网隧道
# 用法：
#   powershell -ExecutionPolicy Bypass -File start-review.ps1
#   powershell -ExecutionPolicy Bypass -File start-review.ps1 -Tunnel
#   powershell -ExecutionPolicy Bypass -File start-review.ps1 -User hfk -Password 000000 -Port 3090 -Tunnel
#   powershell -ExecutionPolicy Bypass -File start-review.ps1 -Tunnel -Fixed   # 固定域名（见 tools\fixed-tunnel.ps1）
#   powershell -ExecutionPolicy Bypass -File start-review.ps1 -Chat           # 打开追问助手（默认关闭）
#
# 默认值：账号 hfk，密码 000000，端口 3090，不开隧道（只在本机访问）；追问助手默认关闭

param(
  [string]$User = 'hfk',
  [string]$Password = '000000',
  [int]$Port = 3090,
  [switch]$Tunnel,
  [switch]$Fixed,
  [switch]$Chat
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

# 找 node：优先 PATH，找不到就用常见安装位置
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\nvs\Microsoft\node\node.exe")) {
    if (Test-Path $p) { $node = $p; break }
  }
}
if (-not $node) {
  Write-Host '没有找到 Node.js。请先安装 Node.js 18 或更高版本：https://nodejs.org/' -ForegroundColor Red
  Read-Host '按回车关闭'
  exit 1
}

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host '首次运行：正在安装依赖（约 1~2 分钟）…' -ForegroundColor Cyan
  & cmd /c "npm install --no-audit --no-fund"
}

if (-not (Test-Path (Join-Path $root '.tools\cloudflared.exe')) -and $Tunnel) {
  Write-Host '首次运行：需要下载 cloudflared（约 55MB）…' -ForegroundColor Cyan
}

$env:PORT = "$Port"
$env:ACCESS_USER = $User
$env:ACCESS_PASSWORD = $Password
$env:HOST = '127.0.0.1'
# 追问助手默认跟随 config.json（出厂 false）；加 -Chat 可临时打开，公网链接被转发会消耗 API 额度
if ($Chat) { $env:CHAT_ENABLED = '1' } else { Remove-Item Env:\CHAT_ENABLED -ErrorAction SilentlyContinue }

Write-Host ''
Write-Host '协议体检官 · 评审模式' -ForegroundColor Green
Write-Host "  本机地址   http://127.0.0.1:$Port" -ForegroundColor Gray
Write-Host "  账号       $User" -ForegroundColor Gray
Write-Host "  密码       $Password" -ForegroundColor Gray
Write-Host ("  追问助手   " + $(if ($Chat) { '开启（会消耗模型额度）' } else { '关闭' })) -ForegroundColor Gray
Write-Host ''

if ($Fixed -and -not $Tunnel) {
  Write-Host '提示：-Fixed 要与 -Tunnel 一起用才会开固定域名；本次只在本机启动。' -ForegroundColor Yellow
}

if ($Tunnel) {
  $server = Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $root -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 3
  Write-Host "本地服务已启动（进程 $($server.Id)）" -ForegroundColor DarkGray
  try {
    if ($Fixed) {
      & (Join-Path $root 'tools\fixed-tunnel.ps1') -Port $Port
    } else {
      & (Join-Path $root 'tools\tunnel.ps1') -Port $Port
    }
  } finally {
    Write-Host ''
    Write-Host '正在关闭本地服务…' -ForegroundColor DarkGray
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
    if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  }
} else {
  & $node server.js
}


