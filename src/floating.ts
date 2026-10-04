import { drawImageWithTransform, tracePath, type ImageTransform } from "./board";

export interface Vec {
  x: number;
  y: number;
}

/** バウンディングボックス上の掴める場所 */
export type Handle = "move" | "rotate" | "nw" | "ne" | "se" | "sw";

type Corner = Exclude<Handle, "move" | "rotate">;

/** 角の向き（ローカル座標での符号） */
const CORNERS: Record<Corner, readonly [number, number]> = {
  nw: [-1, -1],
  ne: [1, -1],
  se: [1, 1],
  sw: [-1, 1],
};

const HANDLE_SIZE = 10; // 角の四角の一辺（CSS px）
const HANDLE_HIT = 10; // 角の当たり判定の半径
const ROTATE_OFFSET = 28; // 上辺から回転ハンドルまでの距離
const ROTATE_RADIUS = 6;
const ROTATE_HIT = 12;
const MIN_SIZE = 12; // これより小さくは縮めない
const SNAP_ANGLE = Math.PI / 12; // Shift 押下時の回転スナップ（15°）

const FRAME_COLOR = "#3a7bd5";

/** ドラッグ開始時点の情報。変形は常に「開始時点からの差分」で計算する（誤差が溜まらない） */
export interface DragStart {
  handle: Handle;
  pointer: Vec;
  transform: ImageTransform;
}

/** 投げ縄で持ち上げた選択範囲の情報 */
export interface SelectionSource {
  /** 投げ縄のパス（持ち上げた時点の CSS px 座標） */
  path: number[];
  /** 持ち上げた時点の配置（動かしていないかの判定と、輪郭の描画に使う） */
  initial: ImageTransform;
}

/**
 * ペーストされた直後の「まだ確定していない」画像。
 * キャンバスには焼かず、オーバーレイに描画して移動・拡縮・回転を受け付ける。
 */
export class FloatingImage {
  readonly bitmap: ImageBitmap;
  t: ImageTransform;
  /** 投げ縄選択から作られた場合だけ入る */
  readonly selection: SelectionSource | null;

  constructor(bitmap: ImageBitmap, t: ImageTransform, selection: SelectionSource | null = null) {
    this.bitmap = bitmap;
    this.t = t;
    this.selection = selection;
  }

  /** 投げ縄で切り出した範囲を、元の位置にそのまま浮かせる */
  static fromSelection(bitmap: ImageBitmap, t: ImageTransform, path: number[]): FloatingImage {
    return new FloatingImage(bitmap, { ...t }, { path, initial: { ...t } });
  }

  /** 持ち上げてから一度も動かしていないか */
  get isUnmoved(): boolean {
    const a = this.t;
    const b = this.selection?.initial;
    return !!b && a.cx === b.cx && a.cy === b.cy && a.w === b.w && a.h === b.h && a.rotation === b.rotation;
  }

  /**
   * 画像の初期配置を決める。
   * 画像 1px = 画面 1 実ピクセルで置き、画面の 90% に収まらない場合は縮小する。
   */
  static place(bitmap: ImageBitmap, viewW: number, viewH: number, pixelRatio: number, at?: Vec): FloatingImage {
    let w = bitmap.width / pixelRatio;
    let h = bitmap.height / pixelRatio;
    const fit = Math.min(1, (viewW * 0.9) / w, (viewH * 0.9) / h);
    if (Number.isFinite(fit) && fit > 0) {
      w *= fit;
      h *= fit;
    }
    return new FloatingImage(bitmap, {
      cx: at?.x ?? viewW / 2,
      cy: at?.y ?? viewH / 2,
      w,
      h,
      rotation: 0,
    });
  }

  // ------------------------------------------------------------ 座標変換

  /** 画面座標 → 画像ローカル座標（画像中心が原点、回転を打ち消した座標系） */
  toLocal(p: Vec): Vec {
    const { cx, cy, rotation } = this.t;
    const cos = Math.cos(-rotation);
    const sin = Math.sin(-rotation);
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  }

  // ------------------------------------------------------------ 当たり判定

  hitTest(p: Vec): Handle | null {
    const l = this.toLocal(p);
    const hw = this.t.w / 2;
    const hh = this.t.h / 2;

    if (Math.hypot(l.x, l.y + hh + ROTATE_OFFSET) <= ROTATE_HIT) return "rotate";

    for (const [name, [sx, sy]] of Object.entries(CORNERS) as [Corner, readonly [number, number]][]) {
      if (Math.abs(l.x - sx * hw) <= HANDLE_HIT && Math.abs(l.y - sy * hh) <= HANDLE_HIT) return name;
    }

    if (Math.abs(l.x) <= hw && Math.abs(l.y) <= hh) return "move";
    return null;
  }

  /** ハンドルに応じたマウスカーソル。角のカーソルは画像の回転に合わせて向きを変える */
  cursorFor(handle: Handle | null, dragging = false): string {
    if (handle === null) return "default";
    if (handle === "move") return "move";
    if (handle === "rotate") return dragging ? "grabbing" : "grab";

    const [sx, sy] = CORNERS[handle];
    // 対角線の向き（画面座標, y 下向き）を 0〜180° に正規化して 4 方向に丸める
    const angle = Math.atan2(sy * this.t.h, sx * this.t.w) + this.t.rotation;
    const deg = ((((angle * 180) / Math.PI) % 180) + 180) % 180;
    const cursors = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];
    return cursors[Math.round(deg / 45) % 4];
  }

  // ------------------------------------------------------------ 変形

  beginDrag(handle: Handle, pointer: Vec): DragStart {
    return { handle, pointer, transform: { ...this.t } };
  }

  /**
   * ドラッグ中の変形を適用する。
   * Shift 押下中: 角ドラッグは縦横比フリー、回転は 15° 単位にスナップ。
   */
  dragTo(start: DragStart, p: Vec, modifiers: { shift: boolean }): void {
    const s = start.transform;
    switch (start.handle) {
      case "move":
        this.t = { ...s, cx: s.cx + p.x - start.pointer.x, cy: s.cy + p.y - start.pointer.y };
        return;

      case "rotate": {
        const a0 = Math.atan2(start.pointer.y - s.cy, start.pointer.x - s.cx);
        const a1 = Math.atan2(p.y - s.cy, p.x - s.cx);
        let rotation = s.rotation + (a1 - a0);
        if (modifiers.shift) rotation = Math.round(rotation / SNAP_ANGLE) * SNAP_ANGLE;
        this.t = { ...s, rotation };
        return;
      }

      default:
        this.t = scaleFromCorner(s, CORNERS[start.handle], p, !modifiers.shift);
    }
  }

  /** ホイール等で中心を基準に拡大縮小 */
  scaleBy(factor: number): void {
    const minFactor = MIN_SIZE / Math.min(this.t.w, this.t.h);
    const f = Math.max(factor, Math.min(1, minFactor));
    this.t = { ...this.t, w: this.t.w * f, h: this.t.h * f };
  }

  nudge(dx: number, dy: number): void {
    this.t = { ...this.t, cx: this.t.cx + dx, cy: this.t.cy + dy };
  }

  // ------------------------------------------------------------ 描画

  /** オーバーレイに画像本体 + バウンディングボックス + ハンドルを描く */
  draw(ctx: CanvasRenderingContext2D, now = 0): void {
    drawImageWithTransform(ctx, this.bitmap, this.t);
    if (this.selection) this.drawLassoOutline(ctx, now);

    const { cx, cy, w, h, rotation } = this.t;
    const hw = w / 2;
    const hh = h / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);

    // 枠線: どんな画像の上でも見えるよう、白い縁取りの上に青線
    const frame = () => {
      ctx.beginPath();
      ctx.rect(-hw, -hh, w, h);
      ctx.moveTo(0, -hh);
      ctx.lineTo(0, -hh - ROTATE_OFFSET + ROTATE_RADIUS);
    };
    frame();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.stroke();
    frame();
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = FRAME_COLOR;
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = FRAME_COLOR;
    ctx.lineWidth = 1.5;

    // 回転ハンドル
    ctx.beginPath();
    ctx.arc(0, -hh - ROTATE_OFFSET, ROTATE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 角の拡縮ハンドル
    for (const [sx, sy] of Object.values(CORNERS)) {
      const x = sx * hw - HANDLE_SIZE / 2;
      const y = sy * hh - HANDLE_SIZE / 2;
      ctx.fillRect(x, y, HANDLE_SIZE, HANDLE_SIZE);
      ctx.strokeRect(x, y, HANDLE_SIZE, HANDLE_SIZE);
    }
    ctx.restore();
  }

  /** 投げ縄の輪郭を、今の移動・拡縮・回転に合わせて動く点線で描く */
  private drawLassoOutline(ctx: CanvasRenderingContext2D, now: number): void {
    const sel = this.selection;
    if (!sel) return;
    const { cx, cy, w, h, rotation } = this.t;
    const init = sel.initial;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    ctx.scale(w / init.w, h / init.h);
    ctx.translate(-init.cx, -init.cy);
    tracePath(ctx, sel.path);
    ctx.restore(); // パスは保持したまま、線の太さだけ拡縮の影響を受けないようにする
    strokeMarchingAnts(ctx, now);
  }
}

/** 白黒の「動く点線」。選択範囲の定番表示 */
export function strokeMarchingAnts(ctx: CanvasRenderingContext2D, now: number): void {
  ctx.save();
  ctx.lineWidth = 1.25;
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.stroke();
  ctx.setLineDash([5, 4]);
  ctx.lineDashOffset = -(now / 60) % 9;
  ctx.strokeStyle = "rgba(20, 22, 26, 0.9)";
  ctx.stroke();
  ctx.restore();
}

/**
 * 角をドラッグしたときの拡縮。反対側の角を固定点にする。
 * 回転している画像でも、ポインタ位置を画像のローカル軸に射影して計算する。
 */
function scaleFromCorner(
  s: ImageTransform,
  [sx, sy]: readonly [number, number],
  p: Vec,
  keepAspect: boolean,
): ImageTransform {
  const ux = Math.cos(s.rotation);
  const uy = Math.sin(s.rotation); // 画像の x 軸
  const vx = -uy;
  const vy = ux; // 画像の y 軸

  // 固定される反対側の角
  const fx = s.cx - (sx * s.w * ux) / 2 - (sy * s.h * vx) / 2;
  const fy = s.cy - (sx * s.w * uy) / 2 - (sy * s.h * vy) / 2;

  // 固定点 → ポインタ を画像ローカル軸に射影（ドラッグしている角の向きを正とする）
  const dx = ((p.x - fx) * ux + (p.y - fy) * uy) * sx;
  const dy = ((p.x - fx) * vx + (p.y - fy) * vy) * sy;

  let w: number;
  let h: number;
  if (keepAspect) {
    // 対角線方向への射影で倍率を決めると、手の動きに自然に追従する
    const t = (dx * s.w + dy * s.h) / (s.w * s.w + s.h * s.h);
    const minT = MIN_SIZE / Math.min(s.w, s.h);
    const k = Math.max(t, minT);
    w = s.w * k;
    h = s.h * k;
  } else {
    w = Math.max(dx, MIN_SIZE);
    h = Math.max(dy, MIN_SIZE);
  }

  return {
    ...s,
    w,
    h,
    cx: fx + (sx * w * ux) / 2 + (sy * h * vx) / 2,
    cy: fy + (sx * w * uy) / 2 + (sy * h * vy) / 2,
  };
}
