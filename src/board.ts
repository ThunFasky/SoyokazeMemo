import { CANVAS_BG } from "./palette";

export type Tool = "pen" | "eraser";

/** 回転・拡縮を含む画像の配置。座標はすべてキャンバスの CSS px。 */
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

export interface ClearCommand {
  kind: "clear";
}

/**
 * 投げ縄選択の確定。path の内側を消して、切り取った画像を transform の位置に描く。
 * 「切り取り＋貼り付け」を 1 コマンドにしているので、Undo 1 回で丸ごと元に戻る。
 * bitmap が null のときは選択範囲の削除。
 */
export interface SelectionCommand {
  kind: "selection";
  /** 投げ縄の閉じたパス [x0, y0, x1, y1, ...]（CSS px） */
  path: number[];
  bitmap: ImageBitmap | null;
  transform: ImageTransform | null;
}

export type Command = StrokeCommand | ImageCommand | ClearCommand | SelectionCommand;

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** これより新しいコマンドは base に焼かずに残す（＝この回数までの Undo はほぼ一瞬）。 */
const BASE_LAG = 24;
/** base と現在位置の差がこれを超えたら base を進める。 */
const BASE_ADVANCE = BASE_LAG * 2;

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
 */
export class Board {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private readonly baseCtx: CanvasRenderingContext2D;

  private history: Command[] = [];
  /** 適用済みコマンド数（= history[0..cursor) が画面に反映されている） */
  private cursor = 0;
  /** base に焼き込み済みのコマンド数 */
  private baseCount = 0;

  private cssWidth = 0;
  private cssHeight = 0;
  private scaleX = 1;
  private scaleY = 1;

  private live: StrokeCommand | null = null;
  /** 選択範囲を持ち上げている間だけ、元の場所に空けておく穴（履歴には入れない） */
  private pendingCut: number[] | null = null;

  /** 履歴が変わったとき（Undo/Redo ボタンの状態更新用） */
  onChange: () => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = get2d(canvas);
    this.base = document.createElement("canvas");
    this.baseCtx = get2d(this.base);
  }

  get width(): number {
    return this.cssWidth;
  }

  get height(): number {
    return this.cssHeight;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.history.length;
  }

  /** 何も描かれていない（または直前が全消去）状態か */
  get isBlank(): boolean {
    return this.live === null && (this.cursor === 0 || this.history[this.cursor - 1].kind === "clear");
  }

  get isDrawing(): boolean {
    return this.live !== null;
  }

  /**
   * キャンバスサイズを変更する。
   * @param cssW,cssH 表示サイズ（CSS px）
   * @param devW,devH 実ピクセルサイズ（HiDPI 対応。125% 表示なら CSS px の 1.25 倍）
   */
  resize(cssW: number, cssH: number, devW: number, devH: number): void {
    this.cssWidth = cssW;
    this.cssHeight = cssH;
    this.scaleX = cssW > 0 ? devW / cssW : 1;
    this.scaleY = cssH > 0 ? devH / cssH : 1;
    for (const c of [this.canvas, this.base]) {
      c.width = Math.max(1, devW);
      c.height = Math.max(1, devH);
    }
    this.resetTransform(this.ctx);
    this.resetTransform(this.baseCtx);

    this.rebuildBase(Math.max(0, this.cursor - BASE_LAG));
    this.redrawFromBase();
    if (this.live) drawStroke(this.ctx, this.live);
  }

  // ------------------------------------------------------------ ストローク

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
   * 投げ縄の内側のピクセルを切り出す（キャンバスはまだ変更しない）。
   * 中身が完全に透明なら null。
   */
  extractRegion(path: number[]): { bitmap: ImageBitmap; transform: ImageTransform } | null {
    this.endStroke();
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
    // 実ピクセル単位の矩形に揃える（切り出した画像が画面と 1:1 になるように）
    const x0 = clamp(Math.floor(minX * this.scaleX) - 1, 0, this.canvas.width);
    const y0 = clamp(Math.floor(minY * this.scaleY) - 1, 0, this.canvas.height);
    const x1 = clamp(Math.ceil(maxX * this.scaleX) + 1, 0, this.canvas.width);
    const y1 = clamp(Math.ceil(maxY * this.scaleY) + 1, 0, this.canvas.height);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 1 || h < 1) return null;

    const off = new OffscreenCanvas(w, h);
    const g = off.getContext("2d")!;
    g.setTransform(this.scaleX, 0, 0, this.scaleY, -x0, -y0);
    tracePath(g, path);
    g.clip();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.canvas, x0, y0, w, h, 0, 0, w, h);

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
        cx: (x0 + w / 2) / this.scaleX,
        cy: (y0 + h / 2) / this.scaleY,
        w: w / this.scaleX,
        h: h / this.scaleY,
        rotation: 0,
      },
    };
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

  clear(): void {
    this.endStroke();
    if (this.isBlank) return;
    const cmd: ClearCommand = { kind: "clear" };
    drawCommand(this.ctx, cmd);
    this.push(cmd);
  }

  // ------------------------------------------------------------ Undo / Redo

  undo(): void {
    this.endStroke();
    if (!this.canUndo) return;
    this.cursor--;
    if (this.cursor < this.baseCount) {
      this.rebuildBase(Math.max(0, this.cursor - BASE_LAG));
    }
    this.redrawFromBase();
    this.onChange();
  }

  redo(): void {
    this.endStroke();
    if (!this.canRedo) return;
    // Redo は今の画面にそのコマンドを重ねるだけで済む
    drawCommand(this.ctx, this.history[this.cursor]);
    this.cursor++;
    this.maybeAdvanceBase();
    this.onChange();
  }

  // ------------------------------------------------------------ 書き出し

  /** 背景のグレーごと合成したキャンバス（実ピクセル解像度）を返す */
  exportCanvas(): HTMLCanvasElement {
    this.endStroke();
    const out = document.createElement("canvas");
    out.width = this.canvas.width;
    out.height = this.canvas.height;
    const ctx = get2d(out);
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(this.canvas, 0, 0);
    return out;
  }

  // ------------------------------------------------------------ 内部処理

  private push(cmd: Command): void {
    // 新しい操作をしたら Redo 履歴は捨てる（貼り付け画像はペーストごとに別物なので解放してよい）
    for (const c of this.history.splice(this.cursor)) {
      if (c.kind === "image" || c.kind === "selection") c.bitmap?.close();
    }
    this.history.push(cmd);
    this.cursor++;
    this.maybeAdvanceBase();
    this.onChange();
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
    // 直近の全消去より前は描いても消えるだけなのでスキップ
    let start = 0;
    for (let i = count - 1; i >= 0; i--) {
      if (this.history[i].kind === "clear") {
        start = i + 1;
        break;
      }
    }
    this.renderRange(this.baseCtx, start, count);
    this.baseCount = count;
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

  private resetTransform(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(this.scaleX, 0, 0, this.scaleY, 0, 0);
  }
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

function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is not available");
  return ctx;
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
  }
}
