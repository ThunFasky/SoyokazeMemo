# assets/soyokazeMemoIcon.png（ドット絵）から src-tauri/icons/ のアプリアイコン一式を作り直す。
#
#   npm run icons
#
# tauri icon は滑らかな補間で拡大縮小するので、小さいドット絵をそのまま渡すとボケる。
# そこで 2 段階で作る。
#   1. ニアレストネイバーで 1024px 以上に拡大してから tauri icon に渡し、icns や Store 用のロゴを作る
#   2. Windows が実際に使う icon.ico と主要な PNG は、サイズごとにドットが崩れない作り方を選んで上書きする
#      （整数倍に拡大して余白を付ける / 外周 1px を削って等倍にする / ちょうど割り切れる倍率で縮小する）
# iOS / Android 用のアイコンも生成されるが使わないので、いま src-tauri/icons にあるファイルだけ差し替える。
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

/// <summary>ドット絵をピクセル単位で扱うための最小限の画像（ARGB、アルファは乗算前）</summary>
public class PixelImage {
  public readonly int W;
  public readonly int H;
  public readonly uint[] Px;

  public PixelImage(int w, int h) {
    W = w;
    H = h;
    Px = new uint[w * h];
  }

  public static PixelImage Load(string path) {
    using (var bmp = new Bitmap(path)) {
      var img = new PixelImage(bmp.Width, bmp.Height);
      var data = bmp.LockBits(new Rectangle(0, 0, img.W, img.H), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try {
        var row = new int[img.W];
        for (int y = 0; y < img.H; y++) {
          Marshal.Copy(data.Scan0 + y * data.Stride, row, 0, img.W);
          for (int x = 0; x < img.W; x++) img.Px[y * img.W + x] = (uint)row[x];
        }
      } finally {
        bmp.UnlockBits(data);
      }
      return img;
    }
  }

  /// <summary>整数倍のニアレストネイバー拡大</summary>
  public PixelImage Scale(int k) {
    var dst = new PixelImage(W * k, H * k);
    for (int y = 0; y < dst.H; y++)
      for (int x = 0; x < dst.W; x++) dst.Px[y * dst.W + x] = Px[(y / k) * W + x / k];
    return dst;
  }

  /// <summary>size x size の透明なキャンバスの中央に置く</summary>
  public PixelImage Pad(int size) {
    var dst = new PixelImage(size, size);
    int ox = (size - W) / 2;
    int oy = (size - H) / 2;
    for (int y = 0; y < H; y++)
      for (int x = 0; x < W; x++) dst.Px[(y + oy) * size + x + ox] = Px[y * W + x];
    return dst;
  }

  /// <summary>外周 1px を削り、四隅の 1px を透明にして角の丸みを残す</summary>
  public PixelImage Shrink() {
    var dst = new PixelImage(W - 2, H - 2);
    for (int y = 0; y < dst.H; y++)
      for (int x = 0; x < dst.W; x++) dst.Px[y * dst.W + x] = Px[(y + 1) * W + x + 1];
    dst.Px[0] = dst.Px[dst.W - 1] = dst.Px[(dst.H - 1) * dst.W] = dst.Px[dst.H * dst.W - 1] = 0;
    return dst;
  }

  /// <summary>面積平均で縮小する（各出力ピクセルが覆う範囲の色を、アルファで重み付けして平均）</summary>
  public PixelImage Downscale(int size) {
    var dst = new PixelImage(size, size);
    double sx = (double)W / size;
    double sy = (double)H / size;
    for (int dy = 0; dy < size; dy++) {
      double y0 = dy * sy, y1 = (dy + 1) * sy;
      for (int dx = 0; dx < size; dx++) {
        double x0 = dx * sx, x1 = (dx + 1) * sx;
        double a = 0, r = 0, g = 0, b = 0;
        for (int y = (int)y0; y < Math.Min(H, (int)Math.Ceiling(y1)); y++) {
          double wy = Math.Min(y1, y + 1) - Math.Max(y0, y);
          for (int x = (int)x0; x < Math.Min(W, (int)Math.Ceiling(x1)); x++) {
            double w = wy * (Math.Min(x1, x + 1) - Math.Max(x0, x));
            uint p = Px[y * W + x];
            double pa = (p >> 24) / 255.0 * w;
            a += pa;
            r += ((p >> 16) & 0xff) * pa;
            g += ((p >> 8) & 0xff) * pa;
            b += (p & 0xff) * pa;
          }
        }
        double area = sx * sy;
        if (a <= 0) continue;
        uint oa = (uint)Math.Round(a / area * 255);
        uint cr = (uint)Math.Round(r / a);
        uint cg = (uint)Math.Round(g / a);
        uint cb = (uint)Math.Round(b / a);
        dst.Px[dy * size + dx] = (oa << 24) | (cr << 16) | (cg << 8) | cb;
      }
    }
    return dst;
  }

  public byte[] ToPng() {
    using (var bmp = new Bitmap(W, H, PixelFormat.Format32bppArgb)) {
      var data = bmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
      try {
        var row = new int[W];
        for (int y = 0; y < H; y++) {
          for (int x = 0; x < W; x++) row[x] = (int)Px[y * W + x];
          Marshal.Copy(row, 0, data.Scan0 + y * data.Stride, W);
        }
      } finally {
        bmp.UnlockBits(data);
      }
      using (var ms = new MemoryStream()) {
        bmp.Save(ms, ImageFormat.Png);
        return ms.ToArray();
      }
    }
  }

  /// <summary>PNG 圧縮のエントリだけで .ico を書く（Windows Vista 以降はどのサイズでも読める）</summary>
  public static void WriteIco(string path, IList<PixelImage> images) {
    using (var fs = File.Create(path))
    using (var w = new BinaryWriter(fs)) {
      var pngs = new List<byte[]>();
      foreach (var img in images) pngs.Add(img.ToPng());
      w.Write((ushort)0);
      w.Write((ushort)1);
      w.Write((ushort)images.Count);
      int offset = 6 + 16 * images.Count;
      for (int i = 0; i < images.Count; i++) {
        w.Write((byte)(images[i].W >= 256 ? 0 : images[i].W));
        w.Write((byte)(images[i].H >= 256 ? 0 : images[i].H));
        w.Write((byte)0);
        w.Write((byte)0);
        w.Write((ushort)1);
        w.Write((ushort)32);
        w.Write((uint)pngs[i].Length);
        w.Write((uint)offset);
        offset += pngs[i].Length;
      }
      foreach (var png in pngs) w.Write(png);
    }
  }
}
"@

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "assets/soyokazeMemoIcon.png"
$iconsDir = Join-Path $root "src-tauri/icons"
$work = Join-Path ([System.IO.Path]::GetTempPath()) "soyokaze-memo-icons"

$src = [PixelImage]::Load($source)
if ($src.W -ne $src.H) { throw "アイコンは正方形にしてください ($($src.W)x$($src.H))" }
# 元絵は外枠のグレーが 3px あるので、外周 1px を削っても形が変わらない。50px → 48px を等倍のまま作るのに使う
$inner = $src.Shrink()

# 指定サイズの画像を、ドットが崩れにくい順に作り方を選んで作る
function Get-Icon([int]$size) {
  foreach ($base in @($src, $inner)) {
    if ($size % $base.W -eq 0) { return $base.Scale($size / $base.W) } # ちょうど整数倍
  }
  $k = [math]::Floor($size / $src.W)
  if ($k -ge 1 -and $k * $src.W -ge $size * 0.75) { return $src.Scale($k).Pad($size) } # 整数倍 + 余白
  foreach ($base in @($src, $inner)) {
    if ($base.W % $size -eq 0) { return $base.Downscale($size) } # ちょうど割り切れる倍率で縮小
  }
  return $src.Downscale($size) # 16〜40px などはどうしても縮小になる
}

if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory $work | Out-Null

try {
  # 1. icns や Store 用のロゴは tauri icon に任せる（拡大した元絵を渡す）
  $scale = [math]::Ceiling(1024 / $src.W)
  [System.IO.File]::WriteAllBytes((Join-Path $work "icon.png"), $src.Scale($scale).ToPng())
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

  # 2. Windows が使う icon.ico と主要な PNG はドット絵用に作り直して上書きする
  #    （exe・ショートカット・タスクバーのアイコンは icon.ico、ウィンドウのアイコンはその最大サイズ）
  $icoSizes = @(16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
  [PixelImage]::WriteIco((Join-Path $iconsDir "icon.ico"), [PixelImage[]]($icoSizes | ForEach-Object { Get-Icon $_ }))
  $pngs = [ordered]@{ "32x32.png" = 32; "64x64.png" = 64; "128x128.png" = 128; "128x128@2x.png" = 256; "icon.png" = 512 }
  foreach ($name in $pngs.Keys) {
    [System.IO.File]::WriteAllBytes((Join-Path $iconsDir $name), (Get-Icon $pngs[$name]).ToPng())
  }
  Write-Host "src-tauri/icons を更新しました"
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
