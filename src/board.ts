import { CANVAS_BG } from "./palette";

export type Tool = "pen" | "eraser";

export interface Vec {
  x: number;
  y: number;
}

/** 矩形（CSS px または doc 座標） */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * doc 座標（履歴のコマンドが使う座標）→ ステージの CSS px への変換。css = doc * s + o。
 * 通常のキャンバスでは doc 座標 = CSS px（s = 1, o = 0）。
 * 画像キャンバスでは doc 座標 = 画像のピクセルで、画像を画面の中央に置いた配置になる。
 */
export interface View {
  sx: number;
  sy: number;
  ox: number;
  oy: number;
}

/** 回転・拡縮を含む画像の配置。履歴の中では doc 座標、未確定画像（FloatingImage）では CSS px。 */
export interface ImageTransform {
  /** 中心座標 */
  cx: number;
  cy: number;
  /** 表示サイズ（回転前） */
  w: number;
  h: number;
  /** ラジアン */
  rotation: number;
}

export interface StrokeCommand {
  kind: "stroke";
  tool: Tool;
  color: string;
  size: number;
  /** [x0, y0, x1, y1, ...] */
  points: number[];
}

export interface ImageCommand {
  kind: "image";
  bitmap: ImageBitmap;
  transform: ImageTransform;
}

/**
 * 新しいキャンバスにする（全消去 / クリップボードの画像をキャンバスにする）。
 * page があればその画像が下地（紙）になり、以降のコマンドは画像のピクセル単位の座標を使う。
 */
export interface ClearCommand {
  kind: "clear";
  page: ImageBitmap | null;
}

/**
 * 投げ縄選択の確定。path の内側を消して、切り取った画像を transform の位置に描く。
 * 「切り取り＋貼り付け」を 1 コマンドにしているので、Undo 1 回で丸ごと元に戻る。
 * bitmap が null のときは選択範囲の削除。
 */
export interface SelectionCommand {
  kind: "selection";
  /** 投げ縄の閉じたパス [x0, y0, x1, y1, ...]（doc 座標） */
  path: number[];
  bitmap: ImageBitmap | null;
  transform: ImageTransform | null;
}

/**
 * 塗りつぶし（バケツ）。塗った範囲をそのままの解像度の画像で持つ。
 * core は塗る範囲そのもの（上から塗る）、fringe はその外周 1px（線の下に潜らせて塗る。
 * 線のフチのアンチエイリアスとの間に、元の色のすき間が残らないようにするため）。
 */
export interface FillCommand {
  kind: "fill";
  core: ImageBitmap;
  fringe: ImageBitmap | null;
  /** 画像を置く範囲（doc 座標） */
  rect: Rect;
}

export type Command = StrokeCommand | ImageCommand | ClearCommand | SelectionCommand | FillCommand;

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** これより新しいコマンドは base に焼かずに残す（＝この回数までの Undo はほぼ一瞬）。 */
const BASE_LAG = 24;
/** base と現在位置の差がこれを超えたら base を進める。 */
const BASE_ADVANCE = BASE_LAG * 2;
/** 画像キャンバスが画面に収まらず縮小表示するときに、周りに残す余白（CSS px） */
const PAGE_MARGIN = 16;
/** 表示倍率の範囲（通常のキャンバスは CSS px、画像キャンバスは画像 1px = 実ピクセル 1px を 1 とする） */
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 16;
/** 塗りつぶしで「同じ色」とみなす差（RGB それぞれ 0〜255 のうち、いちばん大きい差） */
const FILL_TOLERANCE = 48;

/**
 * 描画レイヤーと履歴を管理するクラス。
 *
 * 履歴は「ピクセルのスナップショット」ではなく「描画コマンド」で持つ。
 *  - メモリが軽い（WQHD のスナップショットは 1 枚 14MB 以上になる）
 *  - ウィンドウサイズや DPI が変わっても劣化なく描き直せる
 *
 * Undo のたびに全コマンドを再生すると重くなるので、少し前の状態を
 * オフスクリーンの base キャンバスにキャッシュし、そこから差分だけ再生する。
 *
 * レイヤーは透明で、背景のグレーは CSS で敷いている。消しゴムは
 * destination-out で「透明に戻す」ので、貼り付けた画像も普通に消せる。
 *
 * 画像キャンバス（クリップボードの画像をそのままキャンバスにしたもの）では、
 * 画像を paper キャンバスに「紙」として描き、書き込みはその上の透明なレイヤーに描く。
 * 消しゴムで消えるのは書き込みだけで、書き出しは画像と同じ大きさ・解像度になる。
 */
export class Board {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly paper: HTMLCanvasElement;
  private readonly paperCtx: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private readonly baseCtx: CanvasRenderingContext2D;

  private history: Command[] = [];
  /** 適用済みコマンド数（= history[0..cursor) が画面に反映されている） */
  private cursor = 0;
  /** base に焼き込み済みのコマンド数 */
  private baseCount = 0;

  private cssWidth = 0;
  private cssHeight = 0;
  private devWidth = 1;
  private devHeight = 1;
  /** 実ピクセル / CSS px */
  private scaleX = 1;
  private scaleY = 1;

  /** いまの下地の画像（null なら通常のキャンバス）。履歴の直近の clear コマンドで決まる */
  private currentPage: ImageBitmap | null = null;
  /** doc 座標 → 実ピクセル（x = a * docX + e, y = d * docY + f） */
  private toDevice = { a: 1, d: 1, e: 0, f: 0 };
  private currentView: View = { sx: 1, sy: 1, ox: 0, oy: 0 };
  /** 最初にステージの大きさが分かって、表示の配置を決めたか */
  private viewReady = false;

  private live: StrokeCommand | null = null;
  /** 選択範囲を持ち上げている間だけ、元の場所に空けておく穴（履歴には入れない） */
  private pendingCut: number[] | null = null;

  /** 履歴が変わったとき（Undo/Redo ボタンの状態更新用） */
  onChange: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, paper: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = get2d(canvas);
    this.paper = paper;
    this.paperCtx = get2d(paper);
    this.base = document.createElement("canvas");
    this.baseCtx = get2d(this.base);
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.history.length;
  }

  /** 何も描かれていない（または直前が全消去）状態か。画像キャンバスは白紙扱いしない */
  get isBlank(): boolean {
    if (this.live) return false;
    if (this.cursor === 0) return true;
    const last = this.history[this.cursor - 1];
    return last.kind === "clear" && !last.page;
  }

  get isDrawing(): boolean {
    return this.live !== null;
  }

  /** 画像キャンバスなら下地の画像 */
  get page(): ImageBitmap | null {
    return this.currentPage;
  }

  /** いまの doc 座標 → CSS px の変換 */
  get view(): View {
    return { ...this.currentView };
  }

  /**
   * 書き出される範囲が画面のどこにあるか（CSS px）。
   * 通常のキャンバスは見えているステージ全体、画像キャンバスは画像の範囲（拡大中は画面からはみ出すこともある）。
   */
  get docRect(): Rect {
    const page = this.currentPage;
    if (!page) return { x: 0, y: 0, w: this.cssWidth, h: this.cssHeight };
    const v = this.currentView;
    return { x: v.ox, y: v.oy, w: page.width * v.sx, h: page.height * v.sy };
  }

  /** 表示倍率。通常のキャンバスは 1 = 等倍（CSS px）、画像キャンバスは 1 = 画像 1px が画面の実ピクセル 1px */
  get zoom(): number {
    return this.zoomOf(this.currentView);
  }

  /** 表示がいちばん最初の倍率（通常は等倍、画像キャンバスは画面に収まる大きさ）か */
  get isHomeZoom(): boolean {
    return Math.abs(this.zoom / this.zoomOf(this.homeView()) - 1) < 1e-6;
  }

  /**
   * 書き出し・切り出しの 1px が画面上で何 CSS px か。
   * 貼り付けた画像を「画像 1px = 書き出し 1px」で置くのに使う
   * （通常は実ピクセル、画像キャンバスでは下地の画像のピクセル）。
   */
  get cssPerPixel(): number {
    return this.currentPage ? this.currentView.sx : 1 / this.scaleX;
  }

  toDoc(p: Vec): Vec {
    return viewToDoc(this.currentView, p);
  }

  toCss(p: Vec): Vec {
    return viewToCss(this.currentView, p);
  }

  /** CSS px の長さ（ペンの太さなど）を doc 座標の長さにする */
  lengthToDoc(length: number): number {
    return length / this.currentView.sx;
  }

  pathToDoc(path: number[]): number[] {
    return mapPath(path, (p) => this.toDoc(p));
  }

  pathToCss(path: number[]): number[] {
    return mapPath(path, (p) => this.toCss(p));
  }

  transformToDoc(t: ImageTransform): ImageTransform {
    const v = this.currentView;
    return mapTransform(t, (p) => this.toDoc(p), 1 / v.sx, 1 / v.sy);
  }

  transformToCss(t: ImageTransform): ImageTransform {
    const v = this.currentView;
    return mapTransform(t, (p) => this.toCss(p), v.sx, v.sy);
  }

  /**
   * キャンバスサイズを変更する。描いたものの画面上の位置は変えない（表示の配置はそのまま）。
   * @param cssW,cssH 表示サイズ（CSS px）
   * @param devW,devH 実ピクセルサイズ（HiDPI 対応。125% 表示なら CSS px の 1.25 倍）
   * @param shift ステージが画面上で動いた量（CSS px）。ウィンドウの左辺や上辺をつかんでサイズを変えると
   *              ステージの左上が動くので、その分だけ表示を逆にずらして、絵が画面上で止まって見えるようにする
   */
  resize(cssW: number, cssH: number, devW: number, devH: number, shift: Vec = { x: 0, y: 0 }): void {
    this.cssWidth = cssW;
    this.cssHeight = cssH;
    this.devWidth = Math.max(1, devW);
    this.devHeight = Math.max(1, devH);
    this.scaleX = cssW > 0 ? devW / cssW : 1;
    this.scaleY = cssH > 0 ? devH / cssH : 1;
    if (!this.viewReady && cssW > 0 && cssH > 0) {
      this.currentView = this.homeView();
      this.viewReady = true;
    } else {
      this.currentView.ox -= shift.x;
      this.currentView.oy -= shift.y;
    }
    this.relayout();
  }

  // ------------------------------------------------------------ 表示（拡大・縮小・移動）

  /** 表示をずらす（CSS px） */
  panBy(dx: number, dy: number): void {
    if (!dx && !dy) return;
    this.currentView.ox += dx;
    this.currentView.oy += dy;
    this.relayout();
  }

  /** 画面上の点 p（CSS px）を中心に factor 倍する */
  zoomAt(p: Vec, factor: number): void {
    const v = this.currentView;
    const z = this.zoom;
    const min = Math.min(ZOOM_MIN, this.zoomOf(this.homeView()));
    const k = clamp(z * factor, min, ZOOM_MAX) / z;
    if (Math.abs(k - 1) < 1e-9) return;
    v.sx *= k;
    v.sy *= k;
    v.ox = p.x - (p.x - v.ox) * k;
    v.oy = p.y - (p.y - v.oy) * k;
    this.relayout();
  }

  /** 表示を最初の状態（通常: 等倍で左上をそろえる / 画像キャンバス: 画面に収めて中央）に戻す */
  resetView(): void {
    this.currentView = this.homeView();
    this.relayout();
  }

  // ------------------------------------------------------------ ストローク

  /** 座標と太さは doc 座標 */
  beginStroke(tool: Tool, color: string, size: number, x: number, y: number): void {
    this.endStroke();
    this.live = { kind: "stroke", tool, color, size, points: [x, y] };
    // タップしただけでも点が打てるように、最初に丸を描く
    withStrokeStyle(this.ctx, this.live, (ctx) => {
      ctx.beginPath();
      ctx.arc(x, y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  extendStroke(x: number, y: number): void {
    const s = this.live;
    if (!s) return;
    const p = s.points;
    const n = p.length;
    // ほぼ同じ位置の点は捨てる（高レートなマウス/ペンで点が溜まりすぎないように）
    if (Math.hypot(x - p[n - 2], y - p[n - 1]) < 0.4) return;
    p.push(x, y);
    if (p.length < 6) return; // 3 点目から曲線が描ける

    // 中点を結ぶ二次ベジェで滑らかにする（drawStroke と同じ形になる）
    const k = p.length / 2 - 1; // 新しい点のインデックス
    const [ax, ay] = k - 2 === 0 ? [p[0], p[1]] : mid(p, k - 2);
    const [bx, by] = mid(p, k - 1);
    withStrokeStyle(this.ctx, s, (ctx) => {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(p[2 * (k - 1)], p[2 * (k - 1) + 1], bx, by);
      ctx.stroke();
    });
  }

  endStroke(): void {
    const s = this.live;
    if (!s) return;
    this.live = null;
    const p = s.points;
    const n = p.length / 2;
    if (n >= 2) {
      // 最後の中点 → 最終点 までを描いて締める
      const [ax, ay] = n === 2 ? [p[0], p[1]] : mid(p, n - 2);
      withStrokeStyle(this.ctx, s, (ctx) => {
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(p[2 * n - 2], p[2 * n - 1]);
        ctx.stroke();
      });
    }
    this.push(s);
  }

  // ------------------------------------------------------------ 画像・全消去

  /** 画像をキャンバスに焼き付ける（以降は動かせない） */
  addImage(bitmap: ImageBitmap, transform: ImageTransform): void {
    this.endStroke();
    const cmd: ImageCommand = { kind: "image", bitmap, transform: { ...transform } };
    drawCommand(this.ctx, cmd);
    this.push(cmd);
  }

  /**
   * 投げ縄の内側のピクセルを切り出す（キャンバスはまだ変更しない）。path は doc 座標。
   * 中身が完全に透明なら null。画像キャンバスでは下地の画像は含まない（書き込みだけ）。
   */
  extractRegion(path: number[]): { bitmap: ImageBitmap; transform: ImageTransform } | null {
    this.endStroke();
    const { src, m } = this.inkSource();

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < path.length; i += 2) {
      minX = Math.min(minX, path[i]);
      maxX = Math.max(maxX, path[i]);
      minY = Math.min(minY, path[i + 1]);
      maxY = Math.max(maxY, path[i + 1]);
    }
    // 切り出し元のピクセル単位の矩形に揃える（切り出した画像が元と 1:1 になるように）
    const x0 = clamp(Math.floor(minX * m.a + m.e) - 1, 0, src.width);
    const y0 = clamp(Math.floor(minY * m.d + m.f) - 1, 0, src.height);
    const x1 = clamp(Math.ceil(maxX * m.a + m.e) + 1, 0, src.width);
    const y1 = clamp(Math.ceil(maxY * m.d + m.f) + 1, 0, src.height);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 1 || h < 1) return null;

    const off = new OffscreenCanvas(w, h);
    const g = off.getContext("2d")!;
    g.setTransform(m.a, 0, 0, m.d, m.e - x0, m.f - y0);
    tracePath(g, path);
    g.clip();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(src, x0, y0, w, h, 0, 0, w, h);

    const alpha = g.getImageData(0, 0, w, h).data;
    let empty = true;
    for (let i = 3; i < alpha.length; i += 4) {
      if (alpha[i] !== 0) {
        empty = false;
        break;
      }
    }
    if (empty) return null;

    return {
      bitmap: off.transferToImageBitmap(),
      transform: {
        cx: (x0 + w / 2 - m.e) / m.a,
        cy: (y0 + h / 2 - m.f) / m.d,
        w: w / m.a,
        h: h / m.d,
        rotation: 0,
      },
    };
  }

  /**
   * バケツで塗る。p（doc 座標）の色と同じ色でつながっている範囲を color で塗る。
   * 見えている色（背景や下地の画像も含む）で範囲を決め、塗るのは書き込みのレイヤー。
   * 塗れなかった（範囲の外・すでに同じ色）ときは false。
   */
  fill(p: Vec, color: string): boolean {
    this.endStroke();
    const { src, m } = this.compositeSource();
    const sx = Math.floor(p.x * m.a + m.e);
    const sy = Math.floor(p.y * m.d + m.f);
    const w = src.width;
    const h = src.height;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return false;

    const pixels = src.getContext("2d")!.getImageData(0, 0, w, h).data;
    const rgb = parseHexColor(color);
    const seed = (sy * w + sx) * 4;
    const sameColor = Math.max(
      Math.abs(pixels[seed] - rgb[0]),
      Math.abs(pixels[seed + 1] - rgb[1]),
      Math.abs(pixels[seed + 2] - rgb[2]),
    );
    if (sameColor <= 2) return false;

    const region = floodFill(pixels, w, h, sx, sy, FILL_TOLERANCE);
    const { core, fringe, rect } = fillBitmaps(region, w, h, rgb);
    const cmd: FillCommand = {
      kind: "fill",
      core,
      fringe,
      rect: { x: (rect.x - m.e) / m.a, y: (rect.y - m.f) / m.d, w: rect.w / m.a, h: rect.h / m.d },
    };
    drawCommand(this.ctx, cmd);
    this.push(cmd);
    return true;
  }

  /** 選択範囲を持ち上げている間の「穴」を表示する / 消して元に戻す */
  setPendingCut(path: number[] | null): void {
    this.endStroke();
    this.pendingCut = path;
    if (path) erasePath(this.ctx, path);
    else this.redrawFromBase();
  }

  /** 投げ縄選択を確定する（bitmap が null なら削除） */
  commitSelection(path: number[], bitmap: ImageBitmap | null, transform: ImageTransform | null): void {
    this.endStroke();
    const cmd: SelectionCommand = { kind: "selection", path, bitmap, transform: transform && { ...transform } };
    // 画面には既に穴が空いているので、移動先に描くだけでよい
    if (!this.pendingCut) erasePath(this.ctx, path);
    this.pendingCut = null;
    if (bitmap && transform) drawImageWithTransform(this.ctx, bitmap, transform);
    this.push(cmd);
  }

  /** すべて消して、白紙の通常のキャンバスに戻す（画像キャンバスも通常のキャンバスに戻る） */
  clear(): void {
    this.startOver(null);
  }

  /** 画像を下地にした新しいキャンバスにする。画像の大きさがそのままキャンバスの大きさになる */
  openPage(bitmap: ImageBitmap): void {
    this.startOver(bitmap);
  }

  // ------------------------------------------------------------ Undo / Redo

  undo(): void {
    this.endStroke();
    if (!this.canUndo) return;
    this.cursor--;
    if (!this.followPage()) {
      if (this.cursor < this.baseCount) {
        this.rebuildBase(Math.max(0, this.cursor - BASE_LAG));
      }
      this.redrawFromBase();
    }
    this.onChange();
  }

  redo(): void {
    this.endStroke();
    if (!this.canRedo) return;
    // Redo は今の画面にそのコマンドを重ねるだけで済む（下地が変わるときは全部描き直す）
    drawCommand(this.ctx, this.history[this.cursor]);
    this.cursor++;
    if (!this.followPage()) this.maybeAdvanceBase();
    this.onChange();
  }

  // ------------------------------------------------------------ 書き出し

  /**
   * 背景ごと合成したキャンバスを返す。
   * 通常: 背景のグレー + 書き込み。見えているとおり（拡大・縮小もそのまま）を実ピクセル解像度で
   * 画像キャンバス: 下地の画像 + 書き込み（表示の倍率に関係なく、画像と同じ大きさ・解像度）
   */
  exportCanvas(): HTMLCanvasElement {
    this.endStroke();
    const page = this.currentPage;
    const out = document.createElement("canvas");
    out.width = page ? page.width : this.canvas.width;
    out.height = page ? page.height : this.canvas.height;
    const ctx = get2d(out);
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, out.width, out.height);
    if (page) {
      ctx.drawImage(page, 0, 0);
      ctx.drawImage(this.renderPageInk(page), 0, 0);
    } else {
      ctx.drawImage(this.canvas, 0, 0);
    }
    return out;
  }

  // ------------------------------------------------------------ 内部処理

  private startOver(page: ImageBitmap | null): void {
    this.endStroke();
    if (!page && this.isBlank) return;
    const cmd: ClearCommand = { kind: "clear", page };
    drawCommand(this.ctx, cmd);
    this.push(cmd);
  }

  private push(cmd: Command): void {
    // 新しい操作をしたら Redo 履歴は捨てる（貼り付け画像はペーストごとに別物なので解放してよい）
    for (const c of this.history.splice(this.cursor)) releaseBitmaps(c);
    this.history.push(cmd);
    this.cursor++;
    if (!this.followPage()) this.maybeAdvanceBase();
    this.onChange();
  }

  /**
   * 履歴の位置に合わせて下地（通常 / 画像キャンバス）を切り替える。
   * 切り替わると doc 座標の意味が変わるので、配置を決め直して全部描き直し、true を返す。
   */
  private followPage(): boolean {
    let page: ImageBitmap | null = null;
    for (let i = this.cursor - 1; i >= 0; i--) {
      const c = this.history[i];
      if (c.kind === "clear") {
        page = c.page;
        break;
      }
    }
    if (page === this.currentPage) return false;
    this.currentPage = page;
    // 下地が変わったら表示も最初の状態に戻す（画像キャンバスなら画面に収めて中央に置く）
    if (this.viewReady) this.currentView = this.homeView();
    this.relayout();
    return true;
  }

  /** 表示の配置（doc 座標 → 画面）を決め直して、すべて描き直す */
  private relayout(): void {
    // サイズを設定し直すと、内容と描画状態（変換・クリップ）がリセットされる
    for (const c of [this.canvas, this.base, this.paper]) {
      c.width = this.devWidth;
      c.height = this.devHeight;
    }
    this.applyView();
    this.applyDocTransform(this.ctx);
    this.applyDocTransform(this.baseCtx);
    this.drawPaper();

    this.rebuildBase(Math.max(0, this.cursor - BASE_LAG));
    this.redrawFromBase();
    if (this.live) drawStroke(this.ctx, this.live);
  }

  /**
   * 表示の最初の状態。通常のキャンバスは等倍で左上をそろえる。
   * 画像キャンバスは、画面に収まるなら「画像 1px = 画面の実ピクセル 1px」で中央に置き（スクショが元のままくっきり見える）、
   * 収まらなければ余白を残して縮小する（書き出しは元の大きさのまま）。
   */
  private homeView(): View {
    const page = this.currentPage;
    if (!page) return { sx: 1, sy: 1, ox: 0, oy: 0 };
    const w = this.devWidth;
    const h = this.devHeight;
    let s = 1;
    if (page.width > w || page.height > h) {
      const fitX = (w - 2 * PAGE_MARGIN * this.scaleX) / page.width;
      const fitY = (h - 2 * PAGE_MARGIN * this.scaleY) / page.height;
      s = Math.max(1e-3, Math.min(fitX, fitY));
    }
    const e = (w - page.width * s) / 2;
    const f = (h - page.height * s) / 2;
    return { sx: s / this.scaleX, sy: s / this.scaleY, ox: e / this.scaleX, oy: f / this.scaleY };
  }

  /** 表示の配置から、doc 座標 → 実ピクセルの変換を決める */
  private applyView(): void {
    const v = this.currentView;
    // 描くときの位置は実ピクセルに揃える（等倍のときに線や画像がにじまないように）。
    // 表示の配置そのものは丸めずに持っておく（細かく動かしたときに丸めの誤差が積み重ならないように）
    this.toDevice = {
      a: v.sx * this.scaleX,
      d: v.sy * this.scaleY,
      e: Math.round(v.ox * this.scaleX),
      f: Math.round(v.oy * this.scaleY),
    };
  }

  private zoomOf(v: View): number {
    return this.currentPage ? v.sx * this.scaleX : v.sx;
  }

  /**
   * 書き込みのレイヤーのピクセルと、doc 座標 → そのピクセルの変換（投げ縄の切り出し用）。
   * 通常: 表示中のキャンバス。画像キャンバス: 縮小・拡大表示のこともあるので、画像と同じ解像度で描き直したもの
   * （動かしても書き出しの画質が落ちない）。
   */
  private inkSource(): { src: HTMLCanvasElement | OffscreenCanvas; m: { a: number; d: number; e: number; f: number } } {
    const page = this.currentPage;
    if (page) return { src: this.renderPageInk(page), m: { a: 1, d: 1, e: 0, f: 0 } };
    return { src: this.canvas, m: { ...this.toDevice } };
  }

  /** 見えている色（背景・下地の画像・書き込みを重ねたもの）と、doc 座標 → そのピクセルの変換（塗りつぶし用） */
  private compositeSource(): { src: OffscreenCanvas; m: { a: number; d: number; e: number; f: number } } {
    const page = this.currentPage;
    const { src: ink, m } = this.inkSource();
    const out = new OffscreenCanvas(ink.width, ink.height);
    const g = out.getContext("2d")!;
    g.fillStyle = CANVAS_BG;
    g.fillRect(0, 0, out.width, out.height);
    if (page) g.drawImage(page, 0, 0);
    g.drawImage(ink, 0, 0);
    return { src: out, m };
  }

  private applyDocTransform(ctx: CanvasRenderingContext2D): void {
    const m = this.toDevice;
    ctx.setTransform(m.a, 0, 0, m.d, m.e, m.f);
    const page = this.currentPage;
    if (page) {
      // 画像の外にはみ出した線は、表示も書き出しもしない
      ctx.beginPath();
      ctx.rect(0, 0, page.width, page.height);
      ctx.clip();
    }
  }

  /** 画像キャンバスの下地を描く（通常のキャンバスでは何も描かず、CSS の背景が見える） */
  private drawPaper(): void {
    const page = this.currentPage;
    if (!page) return;
    const ctx = this.paperCtx;
    const m = this.toDevice;
    ctx.save();
    ctx.setTransform(m.a, 0, 0, m.d, m.e, m.f);
    // 机に置いた紙のような影（影のぼかしとずれは変換の影響を受けないので実ピクセルで指定）
    ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
    ctx.shadowBlur = 12 * this.scaleX;
    ctx.shadowOffsetY = 2 * this.scaleY;
    // 透過のある画像は、通常のキャンバスと同じ紙の色の上に置く（書き出しも同じ）
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, page.width, page.height);
    ctx.restore();

    ctx.save();
    ctx.setTransform(m.a, 0, 0, m.d, m.e, m.f);
    // 縮小表示はなめらかに、拡大表示はドットがはっきり見えるように（スクショの文字がぼやけない）
    ctx.imageSmoothingEnabled = m.a < 1;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(page, 0, 0);
    ctx.restore();
  }

  /** 画像キャンバスの書き込みを、画像と同じ解像度で描き直す（書き出し・投げ縄の切り出し用） */
  private renderPageInk(page: ImageBitmap): OffscreenCanvas {
    const off = new OffscreenCanvas(page.width, page.height);
    this.renderRange(off.getContext("2d")!, this.segmentStart(this.cursor), this.cursor);
    return off;
  }

  private maybeAdvanceBase(): void {
    if (this.cursor - this.baseCount <= BASE_ADVANCE) return;
    const target = this.cursor - BASE_LAG;
    this.renderRange(this.baseCtx, this.baseCount, target);
    this.baseCount = target;
  }

  /** base を history[0..count) の状態で作り直す */
  private rebuildBase(count: number): void {
    clearAll(this.baseCtx);
    this.renderRange(this.baseCtx, this.segmentStart(count), count);
    this.baseCount = count;
  }

  /** history[0..count) のうち描く必要がある最初の位置（直近の clear より前は消えているので描かない） */
  private segmentStart(count: number): number {
    for (let i = count - 1; i >= 0; i--) {
      if (this.history[i].kind === "clear") return i + 1;
    }
    return 0;
  }

  /** 表示キャンバス = base + history[baseCount..cursor) */
  private redrawFromBase(): void {
    clearAll(this.ctx);
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.base, 0, 0);
    this.ctx.restore();
    this.renderRange(this.ctx, this.baseCount, this.cursor);
    if (this.pendingCut) erasePath(this.ctx, this.pendingCut);
  }

  private renderRange(ctx: Ctx2D, from: number, to: number): void {
    for (let i = from; i < to; i++) drawCommand(ctx, this.history[i]);
  }
}

// ------------------------------------------------------------------ 座標変換

/** doc 座標 → CSS px */
export function viewToCss(v: View, p: Vec): Vec {
  return { x: p.x * v.sx + v.ox, y: p.y * v.sy + v.oy };
}

/** CSS px → doc 座標 */
export function viewToDoc(v: View, p: Vec): Vec {
  return { x: (p.x - v.ox) / v.sx, y: (p.y - v.oy) / v.sy };
}

/** パスの各点を map で変換する */
export function mapPath(path: number[], map: (p: Vec) => Vec): number[] {
  const out = new Array<number>(path.length);
  for (let i = 0; i < path.length; i += 2) {
    const q = map({ x: path[i], y: path[i + 1] });
    out[i] = q.x;
    out[i + 1] = q.y;
  }
  return out;
}

/** 画像の配置を変換する（中心は map で移し、大きさは kx, ky 倍。回転はそのまま） */
export function mapTransform(t: ImageTransform, map: (p: Vec) => Vec, kx: number, ky: number): ImageTransform {
  const c = map({ x: t.cx, y: t.cy });
  return { cx: c.x, cy: c.y, w: t.w * kx, h: t.h * ky, rotation: t.rotation };
}

// ------------------------------------------------------------------ 描画ヘルパー

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 閉じたポリゴンとしてパスを引く */
export function tracePath(ctx: Ctx2D | CanvasRenderingContext2D, path: number[]): void {
  ctx.beginPath();
  ctx.moveTo(path[0], path[1]);
  for (let i = 2; i < path.length; i += 2) ctx.lineTo(path[i], path[i + 1]);
  ctx.closePath();
}

/** パスの内側を透明にする（自己交差した投げ縄も、囲まれた部分はすべて対象） */
function erasePath(ctx: Ctx2D, path: number[]): void {
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#000";
  tracePath(ctx, path);
  ctx.fill("nonzero");
  ctx.restore();
}

// ------------------------------------------------------------------ 塗りつぶし

function parseHexColor(color: string): [number, number, number] {
  const hex = color.replace("#", "");
  const n = parseInt(hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * (sx, sy) と同じ色（差が tolerance 以内）で上下左右につながっている範囲を求める（スキャンライン法）。
 * 戻り値は範囲に入るピクセルが 1 のマスクと、その外接矩形。
 */
export function floodFill(
  pixels: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  tolerance: number,
): { mask: Uint8Array; x0: number; y0: number; x1: number; y1: number } {
  const mask = new Uint8Array(w * h);
  const i0 = (sy * w + sx) * 4;
  const r0 = pixels[i0];
  const g0 = pixels[i0 + 1];
  const b0 = pixels[i0 + 2];
  const same = (p: number) => {
    const i = p * 4;
    return (
      Math.abs(pixels[i] - r0) <= tolerance &&
      Math.abs(pixels[i + 1] - g0) <= tolerance &&
      Math.abs(pixels[i + 2] - b0) <= tolerance
    );
  };
  let x0 = sx;
  let y0 = sy;
  let x1 = sx;
  let y1 = sy;
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    const row = y * w;
    if (mask[row + x]) continue;
    // 横に伸ばせるところまで伸ばして、その 1 行をまとめて塗る
    let l = x;
    let r = x;
    while (l > 0 && !mask[row + l - 1] && same(row + l - 1)) l--;
    while (r < w - 1 && !mask[row + r + 1] && same(row + r + 1)) r++;
    for (let i = l; i <= r; i++) mask[row + i] = 1;
    if (l < x0) x0 = l;
    if (r > x1) x1 = r;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    // 上下の行で、同じ色が続いている区間ごとに 1 つだけ種を積む
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let inSpan = false;
      for (let i = l; i <= r; i++) {
        const ok = !mask[nrow + i] && same(nrow + i);
        if (ok && !inSpan) stack.push(i, ny);
        inSpan = ok;
      }
    }
  }
  return { mask, x0, y0, x1, y1 };
}

/** 塗る範囲のマスクから、塗る画像（core）と外周 1px の画像（fringe）を作る */
function fillBitmaps(
  region: ReturnType<typeof floodFill>,
  w: number,
  h: number,
  [r, g, b]: [number, number, number],
): { core: ImageBitmap; fringe: ImageBitmap | null; rect: Rect } {
  const { mask } = region;
  // 外周の分だけ 1px 広げた矩形
  const x0 = Math.max(0, region.x0 - 1);
  const y0 = Math.max(0, region.y0 - 1);
  const x1 = Math.min(w - 1, region.x1 + 1);
  const y1 = Math.min(h - 1, region.y1 + 1);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const core = new ImageData(bw, bh);
  const fringe = new ImageData(bw, bh);
  let hasFringe = false;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const o = ((y - y0) * bw + (x - x0)) * 4;
      let target: ImageData | null = null;
      if (mask[y * w + x]) {
        target = core;
      } else {
        // 範囲に隣接（斜めも含む）しているピクセルが外周
        for (let dy = -1; dy <= 1 && !target; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx >= 0 && nx < w && mask[ny * w + nx]) {
              target = fringe;
              hasFringe = true;
              break;
            }
          }
        }
      }
      if (target) {
        target.data[o] = r;
        target.data[o + 1] = g;
        target.data[o + 2] = b;
        target.data[o + 3] = 255;
      }
    }
  }
  const off = new OffscreenCanvas(bw, bh);
  const ctx = off.getContext("2d")!;
  ctx.putImageData(core, 0, 0);
  const coreBitmap = off.transferToImageBitmap();
  let fringeBitmap: ImageBitmap | null = null;
  if (hasFringe) {
    ctx.putImageData(fringe, 0, 0);
    fringeBitmap = off.transferToImageBitmap();
  }
  return { core: coreBitmap, fringe: fringeBitmap, rect: { x: x0, y: y0, w: bw, h: bh } };
}

function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is not available");
  return ctx;
}

/** 履歴から捨てるコマンドが持っている画像を解放する */
function releaseBitmaps(c: Command): void {
  if (c.kind === "image") c.bitmap.close();
  else if (c.kind === "selection") c.bitmap?.close();
  else if (c.kind === "clear") c.page?.close();
  else if (c.kind === "fill") {
    c.core.close();
    c.fringe?.close();
  }
}

/** points 配列の i 番目と i+1 番目の中点 */
function mid(p: number[], i: number): [number, number] {
  return [(p[2 * i] + p[2 * i + 2]) / 2, (p[2 * i + 1] + p[2 * i + 3]) / 2];
}

function withStrokeStyle(ctx: Ctx2D, s: StrokeCommand, draw: (ctx: Ctx2D) => void): void {
  ctx.save();
  // 消しゴムは「透明にする」合成モード。色は何でもよい
  ctx.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
  ctx.strokeStyle = ctx.fillStyle = s.tool === "eraser" ? "#000" : s.color;
  ctx.lineWidth = s.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  draw(ctx);
  ctx.restore();
}

/** ストロークを 1 本のパスとして描く（Undo 後の再生用） */
function drawStroke(ctx: Ctx2D, s: StrokeCommand): void {
  const p = s.points;
  const n = p.length / 2;
  withStrokeStyle(ctx, s, (ctx) => {
    ctx.beginPath();
    if (n === 1) {
      ctx.arc(p[0], p[1], s.size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.moveTo(p[0], p[1]);
    for (let i = 1; i < n - 1; i++) {
      const [mx, my] = mid(p, i);
      ctx.quadraticCurveTo(p[2 * i], p[2 * i + 1], mx, my);
    }
    ctx.lineTo(p[2 * n - 2], p[2 * n - 1]);
    ctx.stroke();
  });
}

export function drawImageWithTransform(
  ctx: Ctx2D,
  bitmap: CanvasImageSource,
  t: ImageTransform,
): void {
  ctx.save();
  ctx.translate(t.cx, t.cy);
  ctx.rotate(t.rotation);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, -t.w / 2, -t.h / 2, t.w, t.h);
  ctx.restore();
}

function clearAll(ctx: Ctx2D): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

function drawCommand(ctx: Ctx2D, cmd: Command): void {
  switch (cmd.kind) {
    case "stroke":
      drawStroke(ctx, cmd);
      break;
    case "image":
      drawImageWithTransform(ctx, cmd.bitmap, cmd.transform);
      break;
    case "clear":
      clearAll(ctx);
      break;
    case "selection":
      erasePath(ctx, cmd.path);
      if (cmd.bitmap && cmd.transform) drawImageWithTransform(ctx, cmd.bitmap, cmd.transform);
      break;
    case "fill": {
      const r = cmd.rect;
      ctx.save();
      ctx.drawImage(cmd.core, r.x, r.y, r.w, r.h);
      if (cmd.fringe) {
        // 外周は今ある線の「下」に塗る（線は消さずに、線とのすき間だけ埋まる）
        ctx.globalCompositeOperation = "destination-over";
        ctx.drawImage(cmd.fringe, r.x, r.y, r.w, r.h);
      }
      ctx.restore();
      break;
    }
  }
}
