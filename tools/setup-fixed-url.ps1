# 一次性配置：给「协议体检官」准备一个固定的公网网址（Cloudflare 命名隧道）
#
# 交互式，双击 `配置固定网址.bat` 即可。做完之后，以后只要双击 `启动固定网址.bat`，
# 每次拿到的都是同一个 https://<你选的子域名>。
#
# 需要：① 一个 Cloudflare 免费账号；② 一个托管在 Cloudflare 的域名（NS 已生效）。
# 脚本不会改动 config.json，也不会动项目代码。
#
# 出问题时把 .tools\setup-fixed-url.log 的内容发出来即可定位。

param(
  [string]$TunnelName = 'protocol-inspector',
  [string]$Hostname = '',
  [int]$Port = 3090,
  [string]$Token = ''
)

$root = Split-Path -Parent $PSScriptRoot
$toolDir = Join-Path $root '.tools'
$certDir = Join-Path $env:USERPROFILE '.cloudflared'
$certPath = Join-Path $certDir 'cert.pem'
$cfgPath = Join-Path $toolDir 'cloudflared-fixed.yml'
$logPath = Join-Path $toolDir 'setup-fixed-url.log'
if (-not (Test-Path $toolDir)) { New-Item -ItemType Directory -Force -Path $toolDir | Out-Null }

# 全程记录日志（同时也显示在窗口里）
try { Start-Transcript -Path $logPath -Force | Out-Null } catch { }

function Step($n, $text) { Write-Host ''; Write-Host "[$n] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Info($text) { Write-Host "    $text" -ForegroundColor Gray }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }
function Fail($text) {
  Write-Host ''
  Write-Host "  [失败] $text" -ForegroundColor Red
  Write-Host ("  日志已保存：$logPath") -ForegroundColor DarkGray
  Write-Host ''
  try { Stop-Transcript | Out-Null } catch { }
  Read-Host '按回车关闭窗口'
  exit 1
}

try {
  Write-Host ''
  Write-Host '协议体检官 · 配置固定公网网址' -ForegroundColor Green
  Write-Host '（只需做一次；全程约 3 分钟）' -ForegroundColor DarkGray
  Write-Host ("  PowerShell " + $PSVersionTable.PSVersion + " · 用户 " + $env:USERNAME) -ForegroundColor DarkGray

  # ---------- 0. 找 cloudflared ----------
  Step 0 '检查 cloudflared'
  $exe = Join-Path $toolDir 'cloudflared.exe'
  if (-not (Test-Path $exe)) {
    Info '首次运行，正在下载 cloudflared（约 55MB）…'
    $url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    try {
      Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
    } catch {
      Fail '下载 cloudflared 失败：' + $_.Exception.Message
    }
  }
  Ok ('cloudflared 就绪：' + $exe)

  # ---------- 1. Token 直连（可选，最快） ----------
  if ($Token) {
    Info '检测到手动传入的 Token，跳过登录与建隧道步骤'
  } else {

    # ---------- 1. 登录 ----------
    Step 1 '登录 Cloudflare（会弹出浏览器，选你要用的那个域名并授权）'
    if (Test-Path $certPath) {
      Ok '已经登录过（检测到 cert.pem），跳过'
    } else {
      Info '接下来会自动打开浏览器：登录 Cloudflare → 选择域名 → 点 Authorize'
      Info '（如果浏览器没弹出来，把窗口里出现的网址复制到浏览器打开）'
      $loginOk = $true
      try { & $exe tunnel login } catch { $loginOk = $false }
      if (-not (Test-Path $certPath)) {
        Write-Host ''
        Warn '没有拿到 cert.pem —— 命令行登录没成功。'
        Warn '常见原因：浏览器里点了 Cancel；或账号下还没有接入 Cloudflare 的域名。'
        Warn '可以改用【控制台 Token】方式，不用命令行登录：'
        Write-Host '      1. 浏览器打开 https://one.dash.cloudflare.com/ → Networks → Tunnels' -ForegroundColor White
        Write-Host '      2. Create a tunnel → 选 Cloudflared → 起个名字（如 protocol-inspector）→ Save' -ForegroundColor White
        Write-Host '      3. 在 Public Hostname 里填子域名（如 review.你的域名.com），Service 选 HTTP、地址 127.0.0.1:3090' -ForegroundColor White
        Write-Host '      4. 复制该页的 token（很长一串，形如 eyJhIjoi...），回到这里粘贴' -ForegroundColor White
        Write-Host ''
        $ans = (Read-Host '现在粘贴 token（直接回车跳过）').Trim()
        if (-not $ans) { Fail 'Cloudflare 登录未完成，也没有提供 token' }
        $tokenFile = Join-Path $toolDir 'cf-token.txt'
        [System.IO.File]::WriteAllText($tokenFile, $ans, (New-Object System.Text.UTF8Encoding($false)))
        $Token = $ans
        Write-Host ''
        Write-Host ('  Token 已保存到 ' + $tokenFile) -ForegroundColor Green
        Write-Host '  注意：Token 方式下，域名与端口是在 Cloudflare 控制台的 Public Hostname 里配的，' -ForegroundColor Yellow
        Write-Host '        本脚本不再写 yml；以后双击 启动固定网址.bat 即可。' -ForegroundColor Yellow
        Write-Host ''
        try { Stop-Transcript | Out-Null } catch { }
        Read-Host '按回车关闭窗口'
        exit 0
      }
      Ok '登录完成'
    }

    # ---------- 2. 建隧道 ----------
    Step 2 '创建（或复用）隧道'
    $tunnels = @()
    try {
      $json = (& $exe tunnel list --output json 2>$null | Out-String)
      if ($json.Trim()) { $tunnels = @($json | ConvertFrom-Json) }
    } catch { }

    $tunnel = $tunnels | Where-Object { $_.name -eq $TunnelName } | Select-Object -First 1
    if ($tunnel) {
      Ok ('已有隧道 ' + $TunnelName + '，直接复用（UUID ' + $tunnel.id + '）')
    } else {
      Info ('正在创建隧道 ' + $TunnelName + ' …')
      & $exe tunnel create $TunnelName
      try {
        $json = (& $exe tunnel list --output json 2>$null | Out-String)
        $tunnels = @($json | ConvertFrom-Json)
        $tunnel = $tunnels | Where-Object { $_.name -eq $TunnelName } | Select-Object -First 1
      } catch { }
      if (-not $tunnel) { Fail '创建隧道失败（上面的输出里有报错原因）' }
      Ok ('创建完成，UUID ' + $tunnel.id)
    }
    $uuid = $tunnel.id
    $credFile = Join-Path $certDir ($uuid + '.json')
    if (Test-Path $credFile) { Ok ('凭据文件：' + $credFile) } else { Warn ('没找到凭据文件：' + $credFile) }

    # ---------- 3. 选域名 ----------
    Step 3 '确定公开网址'
    $existing = ''
    if (Test-Path $cfgPath) {
      $line = Select-String -Path $cfgPath -Pattern '^\s*-\s*hostname:\s*(\S+)' | Select-Object -First 1
      if ($line) { $existing = $line.Matches[0].Groups[1].Value }
    }
    if (-not $Hostname -and $existing) { $Hostname = $existing; Ok ('沿用上次的域名：' + $Hostname) }
    if (-not $Hostname) {
      Info '请输入完整子域名，例如：review.你的域名.com'
      Info '（前缀随意，别和已有解析冲突，例如 review / jc / check）'
      $Hostname = (Read-Host '    子域名').Trim()
    }
    if (-not $Hostname) { Fail '没有输入域名' }
    $Hostname = ($Hostname -replace '^https?://', '') -replace '/.*$', ''

    # ---------- 4. DNS 路由 ----------
    Step 4 ('把域名 ' + $Hostname + ' 指向这条隧道')
    & $exe tunnel route dns $TunnelName $Hostname
    if ($LASTEXITCODE -ne 0) {
      Warn '上面这条报错了。若提示 record already exists，说明之前配过，可以忽略。'
    }

    # ---------- 5. 写配置 ----------
    Step 5 '写配置文件'
    $yml = @()
    $yml += '# 由 tools\setup-fixed-url.ps1 生成，可随时删掉重配'
    $yml += ('tunnel: ' + $uuid)
    $yml += ('credentials-file: ' + $credFile)
    $yml += 'ingress:'
    $yml += ('  - hostname: ' + $Hostname)
    $yml += ('    service: http://127.0.0.1:' + $Port)
    $yml += '  - service: http_status:404'
    $txt = ($yml -join "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($cfgPath, $txt, (New-Object System.Text.UTF8Encoding($false)))
    Ok ('已写入 ' + $cfgPath)
  }

  Write-Host ''
  Write-Host '完成！以后这样用：' -ForegroundColor Green
  Write-Host '  1. 双击 启动固定网址.bat（会同时起服务 + 隧道）' -ForegroundColor White
  if ($Token) {
    Write-Host '  2. 请把 -Token 与 -Hostname 传给 tools\fixed-tunnel.ps1' -ForegroundColor White
  } else {
    Write-Host ('  2. 固定网址：https://' + $Hostname) -ForegroundColor White
    Write-Host '  3. 账号 hfk / 密码 000000' -ForegroundColor White
  }
  Write-Host ''
  Write-Host '提示：手机或别人电脑第一次打开如果报 1033 / 1016，等 1 分钟再刷新即可。' -ForegroundColor DarkGray
  Write-Host ''
} catch {
  Fail ('脚本出错：' + $_.Exception.Message + '  （第 ' + $_.InvocationInfo.ScriptLineNumber + ' 行）')
}

try { Stop-Transcript | Out-Null } catch { }
Read-Host '按回车关闭窗口'
