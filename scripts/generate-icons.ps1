# assets/soyokazeMemoIcon.png（SoyokazeMemo で描いた絵）から、アプリアイコン一式（src-tauri/icons/）と
# タイトルバー左端のアイコン（assets/titlebar-icon.png, titlebar-icon@2x.png）を作り直す。
#
#   npm run icons
#
# 元の絵は「紙（いちばん多い色）に 1 色の線」で描いたものを想定している。正方形でなくてよい。
#  - 線だけを抜き出して、紙と同じ色の角丸タイル（正方形）の中央に収める
#  - アイコンは 16〜48px と小さく表示されるので、そのまま縮小すると細い線が消えかける。
#    小さいサイズほど線を太らせてから縮小し、どのサイズでも線が 1.6px 以上残るようにする
#  - 縮小は面積平均（どの倍率でもモアレやリンギングが出ない）
#  - icns と Store 用のロゴは、1024px で描いたものから tauri icon で作る。
#    iOS / Android 用のアイコンも生成されるが使わないので、いま src-tauri/icons にあるファイルだけ差し替える
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;

/// <summary>アイコンの元の絵を「線の濃さ（0〜1）」として持ち、好きな大きさのアイコンに描く</summary>
public class IconArt {
  // 表示サイズに対する比率
  const double Margin = 0.03;        // タイルの外の透明な余白
  const double CornerRadius = 0.22;  // 角丸の半径（タイルの一辺に対して）
  const double BorderWidth = 0.016;  // タイルの縁取りの太さ（最低 1px）
  const double Padding = 0.07;       // タイルの内側の余白（タイルの一辺に対して）
  const double MinStroke = 1.6;      // 表示サイズで最低この太さ（px）の線を残す
  const int WorkPad = 64;            // 線を太らせても端で切れないよう、作業用に周りへ足す余白（元の絵の px）
  static readonly Color DefaultPaper = Color.FromArgb(0xD9, 0xDC, 0xD6); // src/palette.ts の CANVAS_BG

  int w, h;                    // 作業バッファの大きさ
  float[] alpha;               // 線の濃さ
  float[] dist;                // いちばん近い線（濃さ 0.5 以上）までの距離
  int artX, artY, artW, artH;  // 作業バッファの中で、線がある範囲
  public Color Paper;
  public Color Ink;
  public Color Border;
  /// <summary>元の絵での線の太さ（推定, px）</summary>
  public double Stroke;
  public int SourceWidth, SourceHeight;

  public static IconArt Load(string path) {
    int sw, sh;
    int[] px;
    using (var bmp = new Bitmap(path)) {
      sw = bmp.Width;
      sh = bmp.Height;
      px = new int[sw * sh];
      var data = bmp.LockBits(new Rectangle(0, 0, sw, sh), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try {
        for (int y = 0; y < sh; y++) Marshal.Copy(data.Scan0 + y * data.Stride, px, y * sw, sw);
      } finally {
        bmp.UnlockBits(data);
      }
    }

    var art = new IconArt();
    art.SourceWidth = sw;
    art.SourceHeight = sh;
    var a = new float[sw * sh];
    int translucent = px.Count(p => ((uint)p >> 24) < 255);
    if (translucent > px.Length / 10) {
      // 背景が透明な絵: 不透明度をそのまま線の濃さにして、線の色は不透明度で重み付けした平均にする
      art.Paper = DefaultPaper;
      double sr = 0, sg = 0, sb = 0, sa = 0;
      for (int i = 0; i < px.Length; i++) {
        double pa = ((uint)px[i] >> 24) / 255.0;
        a[i] = (float)pa;
        sr += ((px[i] >> 16) & 255) * pa;
        sg += ((px[i] >> 8) & 255) * pa;
        sb += (px[i] & 255) * pa;
        sa += pa;
      }
      if (sa < 1) throw new Exception("絵が見つかりません（すべて透明です）");
      art.Ink = Color.FromArgb((int)Math.Round(sr / sa), (int)Math.Round(sg / sa), (int)Math.Round(sb / sa));
    } else {
      // 紙 = いちばん多い色
      var counts = new Dictionary<int, int>();
      foreach (int p in px) {
        int c;
        counts.TryGetValue(p, out c);
        counts[p] = c + 1;
      }
      int paper = counts.OrderByDescending(kv => kv.Value).First().Key;
      art.Paper = Color.FromArgb(paper | unchecked((int)0xFF000000));

      // 線の色 = 紙から十分離れた色の中で、いちばん多い色（縁のアンチエイリアスの中間色に引っ張られないように）
      double maxD = px.Max(p => ColorDistance(p, paper));
      if (maxD < 32) throw new Exception("線が見つかりません（紙とほぼ同じ色しかありません）");
      int ink = counts.Where(kv => ColorDistance(kv.Key, paper) >= maxD * 0.5).OrderByDescending(kv => kv.Value).First().Key;
      art.Ink = Color.FromArgb(ink | unchecked((int)0xFF000000));

      // 線の濃さ = 「紙 → 線の色」の軸への射影（アンチエイリアスの中間色を、線の不透明度に戻す）
      double vr = art.Ink.R - art.Paper.R, vg = art.Ink.G - art.Paper.G, vb = art.Ink.B - art.Paper.B;
      double vv = vr * vr + vg * vg + vb * vb;
      for (int i = 0; i < px.Length; i++) {
        double dr = ((px[i] >> 16) & 255) - art.Paper.R;
        double dg = ((px[i] >> 8) & 255) - art.Paper.G;
        double db = (px[i] & 255) - art.Paper.B;
        a[i] = (float)Math.Min(1, Math.Max(0, (dr * vr + dg * vg + db * vb) / vv));
      }
    }
    art.Border = Color.FromArgb((int)(art.Paper.R * 0.85), (int)(art.Paper.G * 0.85), (int)(art.Paper.B * 0.85));

    // 線がある範囲を切り出し、周りに作業用の余白を足す
    int minX = int.MaxValue, minY = int.MaxValue, maxX = -1, maxY = -1;
    for (int y = 0; y < sh; y++) {
      for (int x = 0; x < sw; x++) {
        if (a[y * sw + x] <= 0.02f) continue;
        minX = Math.Min(minX, x);
        maxX = Math.Max(maxX, x);
        minY = Math.Min(minY, y);
        maxY = Math.Max(maxY, y);
      }
    }
    if (maxX < 0) throw new Exception("線が見つかりません");
    art.artW = maxX - minX + 1;
    art.artH = maxY - minY + 1;
    art.artX = WorkPad;
    art.artY = WorkPad;
    art.w = art.artW + 2 * WorkPad;
    art.h = art.artH + 2 * WorkPad;
    art.alpha = new float[art.w * art.h];
    for (int y = 0; y < art.artH; y++) {
      for (int x = 0; x < art.artW; x++) {
        art.alpha[(y + WorkPad) * art.w + x + WorkPad] = a[(y + minY) * sw + x + minX];
      }
    }

    // 線の太さの推定: 細長い線なら「面積 = 長さ × 太さ」「輪郭の長さ = 長さ × 2」。
    // 輪郭の長さは、濃さの勾配の大きさを足し合わせると求まる（アンチエイリアスされた縁 1 本で 1）
    double area = 0, edge = 0;
    for (int y = 1; y < art.h - 1; y++) {
      for (int x = 1; x < art.w - 1; x++) {
        int i = y * art.w + x;
        area += art.alpha[i];
        double gx = (art.alpha[i + 1] - art.alpha[i - 1]) / 2.0;
        double gy = (art.alpha[i + art.w] - art.alpha[i - art.w]) / 2.0;
        edge += Math.Sqrt(gx * gx + gy * gy);
      }
    }
    art.Stroke = edge > 0 ? 2 * area / edge : 1;
    art.dist = DistanceTransform(art.alpha, art.w, art.h);
    return art;
  }

  /// <summary>
  /// size px の正方形のアイコンを描く。displaySize は実際に表示される大きさ
  /// （タイトルバー用に 2 倍の解像度で描くときは size = 40, displaySize = 20）。
  /// </summary>
  public Bitmap Render(int size, int displaySize) {
    double f = (double)size / displaySize;
    // 余白と縁取りは表示サイズで整数 px に揃える（小さいサイズで縁がにじまないように）
    double margin = Math.Round(displaySize * Margin) * f;
    double tile = size - 2 * margin;
    double radius = tile * CornerRadius;
    double border = Math.Max(1, Math.Round(displaySize * BorderWidth)) * f;

    // 絵の配置（描く px / 元の絵の px = k）
    double box = tile * (1 - 2 * Padding);
    double k = Math.Min(box / artW, box / artH);
    double ox = (size - artW * k) / 2;
    double oy = (size - artH * k) / 2;
    // 縮小して細くなりすぎる線は、元の絵の段階で太らせておく（太らせる量は元の絵の px）
    double grow = Math.Max(0, (MinStroke * f / k - Stroke) / 2);
    float[] a = grow > 0 ? Dilate(grow) : alpha;

    var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) {
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.PixelOffsetMode = PixelOffsetMode.HighQuality;
      g.Clear(Color.Transparent);
      var rect = new RectangleF((float)margin, (float)margin, (float)tile, (float)tile);
      using (var path = RoundRect(rect, radius))
      using (var brush = new SolidBrush(Paper)) {
        g.FillPath(brush, path);
      }
      var inner = RectangleF.Inflate(rect, -(float)(border / 2), -(float)(border / 2));
      using (var path = RoundRect(inner, radius - border / 2))
      using (var pen = new Pen(Border, (float)border)) {
        g.DrawPath(pen, path);
      }
    }

    var data = bmp.LockBits(new Rectangle(0, 0, size, size), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    try {
      var row = new int[size];
      for (int y = 0; y < size; y++) {
        Marshal.Copy(data.Scan0 + y * data.Stride, row, 0, size);
        for (int x = 0; x < size; x++) {
          double c = Sample(a, x, y, k, ox, oy);
          if (c <= 0) continue;
          int p = row[x];
          int r = (int)Math.Round(((p >> 16) & 255) * (1 - c) + Ink.R * c);
          int gg = (int)Math.Round(((p >> 8) & 255) * (1 - c) + Ink.G * c);
          int b = (int)Math.Round((p & 255) * (1 - c) + Ink.B * c);
          row[x] = (p & unchecked((int)0xFF000000)) | (r << 16) | (gg << 8) | b;
        }
        Marshal.Copy(row, 0, data.Scan0 + y * data.Stride, size);
      }
    } finally {
      bmp.UnlockBits(data);
    }
    return bmp;
  }

  /// <summary>描く画像の (x, y) のピクセルに入る線の濃さ。縮小は面積平均、拡大は双線形補間</summary>
  double Sample(float[] a, int x, int y, double k, double ox, double oy) {
    double x0 = (x - ox) / k + artX, x1 = (x + 1 - ox) / k + artX;
    double y0 = (y - oy) / k + artY, y1 = (y + 1 - oy) / k + artY;
    if (k >= 1) {
      double cx = (x0 + x1) / 2 - 0.5, cy = (y0 + y1) / 2 - 0.5;
      int ix = (int)Math.Floor(cx), iy = (int)Math.Floor(cy);
      double fx = cx - ix, fy = cy - iy;
      return At(a, ix, iy) * (1 - fx) * (1 - fy) + At(a, ix + 1, iy) * fx * (1 - fy)
           + At(a, ix, iy + 1) * (1 - fx) * fy + At(a, ix + 1, iy + 1) * fx * fy;
    }
    double sum = 0;
    for (int sy = (int)Math.Floor(y0); sy < y1; sy++) {
      double wy = Math.Min(y1, sy + 1) - Math.Max(y0, sy);
      if (wy <= 0) continue;
      for (int sx = (int)Math.Floor(x0); sx < x1; sx++) {
        double wx = Math.Min(x1, sx + 1) - Math.Max(x0, sx);
        if (wx > 0) sum += At(a, sx, sy) * wx * wy;
      }
    }
    return sum / ((x1 - x0) * (y1 - y0));
  }

  float At(float[] a, int x, int y) {
    return x < 0 || y < 0 || x >= w || y >= h ? 0 : a[y * w + x];
  }

  /// <summary>線を半径 r だけ太らせる（縁はなめらかなまま）</summary>
  float[] Dilate(double r) {
    var o = new float[alpha.Length];
    for (int i = 0; i < o.Length; i++) {
      double grown = Math.Min(1, Math.Max(0, r + 0.5 - dist[i]));
      o[i] = (float)Math.Max(alpha[i], grown);
    }
    return o;
  }

  /// <summary>各ピクセルから、いちばん近い線（濃さ 0.5 以上）までのユークリッド距離（Felzenszwalb の方法）</summary>
  static float[] DistanceTransform(float[] a, int w, int h) {
    const double Far = 1e12;
    int n = Math.Max(w, h);
    var d2 = new double[w * h];
    var f = new double[n];
    var d = new double[n];
    var v = new int[n];
    var z = new double[n + 1];
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) f[x] = a[y * w + x] >= 0.5f ? 0 : Far;
      DistanceTransform1D(f, w, d, v, z);
      for (int x = 0; x < w; x++) d2[y * w + x] = d[x];
    }
    for (int x = 0; x < w; x++) {
      for (int y = 0; y < h; y++) f[y] = d2[y * w + x];
      DistanceTransform1D(f, h, d, v, z);
      for (int y = 0; y < h; y++) d2[y * w + x] = d[y];
    }
    var o = new float[w * h];
    for (int i = 0; i < o.Length; i++) o[i] = (float)Math.Sqrt(d2[i]);
    return o;
  }

  /// <summary>1 次元の二乗距離変換（放物線の下側包絡線）</summary>
  static void DistanceTransform1D(double[] f, int n, double[] d, int[] v, double[] z) {
    int k = 0;
    v[0] = 0;
    z[0] = double.NegativeInfinity;
    z[1] = double.PositiveInfinity;
    for (int q = 1; q < n; q++) {
      double s = Intersection(f, q, v[k]);
      while (s <= z[k]) {
        k--;
        s = Intersection(f, q, v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = double.PositiveInfinity;
    }
    k = 0;
    for (int q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (double)(q - v[k]) * (q - v[k]) + f[v[k]];
    }
  }

  static double Intersection(double[] f, int q, int p) {
    return ((f[q] + (double)q * q) - (f[p] + (double)p * p)) / (2.0 * q - 2.0 * p);
  }

  static double ColorDistance(int p, int q) {
    double dr = ((p >> 16) & 255) - ((q >> 16) & 255);
    double dg = ((p >> 8) & 255) - ((q >> 8) & 255);
    double db = (p & 255) - (q & 255);
    return Math.Sqrt(dr * dr + dg * dg + db * db);
  }

  static GraphicsPath RoundRect(RectangleF r, double radius) {
    float d = (float)(radius * 2);
    var p = new GraphicsPath();
    p.AddArc(r.X, r.Y, d, d, 180, 90);
    p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    p.CloseFigure();
    return p;
  }

  public static byte[] ToPng(Bitmap bmp) {
    using (var ms = new MemoryStream()) {
      bmp.Save(ms, ImageFormat.Png);
      return ms.ToArray();
    }
  }

  public static void SavePng(Bitmap bmp, string path) {
    File.WriteAllBytes(path, ToPng(bmp));
  }

  /// <summary>PNG 圧縮のエントリだけで .ico を書く（Windows Vista 以降はどのサイズでも読める）</summary>
  public static void WriteIco(string path, IList<Bitmap> images) {
    var pngs = images.Select(b => ToPng(b)).ToList();
    using (var fs = File.Create(path))
    using (var w = new BinaryWriter(fs)) {
      w.Write((ushort)0);
      w.Write((ushort)1);
      w.Write((ushort)images.Count);
      int offset = 6 + 16 * images.Count;
      for (int i = 0; i < images.Count; i++) {
        w.Write((byte)(images[i].Width >= 256 ? 0 : images[i].Width));
        w.Write((byte)(images[i].Height >= 256 ? 0 : images[i].Height));
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
$assetsDir = Join-Path $root "assets"
$work = Join-Path ([System.IO.Path]::GetTempPath()) "soyokaze-memo-icons"

$art = [IconArt]::Load($source)
Write-Host ("元の絵 {0}x{1}: 紙 #{2:X2}{3:X2}{4:X2} / 線 #{5:X2}{6:X2}{7:X2} / 線の太さ 約 {8:N1}px" -f `
    $art.SourceWidth, $art.SourceHeight, $art.Paper.R, $art.Paper.G, $art.Paper.B, $art.Ink.R, $art.Ink.G, $art.Ink.B, $art.Stroke)

if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory $work | Out-Null

try {
  # 1. icns と Store 用のロゴは、1024px で描いたものから tauri icon に作らせる
  [IconArt]::SavePng($art.Render(1024, 1024), (Join-Path $work "icon.png"))
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

  # 2. Windows が使う icon.ico と主要な PNG は、サイズごとに描き直して上書きする
  #    （exe・ショートカット・タスクバーのアイコンは icon.ico、ウィンドウのアイコンはその最大サイズ）
  $icoSizes = @(16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
  [IconArt]::WriteIco((Join-Path $iconsDir "icon.ico"), [System.Drawing.Bitmap[]]($icoSizes | ForEach-Object { $art.Render($_, $_) }))
  $pngs = [ordered]@{ "32x32.png" = @(32, 32); "64x64.png" = @(64, 64); "128x128.png" = @(128, 128); "128x128@2x.png" = @(256, 128); "icon.png" = @(512, 512) }
  foreach ($name in $pngs.Keys) {
    [IconArt]::SavePng($art.Render($pngs[$name][0], $pngs[$name][1]), (Join-Path $iconsDir $name))
  }

  # 3. タイトルバー左端のアイコン（20px で表示。高 DPI 用に 2 倍のものも作る）
  [IconArt]::SavePng($art.Render(20, 20), (Join-Path $assetsDir "titlebar-icon.png"))
  [IconArt]::SavePng($art.Render(40, 20), (Join-Path $assetsDir "titlebar-icon@2x.png"))
  Write-Host "src-tauri/icons と assets/titlebar-icon*.png を更新しました"
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
