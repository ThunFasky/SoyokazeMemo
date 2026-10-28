import "./styles.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Board, tracePath, type Tool, type Vec } from "./board";
import {
  copyCanvasToClipboard,
  decodeImage,
  hasFiles,
  imageFromDataTransfer,
  isNativeApp,
  readClipboardImage,
  readNativeClipboardImage,
} from "./clipboard";
import { FloatingImage, strokeMarchingAnts, type DragStart } from "./floating";
import { PALETTE, SIZE_MAX, SIZE_MIN } from "./palette";
import { applyPlatform, isMac, MOD } from "./platform";
import { captureScreenRegion } from "./screen";
import { initTitlebar } from "./titlebar";

// ================================================================== DOM

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`${selector} が見つかりません`);
  return el;
}

const toolbar = $(".toolbar");
const stage = $("#stage");
const overlay = $<HTMLCanvasElement>("#overlay");
const octx = overlay.getContext("2d")!;
const sizeInput = $<HTMLInputElement>("#size");
const sizeValue = $<HTMLOutputElement>("#size-value");
const sizeDot = $("#size-dot");
const paletteEl = $("#palette");
const undoBtn = $<HTMLButtonElement>("#undo");
const redoBtn = $<HTMLButtonElement>("#redo");
const clearBtn = $<HTMLButtonElement>("#clear");
const copyBtn = $<HTMLButtonElement>("#copy");
const openBtn = $<HTMLButtonElement>("#open-clipboard");
const captureBtn = $<HTMLButtonElement>("#capture-screen");
const emptyHint = $("#empty-hint");
const floatHint = $("#float-hint");
const toastEl = $("#toast");
const zoomBadge = $<HTMLButtonElement>("#zoom-badge");
const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tool]"));

// ================================================================== 状態

const board = new Board($<HTMLCanvasElement>("#ink"), $<HTMLCanvasElement>("#paper"));

/** ツールバーで選べるツール。lasso は投げ縄選択、fill はバケツ（塗りつぶし） */
type ActiveTool = Tool | "lasso" | "fill";

/** 太さのあるツール（ペン・消しゴム）か */
function isBrush(tool: ActiveTool): tool is Tool {
  return tool === "pen" || tool === "eraser";
}

const state = {
  tool: "pen" as ActiveTool,
  color: PALETTE[0].value,
  /** ペンと消しゴムで太さを別々に覚えておく */
  sizes: { pen: 4, eraser: 24 } as Record<Tool, number>,
};

/** 貼り付け直後の未確定画像（なければ null） */
let floating: FloatingImage | null = null;
/** ブラシカーソル表示用のポインタ位置 */
let hover: Vec | null = null;
/** Space を押している間は、ドラッグで表示を動かす */
let spaceHeld = false;

type Gesture =
  | { kind: "idle" }
  | { kind: "draw"; pointerId: number }
  | { kind: "transform"; pointerId: number; drag: DragStart; last: Vec }
  /** 投げ縄で範囲をなぞっている途中 */
  | { kind: "lasso"; pointerId: number; points: number[] }
  /** 表示を動かしている途中（中ボタン / Space + ドラッグ） */
  | { kind: "pan"; pointerId: number; last: Vec }
  /** 未確定画像の外側クリック（＝確定）やバケツのクリック。そのクリックでは線を引かない */
  | { kind: "swallow"; pointerId: number };

let gesture: Gesture = { kind: "idle" };

// ================================================================== ツールバー

const swatches = PALETTE.map((c, i) => {
  const b = document.createElement("button");
  b.className = "swatch";
  b.dataset.color = c.value;
  b.style.background = c.value;
  b.title = `${c.name} (${i + 1})`;
  b.setAttribute("aria-label", c.name);
  b.addEventListener("click", () => setColor(c.value));
  paletteEl.append(b);
  return b;
});

for (const b of toolButtons) {
  b.addEventListener("click", () => setTool(b.dataset.tool as ActiveTool));
}

sizeInput.min = String(SIZE_MIN);
sizeInput.max = String(SIZE_MAX);
sizeInput.addEventListener("input", () => setSize(Number(sizeInput.value)));
// スライダーにフォーカスが残ると矢印キーなどを奪われるので、操作が終わったら外す
sizeInput.addEventListener("change", () => sizeInput.blur());

undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);
clearBtn.addEventListener("click", clearAll);
copyBtn.addEventListener("click", () => void copyImage());
openBtn.addEventListener("click", () => void openClipboardAsPage());
captureBtn.addEventListener("click", () => void captureScreenAsPage());

// ボタンをクリックしてもフォーカスを奪わない。
// （フォーカスが残っていると、画像確定の Enter でそのボタンが再度押されてしまう）
toolbar.addEventListener("mousedown", (e) => {
  if ((e.target as Element).closest("button")) e.preventDefault();
});

function setTool(tool: ActiveTool): void {
  state.tool = tool;
  updateUi();
}

function setColor(color: string): void {
  state.color = color;
  state.tool = "pen";
  updateUi();
}

function setSize(size: number): void {
  if (!isBrush(state.tool)) return;
  state.sizes[state.tool] = Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, size)));
  updateUi();
}

function stepSize(dir: 1 | -1): void {
  if (!isBrush(state.tool)) return;
  const s = state.sizes[state.tool];
  const step = s < 10 ? 1 : s < 30 ? 2 : 5;
  setSize(s + dir * step);
}

function updateUi(): void {
  undoBtn.disabled = !board.canUndo && !floating;
  redoBtn.disabled = !board.canRedo || !!floating;
  clearBtn.disabled = board.isBlank && !floating;
  floatHint.hidden = !floating;
  floatHint.dataset.mode = floating?.selection ? "selection" : "image";
  emptyHint.classList.toggle("hidden", !board.isBlank || !!floating);
  // 画像キャンバスのときは、画像の周りを「机」の色にしてキャンバスの範囲を分かるようにする
  stage.classList.toggle("has-page", !!board.page);

  for (const b of toolButtons) b.setAttribute("aria-pressed", String(b.dataset.tool === state.tool));
  for (const s of swatches) s.setAttribute("aria-pressed", String(s.dataset.color === state.color));

  // 投げ縄とバケツは太さが関係ないのでスライダーを無効にする
  const brush = isBrush(state.tool);
  const size = isBrush(state.tool) ? state.sizes[state.tool] : state.sizes.pen;
  sizeInput.disabled = !brush;
  sizeInput.value = String(size);
  sizeValue.textContent = brush ? String(size) : "–";
  const dot = Math.max(3, Math.min(size, 24));
  sizeDot.style.width = sizeDot.style.height = `${dot}px`;
  sizeDot.style.background = state.color;
  sizeDot.classList.toggle("eraser", state.tool === "eraser");
  sizeDot.classList.toggle("lasso", !brush);

  // 表示倍率（最初の倍率のときは出さない。押すと元に戻る）
  zoomBadge.hidden = board.isHomeZoom;
  zoomBadge.textContent = `${Math.round(board.zoom * 100)}%`;

  updateCursor();
  requestOverlay();
}

function updateCursor(): void {
  if (gesture.kind === "pan") overlay.style.cursor = "grabbing";
  else if (gesture.kind !== "idle") return;
  else if (spaceHeld) overlay.style.cursor = "grab";
  else overlay.style.cursor = floating ? floating.cursorFor(hover && floating.hitTest(hover)) : "crosshair";
}

board.onChange = updateUi;

// ================================================================== キャンバスサイズ

// devicePixelContentBoxSize を使うと、125% などの表示スケールでも
// キャンバスの実ピクセルと画面のピクセルがぴったり一致してボケない。
const resizeObserver = new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  const dpr = window.devicePixelRatio || 1;
  // 値がおかしい環境（DPR をエミュレートしたブラウザ等）では CSS px × DPR にフォールバック
  const approxW = Math.round(width * dpr);
  const approxH = Math.round(height * dpr);
  const dev = entry.devicePixelContentBoxSize?.[0];
  const trusted = !!dev && Math.abs(dev.inlineSize - approxW) <= 2 && Math.abs(dev.blockSize - approxH) <= 2;
  const devW = trusted ? dev.inlineSize : approxW;
  const devH = trusted ? dev.blockSize : approxH;

  // ウィンドウの左辺や上辺をつかんでサイズを変えると、ステージの左上が画面上で動く。
  // その分だけ表示を逆にずらして、描いたものが画面上で止まって見えるようにする（右辺・下辺なら動かない）
  const sizeChanged = width !== stageSize.w || height !== stageSize.h;
  stageSize = { w: width, h: height };
  const pos = stageScreenPos();
  const shift = anchor && sizeChanged ? { x: pos.x - anchor.x, y: pos.y - anchor.y } : { x: 0, y: 0 };
  anchor = pos;
  if (sizeChanged) followResize();

  const before = board.view;
  board.resize(width, height, devW, devH, shift);
  floating?.remap(before, board.view);
  overlay.width = Math.max(1, devW);
  overlay.height = Math.max(1, devH);
  octx.setTransform(width > 0 ? devW / width : 1, 0, 0, height > 0 ? devH / height : 1, 0, 0);
  updateUi();
});

let stageSize = { w: 0, h: 0 };
/** 最後に表示の位置を合わせたときの、ステージ左上の画面上の位置（CSS px） */
let anchor: Vec | null = null;
/** この時刻までに起きたステージの移動は、サイズ変更によるものとして扱う */
let resizeUntil = 0;

function stageScreenPos(): Vec {
  const r = stage.getBoundingClientRect();
  return { x: window.screenX + r.left, y: window.screenY + r.top };
}

/**
 * ステージの画面上の位置を確かめる。サイズ変更の直後に位置が変わっていたら（ウィンドウの位置の通知が
 * サイズより遅れて届いたとき）表示をずらして合わせる。それ以外（ウィンドウを動かしただけ）は位置を覚え直すだけ。
 */
function syncAnchor(): void {
  const pos = stageScreenPos();
  if (!anchor) {
    anchor = pos;
    return;
  }
  const dx = pos.x - anchor.x;
  const dy = pos.y - anchor.y;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
  anchor = pos;
  if (performance.now() <= resizeUntil) changeView(() => board.panBy(-dx, -dy));
}

/** サイズ変更のあと少しの間、位置の変化を追いかける */
function followResize(): void {
  const running = performance.now() <= resizeUntil;
  resizeUntil = performance.now() + 200;
  if (running) return;
  const tick = () => {
    syncAnchor();
    if (performance.now() <= resizeUntil) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ウィンドウを動かしただけのときは、位置を覚え直すだけ（次のサイズ変更でずれないように）
let lastPointerSync = 0;
document.addEventListener("pointermove", () => {
  const now = performance.now();
  if (now - lastPointerSync < 200) return;
  lastPointerSync = now;
  syncAnchor();
});
window.addEventListener("focus", syncAnchor);
if (isNativeApp()) void getCurrentWindow().onMoved(() => syncAnchor());

// ================================================================== 表示の拡大・縮小・移動

/** 表示を変える。未確定の画像も画面上で一緒に動かす */
function changeView(update: () => void): void {
  const before = board.view;
  update();
  floating?.remap(before, board.view);
  updateUi();
}

/** Ctrl+= / Ctrl+- 1 回分の倍率 */
const ZOOM_STEP = 1.25;
let viewQueued = false;
let pendingZoom: { p: Vec; factor: number } | null = null;
const pendingPan = { x: 0, y: 0 };

/** ホイールなどの細かい入力は 1 フレームにまとめてから描き直す */
function queueZoom(p: Vec, factor: number): void {
  pendingZoom = pendingZoom ? { p, factor: pendingZoom.factor * factor } : { p, factor };
  scheduleView();
}

function queuePan(dx: number, dy: number): void {
  pendingPan.x += dx;
  pendingPan.y += dy;
  scheduleView();
}

function scheduleView(): void {
  if (viewQueued) return;
  viewQueued = true;
  requestAnimationFrame(() => {
    viewQueued = false;
    const zoom = pendingZoom;
    const { x, y } = pendingPan;
    pendingZoom = null;
    pendingPan.x = pendingPan.y = 0;
    changeView(() => {
      board.panBy(x, y);
      if (zoom) board.zoomAt(zoom.p, zoom.factor);
    });
  });
}

/** キーボードで拡大・縮小するときは、ステージの中央を中心にする */
function zoomStage(factor: number): void {
  const r = stage.getBoundingClientRect();
  queueZoom({ x: r.width / 2, y: r.height / 2 }, factor);
}

function resetView(): void {
  changeView(() => board.resetView());
}

zoomBadge.addEventListener("click", resetView);

function observeStage(): void {
  resizeObserver.disconnect();
  try {
    resizeObserver.observe(stage, { box: "device-pixel-content-box" });
  } catch {
    resizeObserver.observe(stage);
  }
}

/** 表示スケールの違うモニターへウィンドウを移したときも描き直す */
function watchPixelRatio(): void {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    "change",
    () => {
      observeStage(); // observe し直すと即座にコールバックが呼ばれる
      watchPixelRatio();
    },
    { once: true },
  );
}

observeStage();
watchPixelRatio();

// ================================================================== オーバーレイ描画

let overlayQueued = false;

function requestOverlay(): void {
  if (overlayQueued) return;
  overlayQueued = true;
  requestAnimationFrame(() => {
    overlayQueued = false;
    renderOverlay();
  });
}

function renderOverlay(): void {
  octx.save();
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  octx.restore();

  const now = performance.now();
  if (floating) {
    floating.draw(octx, now);
  } else if (gesture.kind === "lasso") {
    drawLassoInProgress(gesture.points, now);
  } else if (hover && isBrush(state.tool) && !spaceHeld) {
    drawBrushCursor(hover, state.sizes[state.tool]);
  }
}

/** なぞっている途中の投げ縄。始点まで自動で閉じた形を、うっすら塗りつぶして見せる */
function drawLassoInProgress(points: number[], now: number): void {
  if (points.length < 4) return;
  tracePath(octx, points);
  octx.fillStyle = "rgba(58, 123, 213, 0.14)";
  octx.fill("nonzero");
  strokeMarchingAnts(octx, now);
}

// 選択範囲の点線を動かし続ける（選択中だけ）
window.setInterval(() => {
  if (floating?.selection || gesture.kind === "lasso") requestOverlay();
}, 80);

/** ブラシの太さが分かる円カーソル（どんな背景でも見えるよう白黒の二重線） */
function drawBrushCursor(p: Vec, size: number): void {
  const r = size / 2;
  if (r < 2.5) return;
  octx.beginPath();
  octx.arc(p.x, p.y, r, 0, Math.PI * 2);
  octx.lineWidth = 2.5;
  octx.strokeStyle = "rgba(255, 255, 255, 0.7)";
  octx.stroke();
  octx.lineWidth = 1;
  octx.strokeStyle = "rgba(0, 0, 0, 0.6)";
  octx.stroke();
}

// ================================================================== ポインタ操作

function localPos(e: { clientX: number; clientY: number }, rect = overlay.getBoundingClientRect()): Vec {
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

overlay.addEventListener("pointerdown", (e) => {
  if (gesture.kind !== "idle") return;
  const p = localPos(e);

  // 中ボタン、または Space を押しながらのドラッグで表示を動かす
  if (e.button === 1 || (spaceHeld && e.button === 0)) {
    gesture = { kind: "pan", pointerId: e.pointerId, last: p };
    updateCursor();
    overlay.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  if (floating) {
    if (e.button !== 0) return;
    const handle = floating.hitTest(p);
    if (handle) {
      gesture = { kind: "transform", pointerId: e.pointerId, drag: floating.beginDrag(handle, p), last: p };
      overlay.style.cursor = floating.cursorFor(handle, true);
    } else {
      // 画像の外側をクリック → 確定。このクリックでは描画しない
      commitFloating();
      gesture = { kind: "swallow", pointerId: e.pointerId };
    }
  } else {
    // ペンタブのペン尻（消しゴム側）は button === 5 で来る
    const eraserTip = e.button === 5;
    if (e.button !== 0 && !eraserTip) return;
    if (state.tool === "lasso" && !eraserTip) {
      gesture = { kind: "lasso", pointerId: e.pointerId, points: [p.x, p.y] };
      overlay.setPointerCapture(e.pointerId);
      e.preventDefault();
      requestOverlay();
      return;
    }
    if (state.tool === "fill" && !eraserTip) {
      // バケツ: クリックした所と同じ色でつながっている範囲を塗る（ドラッグしても 1 回だけ）
      if (!board.fill(board.toDoc(p), state.color)) toast("ここは塗れません（キャンバスの外か、もう同じ色です）");
      gesture = { kind: "swallow", pointerId: e.pointerId };
      overlay.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    const tool: Tool = eraserTip || state.tool === "eraser" ? "eraser" : "pen";
    // 太さは画面上の見た目（CSS px）で指定し、キャンバスの座標に直して渡す
    const d = board.toDoc(p);
    board.beginStroke(tool, state.color, board.lengthToDoc(state.sizes[tool]), d.x, d.y);
    gesture = { kind: "draw", pointerId: e.pointerId };
    emptyHint.classList.add("hidden");
  }

  overlay.setPointerCapture(e.pointerId);
  e.preventDefault();
});

overlay.addEventListener("pointermove", (e) => {
  const rect = overlay.getBoundingClientRect();
  const p = localPos(e, rect);
  hover = e.pointerType === "touch" ? null : p;

  switch (gesture.kind) {
    case "draw": {
      if (e.pointerId !== gesture.pointerId) break;
      // 高レートなマウス/ペンの中間点も拾って線を滑らかにする
      const events = e.getCoalescedEvents?.() ?? [];
      for (const ce of events.length ? events : [e]) {
        const q = board.toDoc(localPos(ce, rect));
        board.extendStroke(q.x, q.y);
      }
      break;
    }
    case "lasso": {
      if (e.pointerId !== gesture.pointerId) break;
      const pts = gesture.points;
      const events = e.getCoalescedEvents?.() ?? [];
      for (const ce of events.length ? events : [e]) {
        const q = localPos(ce, rect);
        if (Math.hypot(q.x - pts[pts.length - 2], q.y - pts[pts.length - 1]) >= 1.5) pts.push(q.x, q.y);
      }
      break;
    }
    case "transform":
      if (e.pointerId !== gesture.pointerId || !floating) break;
      gesture.last = p;
      floating.dragTo(gesture.drag, p, { shift: e.shiftKey });
      break;
    case "pan":
      if (e.pointerId !== gesture.pointerId) break;
      queuePan(p.x - gesture.last.x, p.y - gesture.last.y);
      gesture.last = p;
      break;
    case "idle":
      if (floating) overlay.style.cursor = floating.cursorFor(floating.hitTest(p));
      break;
  }
  requestOverlay();
});

function endGesture(e: PointerEvent): void {
  if (gesture.kind === "idle" || e.pointerId !== gesture.pointerId) return;
  const ended = gesture;
  gesture = { kind: "idle" };
  if (ended.kind === "draw") board.endStroke();
  if (ended.kind === "lasso") liftSelection(ended.points);
  updateUi();
}

overlay.addEventListener("pointerup", endGesture);
overlay.addEventListener("pointercancel", endGesture);
overlay.addEventListener("lostpointercapture", endGesture);
overlay.addEventListener("pointerleave", () => {
  hover = null;
  requestOverlay();
});

// ホイール:
//   Ctrl（Mac は ⌘ も）+ ホイール → カーソルの位置を中心に拡大・縮小（タッチパッドのピンチもこれで来る）
//   未確定の画像があるとき → その画像を拡大縮小
//   それ以外 → 表示を上下に動かす（Shift で左右。タッチパッドの 2 本指スクロールは上下左右）
overlay.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (gesture.kind !== "idle" && gesture.kind !== "pan") return;
    // 行・ページ単位で来たときは px に直す
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey) {
      queueZoom(localPos(e), Math.exp(-dy * 0.002));
    } else if (floating) {
      floating.scaleBy(Math.exp(-dy * 0.0015));
      requestOverlay();
    } else if (e.shiftKey && !dx) {
      queuePan(-dy, 0);
    } else {
      queuePan(-dx, -dy);
    }
  },
  { passive: false },
);

// 中ボタンを押したときのブラウザの自動スクロール（Windows）は出さない（中ボタンのドラッグは表示の移動に使う）
overlay.addEventListener("mousedown", (e) => {
  if (e.button === 1) e.preventDefault();
});

// Mac（WebKit）のタッチパッドのピンチは wheel ではなく gesture イベントで来る
interface WebKitGestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}
let gestureScale = 1;
overlay.addEventListener("gesturestart", (e) => {
  e.preventDefault();
  gestureScale = 1;
});
overlay.addEventListener("gesturechange", (e) => {
  e.preventDefault();
  const g = e as WebKitGestureEvent;
  queueZoom(localPos(g), g.scale / gestureScale);
  gestureScale = g.scale;
});

// ================================================================== 未確定画像

async function placeImage(blob: Blob, at?: Vec): Promise<void> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await decodeImage(blob);
  } catch (err) {
    console.error(err);
    toast("画像を読み込めませんでした", true);
    return;
  }
  // 前の未確定画像があれば確定させてから、新しい画像を浮かせる
  commitFloating();
  if (gesture.kind === "draw") {
    board.endStroke();
    gesture = { kind: "idle" };
  }
  floating = FloatingImage.place(bitmap, board.docRect, board.cssPerPixel, at);
  updateUi();
}

// ================================================================== 投げ縄選択

/**
 * 投げ縄で囲んだ部分を切り取って持ち上げる。
 * 以降は貼り付け画像と同じハンドルで移動・拡縮・回転でき、Enter / 外側クリックで確定。
 */
function liftSelection(path: number[]): void {
  if (path.length < 6 || Math.abs(polygonArea(path)) < 16) return; // クリックしただけ・細すぎる線は無視
  commitFloating();
  const docPath = board.pathToDoc(path);
  const region = board.extractRegion(docPath);
  if (!region) {
    // 画像キャンバスの下地（貼り付けた元の画像）は紙なので、投げ縄では動かせない
    toast(board.page ? "囲んだ範囲に書き込みがありません（下地の画像は動かせません）" : "囲んだ範囲に何も描かれていません");
    return;
  }
  floating = FloatingImage.fromSelection(region.bitmap, board.transformToCss(region.transform), path);
  board.setPendingCut(docPath); // 元の場所は空けておく（確定するまで履歴には入らない）
  updateUi();
}

/** Ctrl+A: キャンバス全体（書き出される範囲）を選択 */
function selectAll(): void {
  const { x, y, w, h } = board.docRect;
  liftSelection([x, y, x + w, y, x + w, y + h, x, y + h]);
}

/** 符号付き面積（靴ひも公式） */
function polygonArea(p: number[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return a / 2;
}

// ================================================================== 未確定画像の確定・取消

/** 未確定画像（貼り付け画像 / 選択範囲）をキャンバスに焼き付ける（Enter / 外側クリック / コピー時） */
function commitFloating(): void {
  if (!floating) return;
  const f = floating;
  floating = null;
  if (gesture.kind === "transform") gesture = { kind: "idle" };
  if (!f.selection) {
    board.addImage(f.bitmap, board.transformToDoc(f.t));
  } else if (f.isUnmoved) {
    // 選択しただけで動かしていなければ、履歴に何も残さず元に戻す
    board.setPendingCut(null);
    f.bitmap.close();
  } else {
    board.commitSelection(board.pathToDoc(f.selection.path), f.bitmap, board.transformToDoc(f.t));
  }
  updateUi();
}

/** 未確定画像を破棄する（Esc / Ctrl+Z）。選択範囲なら元の場所に戻す */
function cancelFloating(): void {
  if (!floating) return;
  const f = floating;
  floating = null;
  if (gesture.kind === "transform") gesture = { kind: "idle" };
  if (f.selection) board.setPendingCut(null);
  f.bitmap.close();
  updateUi();
}

/** Delete / Backspace: 貼り付け画像なら取消、選択範囲なら中身を削除 */
function deleteFloating(): void {
  if (!floating?.selection) {
    cancelFloating();
    return;
  }
  const f = floating;
  floating = null;
  if (gesture.kind === "transform") gesture = { kind: "idle" };
  board.commitSelection(board.pathToDoc(f.selection!.path), null, null);
  f.bitmap.close();
  updateUi();
}

// ================================================================== 履歴・消去

function undo(): void {
  // 未確定画像があるときの Undo は「貼り付けの取り消し」
  if (floating) {
    cancelFloating();
    return;
  }
  board.undo();
}

function redo(): void {
  if (floating) return;
  board.redo();
}

function clearAll(): void {
  commitFloating(); // 確定してから消すので、Ctrl+Z で画像ごと戻せる
  board.clear();
  toast(`すべて消去しました（${MOD}+Z で戻せます）`);
}

// ================================================================== クリップボード出力

let copying = false;

async function copyImage(): Promise<void> {
  if (copying) return;
  copying = true;
  try {
    commitFloating();
    const canvas = board.exportCanvas(); // 背景のグレー込み・実ピクセル解像度
    flash();
    await copyCanvasToClipboard(canvas);
    toast("クリップボードにコピーしました");
  } catch (err) {
    console.error(err);
    toast("コピーに失敗しました", true);
  } finally {
    copying = false;
  }
}

// ================================================================== 画像の取り込み

let pasteFallbackTimer: number | undefined;

document.addEventListener("paste", (e) => {
  window.clearTimeout(pasteFallbackTimer);
  e.preventDefault();
  // clipboardData はハンドラを抜けると読めなくなるので、ここで同期的に取り出す
  void pasteImage(imageFromDataTransfer(e.clipboardData));
});

async function pasteImage(fromEvent: Blob | null): Promise<void> {
  const blob = fromEvent ?? (await readNativeClipboardImage());
  if (!blob) {
    toast("クリップボードに画像がありません");
    return;
  }
  await placeImage(blob);
}

// ドラッグ＆ドロップ（エクスプローラーからの画像ファイル）
// ※ ウィンドウ全体で既定動作を止めないと、WebView がファイルを開いて画面遷移してしまう
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

stage.addEventListener("dragover", (e) => {
  if (!hasFiles(e.dataTransfer)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = "copy";
  stage.classList.add("dragover");
});
stage.addEventListener("dragleave", (e) => {
  if (!stage.contains(e.relatedTarget as Node | null)) stage.classList.remove("dragover");
});
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  stage.classList.remove("dragover");
  const blob = imageFromDataTransfer(e.dataTransfer);
  if (blob) void placeImage(blob, localPos(e));
  else toast("画像ファイルをドロップしてください");
});

// ================================================================== クリップボードの画像をキャンバスにする

let openingPage = false;

/**
 * クリップボードの画像（スクショなど）を、そのままの大きさでキャンバスにする（ボタン / Ctrl+Shift+V）。
 * 画像は下地になり、その上に描いて Ctrl+C すると画像と同じ大きさでコピーされる。Ctrl+Z で前のキャンバスに戻せる。
 */
async function openClipboardAsPage(): Promise<void> {
  if (openingPage) return;
  openingPage = true;
  try {
    let blob: Blob | null;
    try {
      blob = await readClipboardImage();
    } catch (err) {
      console.error(err);
      toast("クリップボードを読み取れませんでした", true);
      return;
    }
    if (!blob) {
      toast("クリップボードに画像がありません");
      return;
    }
    let bitmap: ImageBitmap;
    try {
      bitmap = await decodeImage(blob);
    } catch (err) {
      console.error(err);
      toast("画像を読み込めませんでした", true);
      return;
    }

    openAsPage(bitmap, "画像");
  } finally {
    openingPage = false;
  }
}

/** 画像を下地にした新しいキャンバスにする（クリップボードから開く / 画面から取得 で共通） */
function openAsPage(bitmap: ImageBitmap, what: string): void {
  // 未確定の画像や描きかけの線は確定させてから切り替える（Ctrl+Z で全部戻せるように）
  commitFloating();
  if (gesture.kind === "draw" || gesture.kind === "lasso") gesture = { kind: "idle" };
  const hadContent = !board.isBlank;
  board.openPage(bitmap);
  toast(`${bitmap.width} × ${bitmap.height} の${what}をキャンバスにしました${hadContent ? `（${MOD}+Z で戻せます）` : ""}`);
}

// ================================================================== 画面から取得

let capturingScreen = false;

/**
 * ボタンを押した瞬間の画面を静止画にし、そこから四角形で選んだ範囲をキャンバスにする。
 * 範囲を選ぶ画面は Rust 側が別ウィンドウで出す（capture.html）。Esc でキャンセルしたら何も変えない。
 */
async function captureScreenAsPage(): Promise<void> {
  if (capturingScreen) return;
  if (!isNativeApp() || isMac) {
    toast(isMac ? "画面からの取得は今のところ Windows 版でのみ使えます" : "画面からの取得はアプリ版でのみ使えます");
    return;
  }
  capturingScreen = true;
  try {
    let bitmap: ImageBitmap | null;
    try {
      bitmap = await captureScreenRegion();
    } catch (err) {
      console.error(err);
      toast(typeof err === "string" ? err : "画面を取得できませんでした", true);
      return;
    }
    if (bitmap) openAsPage(bitmap, "範囲");
  } finally {
    capturingScreen = false;
  }
}

// ================================================================== キーボード

/** WebView の既定ショートカット（再読み込み・印刷・検索など）を殺しておく */
const BLOCKED_CTRL_KEYS = new Set(["a", "d", "f", "g", "h", "j", "k", "l", "n", "o", "p", "r", "s", "t", "u", "w", "=", "+", "-", "0"]);
if (isMac) {
  // Mac では ⌘W（ウィンドウを閉じる）と ⌘H（隠す）はメニューの標準操作なので止めない
  BLOCKED_CTRL_KEYS.delete("w");
  BLOCKED_CTRL_KEYS.delete("h");
}
const BLOCKED_KEYS = new Set(["F3", "F5", "F7", "BrowserBack", "BrowserForward", "BrowserRefresh"]);

window.addEventListener(
  "keydown",
  (e) => {
    if (e.isComposing) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    // 変形ドラッグ中に Shift を押した/離した瞬間に反映する
    if (key === "Shift" && gesture.kind === "transform" && floating) {
      floating.dragTo(gesture.drag, gesture.last, { shift: true });
      requestOverlay();
      return;
    }

    // Space を押している間は、ドラッグで表示を動かせる（押しっぱなしの繰り返しも止める）
    if (key === " " && !ctrl && !e.altKey) {
      e.preventDefault();
      if (!spaceHeld) {
        spaceHeld = true;
        updateCursor();
        requestOverlay();
      }
      return;
    }

    // --- 未確定画像の操作 ---
    if (floating && !ctrl && !e.altKey) {
      const nudge = e.shiftKey ? 10 : 1;
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-nudge, 0],
        ArrowRight: [nudge, 0],
        ArrowUp: [0, -nudge],
        ArrowDown: [0, nudge],
      };
      if (key === "Enter") {
        commitFloating();
      } else if (key === "Escape") {
        cancelFloating();
      } else if (key === "Delete" || key === "Backspace") {
        deleteFloating();
      } else if (key in arrows) {
        floating.nudge(...arrows[key]);
        requestOverlay();
      } else {
        handleToolKeys(e, key);
        return;
      }
      e.preventDefault();
      return;
    }

    // --- Ctrl 系 ---
    if (ctrl && !e.altKey) {
      if (key === "z") {
        if (e.shiftKey) redo();
        else undo();
      } else if (key === "y") {
        redo();
      } else if (key === "a") {
        if (!e.repeat) selectAll();
      } else if (key === "0") {
        resetView();
      } else if (key === "=" || key === "+" || key === ";") {
        // 拡大（JIS 配列では + が Shift+; なので ; も受け付ける）
        zoomStage(ZOOM_STEP);
      } else if (key === "-") {
        zoomStage(1 / ZOOM_STEP);
      } else if (key === "c") {
        if (!e.repeat) void copyImage();
      } else if (key === "v" && e.shiftKey) {
        // 既定動作（書式なしで貼り付け = paste イベント）は止めて、画像をキャンバスにする
        if (!e.repeat) void openClipboardAsPage();
      } else if (key === "v") {
        // paste イベントが来なかったときだけ、少し待ってからネイティブ側で読みに行く
        if (isNativeApp()) {
          window.clearTimeout(pasteFallbackTimer);
          pasteFallbackTimer = window.setTimeout(() => void pasteImage(null), 150);
        }
        return; // 既定動作（paste イベント発火）は止めない
      } else if (!BLOCKED_CTRL_KEYS.has(key)) {
        return;
      }
      e.preventDefault();
      return;
    }

    if (BLOCKED_KEYS.has(key) || (e.altKey && (key === "ArrowLeft" || key === "ArrowRight"))) {
      e.preventDefault();
      return;
    }

    if (!ctrl && !e.altKey) handleToolKeys(e, key);
  },
  { capture: true },
);

window.addEventListener("keyup", (e) => {
  if (e.key === "Shift" && gesture.kind === "transform" && floating) {
    floating.dragTo(gesture.drag, gesture.last, { shift: false });
    requestOverlay();
  }
  if (e.key === " ") {
    spaceHeld = false;
    updateCursor();
    requestOverlay();
  }
});
// ほかのウィンドウに切り替えている間に Space を離しても、押しっぱなし扱いにならないように
window.addEventListener("blur", () => {
  spaceHeld = false;
  updateCursor();
});

/** P / E / L / G / [ / ] / 1〜8 */
function handleToolKeys(e: KeyboardEvent, key: string): void {
  if (key === "p" || key === "b") setTool("pen");
  else if (key === "e") setTool("eraser");
  else if (key === "l") setTool("lasso");
  else if (key === "g") setTool("fill");
  else if (key === "[") stepSize(-1);
  else if (key === "]") stepSize(1);
  else if (/^[1-9]$/.test(key) && Number(key) <= PALETTE.length) setColor(PALETTE[Number(key) - 1].value);
  else return;
  e.preventDefault();
}

// マウスのサイドボタンで「戻る」が走らないように
window.addEventListener("mouseup", (e) => {
  if (e.button === 3 || e.button === 4) e.preventDefault();
});
// WebView の右クリックメニュー（「名前を付けて画像を保存」等）は出さない
window.addEventListener("contextmenu", (e) => e.preventDefault());

// ================================================================== トースト

let toastTimer: number | undefined;

function toast(message: string, isError = false): void {
  toastEl.textContent = message;
  toastEl.classList.toggle("error", isError);
  toastEl.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), isError ? 2800 : 1600);
}

function flash(): void {
  stage.classList.remove("flash");
  void stage.offsetWidth; // アニメーションを最初から再生させる
  stage.classList.add("flash");
}
stage.addEventListener("animationend", () => stage.classList.remove("flash"));

// ================================================================== 起動

applyPlatform();
initTitlebar($("#titlebar"));
updateUi();

// 開発時だけ、動作確認用に内部状態を覗けるようにしておく
if (import.meta.env.DEV) {
  Object.assign(window, { __soyokaze: { board, getFloating: () => floating, state } });
}
