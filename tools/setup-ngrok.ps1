# 一次性配置：用 ngrok 的免费固定域名，给「协议体检官」一个不变的公网网址
#
# 双击 `配置 ngrok 网址.bat` 即可。需要先在 ngrok 后台拿到两样东西：
#   1) Authtoken      —— https://dashboard.ngrok.com/get-started/your-authtoken
#   2) 一个固定域名    —— https://dashboard.ngrok.com/domains → New Domain（免费版送 1 个）
#
# 做完之后，双击 `启动固定网址.bat`，链接永远是 https://<你的域名>。

param(
  [string]$Token = '',
  [string]$Domain = ''
)

$root = Split-Path -Parent $PSScriptRoot
$toolDir = Join-Path $root '.tools'
$ngrokExe = Join-Path $toolDir 'ngrok.exe'
$cfgPath = Join-Path $toolDir 'ngrok.txt'
$logPath = Join-Path $toolDir 'setup-ngrok.log'
if (-not (Test-Path $toolDir)) { New-Item -ItemType Directory -Force -Path $toolDir | Out-Null }

try { Start-Transcript -Path $logPath -Force | Out-Null } catch { }

function Step($n, $text) { Write-Host ''; Write-Host "[$n] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Info($text) { Write-Host "    $text" -ForegroundColor Gray }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }
function Fail($text) {
  Write-Host ''
  Write-Host "  [失败] $text" -ForegroundColor Red
  Write-Host ("  日志：$logPath") -ForegroundColor DarkGray
  Write-Host ''
  try { Stop-Transcript | Out-Null } catch { }
  Read-Host '按回车关闭窗口'
  exit 1
}

try {
  Write-Host ''
  Write-Host '协议体检官 · 配置 ngrok 固定网址' -ForegroundColor Green
  Write-Host '（只需做一次；全程约 3 分钟）' -ForegroundColor DarkGray

  Step 0 '检查 ngrok.exe'
  if (-not (Test-Path $ngrokExe)) {
    Info '正在下载 ngrok（约 12MB）…'
    $zip = Join-Path $toolDir 'ngrok.zip'
    $ok = $false
    try {
      Invoke-WebRequest -Uri 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip' -OutFile $zip -UseBasicParsing -TimeoutSec 180
      $ok = $true
    } catch { }
    if (-not $ok) { Fail '下载 ngrok 失败：请手动下载 zip 解压出 ngrok.exe 放到 ' + $toolDir }
    Expand-Archive -Path $zip -DestinationPath $toolDir -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
  }
  Ok ('ngrok 就绪：' + $ngrokExe)

  # ---------- 1. Authtoken ----------
  Step 1 '填写 Authtoken'
  if (-not $Token) {
    Info '浏览器打开 https://dashboard.ngrok.com/get-started/your-authtoken'
    Info '页面上有一段形如 2abc...XYZ 的字符串（Your Authtoken），点复制'
    $Token = (Read-Host '    粘贴 Authtoken').Trim()
  }
  if (-not $Token) { Fail '没有输入 Authtoken' }
  $yml = Join-Path $toolDir 'ngrok.yml'
  & $ngrokExe config add-authtoken $Token --config $yml 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'ngrok 不认这个 Authtoken，请确认复制完整、没有多余空格' }
  Ok ('Authtoken 已保存到 ' + $yml)

  # ---------- 2. 固定域名 ----------
  Step 2 '填写固定域名'
  if (-not $Domain) {
    Info '浏览器打开 https://dashboard.ngrok.com/domains → 点 New Domain / Create Domain'
    Info '免费版会给你一个形如 xxxx-yyyy.ngrok-free.app 的域名，复制它'
    $Domain = (Read-Host '    粘贴域名（不带 https://）').Trim()
  }
  if (-not $Domain) { Fail '没有输入域名' }
  $Domain = ($Domain -replace '^https?://', '') -replace '/.*$', ''
  if ($Domain -match '[^a-zA-Z0-9\.\-]') { Fail ('域名格式不对：' + $Domain) }
  if ($Domain -notmatch '\.') { Fail ('域名格式不对（缺少点）：' + $Domain) }
  Ok ('域名：' + $Domain)

  # ---------- 3. 写配置 ----------
  Step 3 '保存配置'
  $txt = "domain=$Domain`r`ntoken=$Token`r`n"
  [System.IO.File]::WriteAllText($cfgPath, $txt, (New-Object System.Text.UTF8Encoding($false)))
  Ok ('已写入 ' + $cfgPath)

  Write-Host ''
  Write-Host '完成！以后这样用：' -ForegroundColor Green
  Write-Host '  1. 双击 启动固定网址.bat（会同时起服务 + 隧道）' -ForegroundColor White
  Write-Host ('  2. 固定网址：https://' + $Domain) -ForegroundColor White
  Write-Host '  3. 账号 hfk / 密码 000000' -ForegroundColor White
  Write-Host ''
  Write-Host '注意：ngrok 免费版第一次打开会先出现一个 ngrok 提示页，点一下 "Visit Site" 就进去了。' -ForegroundColor DarkGray
  Write-Host '      这是免费版的行为，评审前自己先打开一次、把提示页点掉，演示时就不会尴尬。' -ForegroundColor DarkGray
  Write-Host ''
} catch {
  Fail ('脚本出错：' + $_.Exception.Message + '（第 ' + $_.InvocationInfo.ScriptLineNumber + ' 行）')
}

try { Stop-Transcript | Out-Null } catch { }
Read-Host '按回车关闭窗口'
