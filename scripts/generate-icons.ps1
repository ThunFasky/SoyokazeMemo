# assets/soyokazeMemoIcon.png（ドット絵）から src-tauri/icons/ のアプリアイコン一式を作り直す。
#
#   npm run icons
#
# tauri icon は滑らかな補間で拡大縮小するので、小さいドット絵をそのまま渡すとボケる。
# 先にニアレストネイバーで 1024px 以上に拡大してから渡し、ドットの輪郭を保つ。
# iOS / Android 用のアイコンも生成されるが使わないので、いま src-tauri/icons にあるファイルだけ差し替える。
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "assets/soyokazeMemoIcon.png"
$iconsDir = Join-Path $root "src-tauri/icons"
$work = Join-Path ([System.IO.Path]::GetTempPath()) "soyokaze-memo-icons"

if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory $work | Out-Null

try {
  $src = [System.Drawing.Bitmap]::FromFile($source)
  try {
    $scale = [math]::Ceiling(1024 / [math]::Min($src.Width, $src.Height))
    $big = New-Object System.Drawing.Bitmap ($src.Width * $scale), ($src.Height * $scale), ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($big)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half # 端のドットが半分欠けないように
    $g.DrawImage($src, 0, 0, $big.Width, $big.Height)
    $g.Dispose()
    $big.Save((Join-Path $work "icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $big.Dispose()
  } finally {
    $src.Dispose()
  }

  Push-Location $root
  try {
    npx tauri icon (Join-Path $work "icon.png") -o (Join-Path $work "out")
    if ($LASTEXITCODE -ne 0) { throw "tauri icon が失敗しました (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }

  Get-ChildItem (Join-Path $work "out") -File |
    Where-Object { Test-Path (Join-Path $iconsDir $_.Name) } |
    Copy-Item -Destination $iconsDir -Force
  Write-Host "src-tauri/icons を更新しました"
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
