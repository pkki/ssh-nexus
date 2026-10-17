$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Find-CommandPath([string]$Name, [string[]]$Fallbacks) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($path in $Fallbacks) { if (Test-Path $path) { return $path } }
  return $null
}

function Test-NativeCommand([string]$Executable, [string[]]$Arguments) {
  # Windows PowerShell converts native stderr into ErrorRecord objects. With
  # ErrorActionPreference=Stop, expected probe failures (for example, a repo
  # that does not exist yet) otherwise abort the whole publishing script.
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    & $Executable @Arguments *> $null
    return ($LASTEXITCODE -eq 0)
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

Write-Host "`n=== SSH Nexus GitHub 公開ツール ===" -ForegroundColor Cyan
$gh = Find-CommandPath 'gh' @("$env:ProgramFiles\GitHub CLI\gh.exe", "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe")
if (-not $gh) {
  $winget = Find-CommandPath 'winget' @("$env:LOCALAPPDATA\Microsoft\WindowsApps\winget.exe")
  if (-not $winget) { throw 'GitHub CLIがありません。wingetを利用できるWindows 11で実行してください。' }
  Write-Host 'GitHub CLIをインストールします…' -ForegroundColor Yellow
  & $winget install --id GitHub.cli --exact --accept-package-agreements --accept-source-agreements
  $gh = Find-CommandPath 'gh' @("$env:ProgramFiles\GitHub CLI\gh.exe", "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe")
  if (-not $gh) { throw 'GitHub CLIのインストール後にこのファイルをもう一度実行してください。' }
}

$authenticated = Test-NativeCommand $gh @('auth','status')
if (-not $authenticated) {
  Write-Host 'ブラウザーでGitHubへログインしてください。' -ForegroundColor Yellow
  & $gh auth login --web --git-protocol https
  if ($LASTEXITCODE -ne 0) { throw 'GitHubへのログインに失敗しました。' }
}
$owner = (& $gh api user --jq .login).Trim()
if (-not $owner) { throw 'GitHubユーザー名を取得できませんでした。' }
$winget = Find-CommandPath 'winget' @("$env:LOCALAPPDATA\Microsoft\WindowsApps\winget.exe")
$git = Find-CommandPath 'git.exe' @("$env:ProgramFiles\Git\cmd\git.exe")
if (-not $git) {
  if (-not $winget) { throw 'Gitがなく、wingetも利用できません。' }
  Write-Host 'Gitをインストールします…' -ForegroundColor Yellow
  & $winget install --id Git.Git --exact --accept-package-agreements --accept-source-agreements
  $git = Find-CommandPath 'git.exe' @("$env:ProgramFiles\Git\cmd\git.exe")
  if (-not $git) { throw 'Gitのインストール後にこのファイルをもう一度実行してください。' }
}
Set-Alias -Name git -Value $git -Scope Script
$node = Find-CommandPath 'node.exe' @("$env:ProgramFiles\nodejs\node.exe")
$npm = Find-CommandPath 'npm.cmd' @("$env:ProgramFiles\nodejs\npm.cmd")
$needsNode = (-not $node -or -not $npm)
if (-not $needsNode) {
  try { $needsNode = ([version]((& $node -p "process.versions.node").Trim()) -lt [version]'22.12.0') } catch { $needsNode = $true }
}
if ($needsNode) {
  if (-not $winget) { throw 'Node.js 22.12以降が必要ですが、wingetを利用できません。' }
  Write-Host 'Node.js 22.12以降へ更新します…' -ForegroundColor Yellow
  & $winget upgrade --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { & $winget install --id OpenJS.NodeJS.LTS --exact --force --accept-package-agreements --accept-source-agreements }
  $node = Find-CommandPath 'node.exe' @("$env:ProgramFiles\nodejs\node.exe")
  $npm = Find-CommandPath 'npm.cmd' @("$env:ProgramFiles\nodejs\npm.cmd")
  if (-not $node -or -not $npm) { throw 'Node.jsの更新後にpublish.cmdをもう一度実行してください。' }
  $installedNodeVersion = [version]((& $node -p "process.versions.node").Trim())
  if ($installedNodeVersion -lt [version]'22.12.0') { throw "Node.js 22.12以降が必要です。現在: $installedNodeVersion。Windowsを再起動して再実行してください。" }
}
$repo = Read-Host "リポジトリ名（Enterで ssh-nexus）"
if ([string]::IsNullOrWhiteSpace($repo)) { $repo = 'ssh-nexus' }
if ($repo -notmatch '^[A-Za-z0-9_.-]+$') { throw 'リポジトリ名に使用できない文字があります。' }
$visibility = Read-Host '公開リポジトリにします。続けるには PUBLIC と入力'
if ($visibility -ne 'PUBLIC') { throw '公開をキャンセルしました。' }

$config = @{ owner=$owner; repo=$repo; checkOnStartup=$true } | ConvertTo-Json
Set-Content -Path 'github-release.json' -Value $config -Encoding UTF8
$package = Get-Content package.json -Raw | ConvertFrom-Json
$version = $package.version
$tag = "v$version"
$setup = "release\SSH-Nexus-Setup-$version.exe"
$sourceZip = "release\SSH-Nexus-Source-$version.zip"
$setupHash = "release\SSH-Nexus-Setup-$version.sha256"
$sourceHash = "release\SSH-Nexus-Source-$version.sha256"
$pagesUrl = "https://$owner.github.io/$repo/"
$releaseDownload = "https://github.com/$owner/$repo/releases/latest/download/SSH-Nexus-Setup-$version.exe"

Write-Host "公開先: https://github.com/$owner/$repo" -ForegroundColor Green
$nodeVersion = (& $node -p "process.versions.node").Trim()
Write-Host "Node.js $nodeVersion"
Write-Host 'WebサイトのURLとダウンロードリンクを確定します…'
Get-ChildItem website -Filter index.html -Recurse | ForEach-Object {
  $text = Get-Content $_.FullName -Raw
  $text = [regex]::Replace($text, '(?:\.\./)+release/SSH-Nexus-Setup-[^"<]+\.exe', $releaseDownload)
  $text = [regex]::Replace($text, 'https://github\.com/[^/]+/[^/]+/releases/latest/download/SSH-Nexus-Setup-[^"<]+\.exe', $releaseDownload)
  Set-Content $_.FullName $text -Encoding UTF8
}
& $node website/finalize-seo.js $pagesUrl
if ($LASTEXITCODE -ne 0) { throw 'SEOファイルの生成に失敗しました。' }

Write-Host '依存関係を準備しています…' -ForegroundColor Cyan
if (Test-Path 'node_modules\cpu-features') {
  try { Remove-Item 'node_modules\cpu-features' -Recurse -Force -ErrorAction Stop } catch { Write-Host '古いcpu-featuresを削除できないためnode_modulesを作り直します…' -ForegroundColor Yellow; Remove-Item 'node_modules' -Recurse -Force }
}
& $npm install --omit=optional
if ($LASTEXITCODE -ne 0) { throw 'npm installに失敗しました。' }
& $npm test
if ($LASTEXITCODE -ne 0) { throw 'テストに失敗したため公開を中止しました。' }
if (Test-Path 'node_modules\cpu-features') { Remove-Item 'node_modules\cpu-features' -Recurse -Force }
& $npm run build:win
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $setup)) { throw 'Windowsインストーラーの作成に失敗しました。' }

if (-not (Test-Path '.git')) { git init -b main }
if (-not (Test-NativeCommand $git @('config','user.name'))) { git config user.name $owner }
if (-not (Test-NativeCommand $git @('config','user.email'))) { git config user.email "$owner@users.noreply.github.com" }

git add .
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { git commit -m "Release SSH Nexus $version" }
if ($LASTEXITCODE -ne 0) { throw 'Gitコミットに失敗しました。' }

$repositoryExists = Test-NativeCommand $gh @('repo','view',"$owner/$repo")
if (-not $repositoryExists) {
  & $gh repo create "$owner/$repo" --public --source . --remote origin --push
  if ($LASTEXITCODE -ne 0) { throw 'GitHubリポジトリの作成に失敗しました。' }
} else {
  $hasOrigin = Test-NativeCommand $git @('remote','get-url','origin')
  if (-not $hasOrigin) { git remote add origin "https://github.com/$owner/$repo.git" }
  git branch -M main
  git push -u origin main
  if ($LASTEXITCODE -ne 0) { throw 'GitHubへのpushに失敗しました。' }
}

New-Item -ItemType Directory -Force release | Out-Null
if (Test-Path $sourceZip) { Remove-Item $sourceZip -Force }
git archive --format=zip --output=$sourceZip HEAD
$setupDigest = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLower()
$sourceDigest = (Get-FileHash $sourceZip -Algorithm SHA256).Hash.ToLower()
Set-Content $setupHash "$setupDigest  SSH-Nexus-Setup-$version.exe" -Encoding ASCII
Set-Content $sourceHash "$sourceDigest  SSH-Nexus-Source-$version.zip" -Encoding ASCII

$releaseExists = Test-NativeCommand $gh @('release','view',$tag,'--repo',"$owner/$repo")
if ($releaseExists) {
  & $gh release upload $tag $setup $setupHash $sourceZip $sourceHash --repo "$owner/$repo" --clobber
} else {
  & $gh release create $tag $setup $setupHash $sourceZip $sourceHash --repo "$owner/$repo" --title "SSH Nexus $version" --notes "Windows向けSSHクライアント SSH Nexus $version。インストーラー、SHA-256チェックサム、ソースアーカイブを収録しています。"
}
if ($LASTEXITCODE -ne 0) { throw 'GitHub Releaseの公開に失敗しました。' }

try { & $gh api --method POST "repos/$owner/$repo/pages" -f build_type=workflow *> $null } catch {}
Write-Host "`n公開が完了しました。" -ForegroundColor Green
Write-Host "リポジトリ: https://github.com/$owner/$repo"
Write-Host "ダウンロード: https://github.com/$owner/$repo/releases/latest"
Write-Host "Webサイト: $pagesUrl"
Start-Process "https://github.com/$owner/$repo/releases/latest"
