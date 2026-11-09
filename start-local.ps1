# 本地启动：协议体检官（免登录，自己用）
# 用法：双击「启动协议体检官.bat」，或 powershell -File start-local.ps1

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
    if (Test-Path $p) { $node = $p; break }
  }
}
if (-not $node) {
  Write-Host '没有找到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org/' -ForegroundColor Red
  Read-Host '按回车关闭'
  exit 1
}

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host '首次运行：正在安装依赖（约 1~2 分钟）…' -ForegroundColor Cyan
  & cmd /c "npm install --no-audit --no-fund"
}

# 本机自用模式：不设 ACCESS_PASSWORD，所以不需要登录
$env:PORT = '3080'
Remove-Item Env:\ACCESS_PASSWORD -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '协议体检官 · 本地模式（免登录）' -ForegroundColor Green
Write-Host '  访问地址   http://127.0.0.1:3080' -ForegroundColor Gray
Write-Host '  关闭本窗口或按 Ctrl+C 停止服务' -ForegroundColor Gray
Write-Host ''

Start-Process 'http://127.0.0.1:3080/'
& $node server.js
