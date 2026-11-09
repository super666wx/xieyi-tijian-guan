# 固定公网网址：把本机体检服务挂到一个「每次都一样」的域名上（评审链接用）
#
# 与 tunnel.ps1 的区别：
#   tunnel.ps1        → trycloudflare 临时域名，进程一停就换（免费、免注册）
#   fixed-tunnel.ps1  → 固定域名，重启后链接不变（需要一个免费账号 + 一个域名）
#
# 两种接法，任选其一：
#   A. Cloudflare 命名隧道（推荐，免费，需要自己的域名托管在 Cloudflare）
#      1) 一次性准备（在一台能开浏览器的机器上执行）：
#           .tools\cloudflared.exe tunnel login
#           .tools\cloudflared.exe tunnel create protocol-inspector
#           .tools\cloudflared.exe tunnel route dns protocol-inspector jc.example.com
#         （jc.example.com 换成你自己的子域名）
#      2) 拿到 Token（Cloudflare 控制台 → Zero Trust → Networks → Tunnels → 该隧道 → Configure → Token），
#         然后把这个 Token 存到系统环境变量 CLOUDFLARE_TUNNEL_TOKEN，或直接传参：
#           powershell -File tools\fixed-tunnel.ps1 -Port 3090 -Token "<token>" -Hostname jc.example.com
#         也可以不用 Token，改用配置文件：
#           powershell -File tools\fixed-tunnel.ps1 -Port 3090 -ConfigFile .tools\cloudflared-fixed.yml
#         cloudflared-fixed.yml 内容示例：
#           tunnel: <隧道 UUID>
#           credentials-file: C:\Users\你\.cloudflared\<隧道 UUID>.json
#           ingress:
#             - hostname: jc.example.com
#               service: http://127.0.0.1:3090
#             - service: http_status:404
#
#   B. ngrok 静态域名（免费版送 1 个固定域名）
#      先注册 ngrok → 拿到 authtoken 与 static domain（形如 xxx.ngrok-free.app），然后：
#        powershell -File tools\fixed-tunnel.ps1 -Port 3090 -NgrokDomain xxx.ngrok-free.app -NgrokToken <token>
#
# 用法汇总：
#   powershell -File tools\fixed-tunnel.ps1                       # 只打印准备步骤
#   powershell -File tools\fixed-tunnel.ps1 -Port 3090 -Token ... # Cloudflare 命名隧道
#   powershell -File tools\fixed-tunnel.ps1 -Port 3090 -NgrokDomain ... -NgrokToken ...

param(
  [int]$Port = 3090,
  [string]$Token = $env:CLOUDFLARE_TUNNEL_TOKEN,
  [string]$Hostname = $env:PUBLIC_HOSTNAME,
  [string]$ConfigFile = '',
  [string]$TunnelName = '',
  [string]$NgrokDomain = $env:NGROK_DOMAIN,
  [string]$NgrokToken = $env:NGROK_AUTHTOKEN
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$toolDir = Join-Path $root '.tools'
if (-not (Test-Path $toolDir)) { New-Item -ItemType Directory -Force -Path $toolDir | Out-Null }

function Show-SetupGuide {
  Write-Host ''
  Write-Host '  固定网址需要先做一次性准备（免费），二选一：' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  【A】Cloudflare 命名隧道（推荐）' -ForegroundColor Cyan
  Write-Host '    1. 在 Cloudflare 建一个免费账号，把域名接进来（改 NS 生效后可用）' -ForegroundColor Gray
  Write-Host '    2. 执行下面三条（只需一次）：' -ForegroundColor Gray
  Write-Host '         .tools\cloudflared.exe tunnel login' -ForegroundColor White
  Write-Host '         .tools\cloudflared.exe tunnel create protocol-inspector' -ForegroundColor White
  Write-Host '         .tools\cloudflared.exe tunnel route dns protocol-inspector jc.你的域名.com' -ForegroundColor White
  Write-Host '    3. 控制台 Zero Trust → Networks → Tunnels → 该隧道 → Configure，Public hostname 指向' -ForegroundColor Gray
  Write-Host "         http://127.0.0.1:$Port" -ForegroundColor White
  Write-Host '    4. 复制该页的 Token，然后启动：' -ForegroundColor Gray
  Write-Host '         powershell -File tools\fixed-tunnel.ps1 -Token "<token>" -Hostname jc.你的域名.com' -ForegroundColor White
  Write-Host ''
  Write-Host '  【B】ngrok 静态域名（免费版 1 个）' -ForegroundColor Cyan
  Write-Host '    注册 ngrok → 复制 authtoken 与 static domain，然后：' -ForegroundColor Gray
  Write-Host '         powershell -File tools\fixed-tunnel.ps1 -NgrokDomain xxx.ngrok-free.app -NgrokToken <token>' -ForegroundColor White
  Write-Host ''
  Write-Host '  临时域名（免注册、每次变）：powershell -File tools\tunnel.ps1' -ForegroundColor DarkGray
  Write-Host ''
}

function Get-Cloudflared {
  $exe = Join-Path $toolDir 'cloudflared.exe'
  if (-not (Test-Path $exe)) {
    Write-Host '首次运行：正在下载 cloudflared（约 55MB，只需一次）…' -ForegroundColor Cyan
    $url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
  }
  return $exe
}

# 本地服务必须先在跑
$ok = $false
try {
  $tcp = New-Object System.Net.Sockets.TcpClient
  $async = $tcp.BeginConnect('127.0.0.1', $Port, $null, $null)
  if ($async.AsyncWaitHandle.WaitOne(3000)) { $tcp.EndConnect($async); $ok = $tcp.Connected }
  $tcp.Close()
} catch { }
if (-not $ok) {
  Write-Host "警告：127.0.0.1:$Port 没有响应 —— 请先启动服务（start-review.ps1 或 npm start）" -ForegroundColor Yellow
  Write-Host ''
}

if (-not $ConfigFile -and (Test-Path (Join-Path $toolDir 'cloudflared-fixed.yml'))) {
  $ConfigFile = Join-Path $toolDir 'cloudflared-fixed.yml'
}

# 控制台 Token 方式：配置脚本把 token 存在 .tools\cf-token.txt，这里自动读
if (-not $Token) {
  $tokenFile = Join-Path $toolDir 'cf-token.txt'
  if (Test-Path $tokenFile) {
    $Token = (Get-Content $tokenFile -Raw).Trim()
    if ($Token -and -not $PSBoundParameters.ContainsKey('ConfigFile')) { $ConfigFile = '' }
  }
}

# ngrok 配置脚本把 domain / token 存在 .tools\ngrok.txt，这里自动读
if (-not $NgrokDomain) {
  $ngrokCfg = Join-Path $toolDir 'ngrok.txt'
  if (Test-Path $ngrokCfg) {
    foreach ($line in Get-Content $ngrokCfg) {
      if ($line -match '^\s*domain\s*=\s*(.+)$') { $NgrokDomain = $Matches[1].Trim() }
      if ($line -match '^\s*token\s*=\s*(.+)$') { $NgrokToken = $Matches[1].Trim() }
    }
  }
}

if ($NgrokDomain) {
  $ngrok = (Get-Command ngrok -ErrorAction SilentlyContinue).Source
  if (-not $ngrok) {
    $local = Join-Path $toolDir 'ngrok.exe'
    if (Test-Path $local) { $ngrok = $local }
  }
  if (-not $ngrok) {
    Write-Host '没有找到 ngrok.exe：请先运行 tools\setup-ngrok.ps1（或把 ngrok.exe 放到 .tools\）' -ForegroundColor Red
    exit 1
  }
  $yml = Join-Path $toolDir 'ngrok.yml'
  if ($NgrokToken) { & $ngrok config add-authtoken $NgrokToken --config $yml | Out-Null }
  Write-Host ''
  Write-Host ('  固定地址：https://' + $NgrokDomain) -ForegroundColor Green
  Write-Host '  保持本窗口打开；关闭窗口即停止公网访问。' -ForegroundColor DarkGray
  Write-Host ''
  & $ngrok http $Port "--url=$NgrokDomain" --config $yml --log=stdout
  exit $LASTEXITCODE
}

if ($Token -or $ConfigFile) {
  $exe = Get-Cloudflared
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 600
  Write-Host ''
  if ($Hostname) {
    Write-Host ('  固定地址：https://' + $Hostname) -ForegroundColor Green
  } else {
    Write-Host '  正在用命名隧道连接（域名以 Cloudflare 控制台配置的 Public hostname 为准）' -ForegroundColor Green
  }
  Write-Host '  保持本窗口打开；关闭窗口即停止公网访问。' -ForegroundColor DarkGray
  Write-Host ''
  if ($ConfigFile) {
    $argList = @('tunnel', '--config', $ConfigFile)
    if ($TunnelName) { $argList += 'run'; $argList += $TunnelName } else { $argList += 'run' }
    & $exe @argList
  } else {
    & $exe tunnel run --token $Token --no-autoupdate
  }
  exit 0
}

Show-SetupGuide
exit 1
