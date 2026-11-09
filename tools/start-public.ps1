param(
  [int]$Port = 3090,
  [string]$User = 'hfk',
  [string]$Password = '000000',
  [switch]$Reset,
  [switch]$Quick,
  [switch]$NoWait
)

$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$tools = $PSScriptRoot
$state = Join-Path $root '.tools'
$ngrokTxt = Join-Path $state 'ngrok.txt'
$ngrokYml = Join-Path $state 'ngrok.yml'
$runJson  = Join-Path $state 'run.json'
$srvOut   = Join-Path $state 'server.out.log'
$srvErr   = Join-Path $state 'server.err.log'
$tunOut   = Join-Path $state 'tunnel.out.log'
$tunErr   = Join-Path $state 'tunnel.err.log'
Set-Location $root
if (-not (Test-Path $state)) { New-Item -ItemType Directory -Path $state | Out-Null }

function Line($text = '', $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail($text) {
  Line ''
  Line ('  ' + $text) 'Red'
  Line ''
  if ($NoWait) { exit 1 }
  Read-Host '按回车关闭'
  exit 1
}
function Find-Bin([string]$name) {
  foreach ($dir in @($tools, $state)) {
    $p = Join-Path $dir $name
    if (Test-Path $p) { return $p }
  }
  return $null
}
function Port-Busy([int]$p) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  return [bool]$c
}
function Health([int]$p) {
  # 只让 node 回 ASCII 摘要（规则数|法条数|追问状态），避免 PowerShell 用 ANSI 解码中文 JSON 后解析失败
  $code = "fetch('http://127.0.0.1:$p/api/health',{signal:AbortSignal.timeout(2500)}).then(r=>r.json()).then(j=>process.stdout.write([j.rules||0,(j.law&&j.law.articles)||0,(j.chat&&j.chat.enabled)?(j.chat.mode||'on'):'off'].join('|'))).catch(()=>process.stdout.write('ERR'))"
  try { $o = & node -e $code 2>$null } catch { return $null }
  $t = ($o | Out-String -Width 8192).Trim()
  if ($t -and $t -notmatch '^ERR') { return $t } else { return $null }
}
function Get-Status([string]$url) {
  $code = "fetch('$url',{signal:AbortSignal.timeout(8000),redirect:'manual'}).then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('ERR'))"
  try { $o = & node -e $code 2>$null } catch { return 'ERR' }
  return (($o | Out-String -Width 8192).Trim())
}
function Wait-Url([string[]]$files, [string]$pattern, $proc, [int]$seconds = 20) {
  for ($i = 0; $i -lt ($seconds * 2); $i++) {
    Start-Sleep -Milliseconds 500
    if ($proc -and $proc.HasExited) { return $null }
    foreach ($file in $files) {
      if (-not (Test-Path $file)) { continue }
      $text = Get-Content $file -Raw -ErrorAction SilentlyContinue
      if (-not $text) { continue }
      $m = [regex]::Match($text, $pattern)
      if ($m.Success) {
        if ($m.Groups.Count -gt 1 -and $m.Groups[1].Success) { return $m.Groups[1].Value }
        return $m.Value
      }
    }
  }
  return $null
}
function Tail([string]$file, [int]$n = 6) {
  if (-not (Test-Path $file)) { return '' }
  $lines = Get-Content $file -ErrorAction SilentlyContinue
  if (-not $lines) { return '' }
  return (($lines | Select-Object -Last $n) -join "`n")
}

Line ''
Line '  协议体检官 · 公网演示' 'White'
Line '  --------------------------------------------'

# ---------- 1. 隧道凭证 ----------
$token = $null
$domain = $null
if ((Test-Path $ngrokTxt) -and -not $Reset) {
  $kv = @{}
  foreach ($ln in Get-Content $ngrokTxt) {
    if ($ln -match '^\s*([a-z]+)\s*=\s*(.+?)\s*$') { $kv[$matches[1]] = $matches[2] }
  }
  if ($kv['token']) { $token = $kv['token'] }
  if ($kv['domain']) { $domain = $kv['domain'] }
}

if ($Quick) { $token = $null; $domain = $null }

if ((-not $token) -and (-not $Quick)) {
  Line ''
  Line '  还没有配置固定地址。想拿到一个每次都一样的网址，需要两样东西，都在 ngrok 后台，免费：' 'White'
  Line ''
  Line '    Authtoken   dashboard.ngrok.com/get-started/your-authtoken'
  Line '    静态域名    dashboard.ngrok.com/domains  ->  New Domain  ->  复制'
  Line ''
  Line '  不想配也可以直接回车：先用临时地址，能马上用，但每次重启都会变。' 'DarkGray'
  Line ''
  $token = Read-Host '  粘贴 Authtoken（直接回车跳过）'
  if ($token) {
    $token = $token.Trim()
    if ($token.Length -lt 20) { Fail 'Authtoken 太短，像是没复制全。重新复制一次，整段粘进来。' }
    $domain = Read-Host '  粘贴域名（形如 your-name.ngrok-free.app，不要带 https://）'
    if ($domain) {
      $domain = ($domain.Trim() -replace '^https?://', '' -replace '/.*$', '').Trim()
      if ($domain -notmatch '\.') { Fail '域名看起来不对。去 dashboard.ngrok.com/domains 复制那个不带 https:// 的地址。' }
      @("token=$token", "domain=$domain") | Set-Content -Path $ngrokTxt -Encoding UTF8
      Line ''
      Line "  已记到 .tools\ngrok.txt，下次不用再粘。" 'DarkGray'
    } else {
      @("token=$token", "domain=") | Set-Content -Path $ngrokTxt -Encoding UTF8
    }
  }
}

# ---------- 2. 端口 ----------
if (Port-Busy $Port) {
  Line ''
  Line "  端口 $Port 已经被占用，先把它停掉。" 'Yellow'
  $pids = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
  foreach ($procId in $pids) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
  }
  Start-Sleep -Milliseconds 800
  if (Port-Busy $Port) { Fail "端口 $Port 仍被别的程序占用，先关掉它再运行（常见是残留的 node 或别的服务）。" }
}

# ---------- 3. 起服务 ----------
$env:PORT = "$Port"
$env:HOST = '127.0.0.1'
$env:ACCESS_USER = $User
$env:ACCESS_PASSWORD = $Password
Remove-Item Env:\CHAT_ENABLED -ErrorAction SilentlyContinue

$srv = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $srvOut -RedirectStandardError $srvErr

$h = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  if ($srv.HasExited) { Fail ("服务没起来，看日志：.tools\server.err.log`n" + (Tail $srvErr 8)) }
  $h = Health $Port
  if ($h) { break }
}
if (-not $h) { Fail '服务 15 秒内没有响应 /api/health，看 .tools\server.err.log。' }

$parts = $h -split '\|'
$rules = if ($parts.Count -ge 1 -and $parts[0]) { $parts[0] } else { '?' }
$lawN = if ($parts.Count -ge 2 -and $parts[1]) { $parts[1] } else { '?' }
$chat = if ($parts.Count -ge 3 -and $parts[2]) { $parts[2] } else { '?' }
Line ''
Line "  服务已启动：127.0.0.1:$Port   规则 $rules 条 / 法条 $lawN 条 / 追问 $chat" 'Green'

# ---------- 4. 起隧道 ----------
$tunnel = $null
$url = $null
$kind = ''

if ($token -and $domain) {
  $ngrok = Find-Bin 'ngrok.exe'
  if (-not (Test-Path $ngrok)) { Fail '缺少 tools\ngrok.exe，先把 ngrok 放回来（或删掉 .tools\ngrok.txt 改用临时地址）。' }
  & $ngrok config add-authtoken $token --config $ngrokYml 2>&1 | Out-Null
  Line "  正在用固定域名 $domain 开隧道 ..." 'DarkGray'
  $tunnel = Start-Process -FilePath $ngrok -ArgumentList @('http', "$Port", "--url=$domain", "--config=$ngrokYml", '--log=stdout', '--log-format=logfmt') -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $tunOut -RedirectStandardError $tunErr
  $url = Wait-Url @($tunOut, $tunErr) 'url=(https://[a-z0-9][a-z0-9\-\.]*\.ngrok[a-z0-9\-\.]*)' $tunnel 20
  if ($url -and $url -notlike "*$domain*") { $url = $null }
  $kind = 'ngrok-fixed'
  if (-not $url) {
    $t = Tail $tunOut 10
    Line ''
    if ($t -match 'ERR_NGROK_105|invalid|authentication') { Fail ("ngrok 认不出这个 Authtoken。去 dashboard.ngrok.com/get-started/your-authtoken 重新复制整段，再运行一次。`n" + $t) }
    if ($t -match 'ERR_NGROK_3200') { Fail ("域名 $domain 没绑到这个账号，或者已经被别的会话占用。到 dashboard.ngrok.com/domains 确认它是 Active。`n" + $t) }
    Fail ("隧道没起来，日志在 .tools\tunnel.out.log`n" + $t)
  }
} else {
  $cf = Find-Bin 'cloudflared.exe'
  if (-not (Test-Path $cf)) { Fail '既没有 ngrok 凭证，也找不到 tools\cloudflared.exe，无法开临时地址。' }
  Line '  正在开临时地址（trycloudflare）...' 'DarkGray'
  $tunnel = Start-Process -FilePath $cf -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$Port", '--no-autoupdate') -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $tunOut -RedirectStandardError $tunErr
  $url = Wait-Url @($tunErr, $tunOut) 'https://[a-z0-9\-]+\.trycloudflare\.com' $tunnel 25
  if ($url -and $url -notlike '*trycloudflare.com*') { $url = $null }
  $kind = 'quick'
  if (-not $url) { Fail ("临时地址没拿到，日志在 .tools\tunnel.err.log`n" + (Tail $tunErr 8)) }
}

# ---------- 5. 验证 ----------
Line "  正在验证公网可达性 ..." 'DarkGray'
$ok = $false
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Seconds 2
  $st = Get-Status $url
  if ($st -eq '200' -or $st -eq '302') { $ok = $true; break }
}
if (-not $ok) {
  Line "  公网暂时打不开（HTTP $st）。本机服务是好的，通常是隧道刚起来还在生效，或者本机网络出站被拦。" 'Yellow'
}

@{ server = $srv.Id; tunnel = $tunnel.Id; url = $url; kind = $kind; port = $Port } | ConvertTo-Json | Set-Content -Path $runJson -Encoding UTF8

Line ''
Line '  ============================================' 'White'
Line "  地址  $url" 'Green'
Line "  账号  $User" 'White'
Line "  口令  $Password" 'White'
Line '  ============================================' 'White'
if ($kind -eq 'quick') {
  Line ''
  Line '  这是临时地址，关掉窗口或重启就换一个。要固定地址，配一次 ngrok：' 'Yellow'
  Line '  删掉 .tools\ngrok.txt，再运行一次这个脚本，按提示粘 Authtoken 和域名。' 'Yellow'
} else {
  Line ''
  Line "  固定地址，以后每次都是这个。首次访问 ngrok 会有一个提示页，点 Visit Site 就进去。" 'DarkGray'
}
Line ''
Line '  演示期间不要关这个窗口。关掉窗口地址就失效；要停，双击「停止演示.bat」。' 'Yellow'
Line ''

if ($NoWait) { exit 0 }

while ($true) {
  Start-Sleep -Seconds 8
  if ($srv.HasExited) {
    Line '  服务进程退出了。看 .tools\server.err.log。' 'Red'
    Line (Tail $srvErr 8)
    break
  }
  if ($tunnel -and $tunnel.HasExited) {
    Line '  隧道进程退出了。看 .tools\tunnel.out.log 或 .tools\tunnel.err.log。' 'Red'
    Line (Tail $tunOut 8)
    break
  }
}

Remove-Item $runJson -ErrorAction SilentlyContinue
Read-Host '按回车关闭'
