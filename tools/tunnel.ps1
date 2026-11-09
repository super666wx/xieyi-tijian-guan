# 临时公网隧道：把本机的体检服务变成 https 链接（评审 / 外网演示用）
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\tunnel.ps1
#   powershell -ExecutionPolicy Bypass -File tools\tunnel.ps1 -Port 3090
#
# 说明：这里强制走 HTTP/2 + IPv4。默认的 QUIC 走 IPv6，
# 在部分运营商网络下会一直卡在 "failed to dial to edge with quic"，拿不到链接。

param([int]$Port = 3090)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$toolDir = Join-Path $root '.tools'
$exe = Join-Path $toolDir 'cloudflared.exe'
$logFile = Join-Path $toolDir 'tunnel.log'
$urlFile = Join-Path $toolDir 'last-url.txt'

if (-not (Test-Path $toolDir)) { New-Item -ItemType Directory -Force -Path $toolDir | Out-Null }

if (-not (Test-Path $exe)) {
  Write-Host '首次运行：正在下载 cloudflared（约 55MB，只需一次）…' -ForegroundColor Cyan
  $url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
  Write-Host '  下载完成。' -ForegroundColor Green
}

# 先把上一次残留的隧道关掉，避免两个进程抢同一个端口
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800
if (Test-Path $logFile) { Remove-Item $logFile -Force }

# 本地服务必须先在跑：直接探 TCP 端口最稳（带口令时 HTTP 会 302/401，判断状态码容易误判）
$ok = $false
try {
  $tcp = New-Object System.Net.Sockets.TcpClient
  $async = $tcp.BeginConnect('127.0.0.1', $Port, $null, $null)
  if ($async.AsyncWaitHandle.WaitOne(3000)) { $tcp.EndConnect($async); $ok = $tcp.Connected }
  $tcp.Close()
} catch { }
if (-not $ok) {
  Write-Host "警告：127.0.0.1:$Port 没有响应 —— 请先双击「启动评审链接.bat」，或单独运行 npm start" -ForegroundColor Yellow
  Write-Host ''
}

Write-Host '正在建立临时公网地址（通常 5~20 秒）…' -ForegroundColor Cyan

# 同时重定向 stderr/stdout：cloudflared 的版本、日志格式在不同版本下会变，
# 双通道抓取比只靠 --logfile 稳。
$errFile = Join-Path $toolDir 'tunnel.err'
if (Test-Path $errFile) { Remove-Item $errFile -Force }
$args = @(
  'tunnel',
  '--url', "http://127.0.0.1:$Port",
  '--no-autoupdate',
  '--protocol', 'http2',
  '--edge-ip-version', '4',
  '--logfile', $logFile
)
$proc = Start-Process -FilePath $exe -ArgumentList $args -PassThru -WindowStyle Hidden `
  -RedirectStandardError $errFile -RedirectStandardOutput (Join-Path $toolDir 'tunnel.out')

function Find-TunnelUrl {
  foreach ($f in @($errFile, $logFile)) {
    if (Test-Path $f) {
      $hit = Select-String -Path $f -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($hit) { return [regex]::Match($hit.Line, 'https://[a-z0-9-]+\.trycloudflare\.com').Value }
    }
  }
  return $null
}

# 最多等 60 秒
$url = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  $url = Find-TunnelUrl
  if ($url) { break }
  if ($proc.HasExited) { $url = Find-TunnelUrl; break }
}

Write-Host ''
if ($url) {
  Set-Content -Path $urlFile -Value $url -Encoding ASCII
  Write-Host '  ==============================================' -ForegroundColor Green
  Write-Host '   公网链接（发给评委的就是这个）' -ForegroundColor Green
  Write-Host "   $url" -ForegroundColor White
  Write-Host '  ==============================================' -ForegroundColor Green
  Write-Host ''
  Write-Host "  账号：hfk      密码：000000" -ForegroundColor Yellow
  Write-Host "  （链接已同时保存到 .tools\last-url.txt）" -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '  保持本窗口打开；关闭窗口或按 Ctrl+C 就停止公网访问。' -ForegroundColor DarkGray
  Write-Host '  注意：这个域名在本次进程结束后失效，下次启动会换一个新域名。' -ForegroundColor DarkGray
  Write-Host ''
} else {
  Write-Host '  没能读到公网链接。下面是 cloudflared 的输出（前 15 行）：' -ForegroundColor Red
  if (Test-Path $errFile) { Get-Content $errFile -TotalCount 15 | ForEach-Object { Write-Host "   $_" -ForegroundColor DarkGray } }
  Write-Host ''
  Write-Host '  常见原因：网络到 Cloudflare 不通（换手机热点试试）、被安全软件拦截、或端口上没有服务。' -ForegroundColor DarkGray
}

# 前台跟随输出，窗口不关，隧道就一直活着
if (Test-Path $errFile) { Get-Content $errFile -Wait -Tail 3 } else { Wait-Process -Id $proc.Id }
