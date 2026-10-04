import "./styles.css";
import { Board, tracePath, type Tool } from "./board";
import {
  copyCanvasToClipboard,
  decodeImage,
  hasFiles,
  imageFromDataTransfer,
  isNativeApp,
  readNativeClipboardImage,
} from "./clipboard";
import { FloatingImage, strokeMarchingAnts, type DragStart, type Vec } from "./floating";
import { PALETTE, SIZE_MAX, SIZE_MIN } from "./palette";

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
const emptyHint = $("#empty-hint");
const floatHint = $("#float-hint");
const toastEl = $("#toast");
const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tool]"));

// ================================================================== 状態

const board = new Board($<HTMLCanvasElement>("#ink"));

/** ツールバーで選べるツール。lasso は投げ縄選択 */
type ActiveTool = Tool | "lasso";

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
/** CSS px → 実ピクセルの倍率（Windows の表示スケール 125% なら 1.25） */
let pixelRatio = window.devicePixelRatio || 1;

type Gesture =
  | { kind: "idle" }
  | { kind: "draw"; pointerId: number }
  | { kind: "transform"; pointerId: number; drag: DragStart; last: Vec }
  /** 投げ縄で範囲をなぞっている途中 */
  | { kind: "lasso"; pointerId: number; points: number[] }
  /** 未確定画像の外側クリック（＝確定）。そのクリックでは線を引かない */
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
  if (state.tool === "lasso") return;
  state.sizes[state.tool] = Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, size)));
  updateUi();
}

function stepSize(dir: 1 | -1): void {
  if (state.tool === "lasso") return;
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

  for (const b of toolButtons) b.setAttribute("aria-pressed", String(b.dataset.tool === state.tool));
  for (const s of swatches) s.setAttribute("aria-pressed", String(s.dataset.color === state.color));

  // 投げ縄のときは太さが関係ないのでスライダーを無効にする
  const lasso = state.tool === "lasso";
  const size = lasso ? state.sizes.pen : state.sizes[state.tool as Tool];
  sizeInput.disabled = lasso;
  sizeInput.value = String(size);
  sizeValue.textContent = lasso ? "–" : String(size);
  const dot = Math.max(3, Math.min(size, 24));
  sizeDot.style.width = sizeDot.style.height = `${dot}px`;
  sizeDot.style.background = state.color;
  sizeDot.classList.toggle("eraser", state.tool === "eraser");
  sizeDot.classList.toggle("lasso", lasso);

  if (gesture.kind === "idle") {
    overlay.style.cursor = floating ? floating.cursorFor(hover && floating.hitTest(hover)) : "crosshair";
  }
  requestOverlay();
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

  board.resize(width, height, devW, devH);
  overlay.width = Math.max(1, devW);
  overlay.height = Math.max(1, devH);
  pixelRatio = width > 0 ? devW / width : dpr;
  octx.setTransform(width > 0 ? devW / width : 1, 0, 0, height > 0 ? devH / height : 1, 0, 0);
  requestOverlay();
});

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
  } else if (hover && state.tool !== "lasso") {
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
    const tool: Tool = eraserTip || state.tool === "eraser" ? "eraser" : "pen";
    board.beginStroke(tool, state.color, state.sizes[tool], p.x, p.y);
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
        const q = localPos(ce, rect);
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

// ホイールで未確定画像を拡大縮小
overlay.addEventListener(
  "wheel",
  (e) => {
    if (!floating || gesture.kind === "transform") return;
    e.preventDefault();
    floating.scaleBy(Math.exp(-e.deltaY * 0.0015));
    requestOverlay();
  },
  { passive: false },
);

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
  floating = FloatingImage.place(bitmap, board.width, board.height, pixelRatio, at);
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
  const region = board.extractRegion(path);
  if (!region) {
    toast("囲んだ範囲に何も描かれていません");
    return;
  }
  floating = FloatingImage.fromSelection(region.bitmap, region.transform, path);
  board.setPendingCut(path); // 元の場所は空けておく（確定するまで履歴には入らない）
  updateUi();
}

/** Ctrl+A: キャンバス全体を選択 */
function selectAll(): void {
  const w = board.width;
  const h = board.height;
  liftSelection([0, 0, w, 0, w, h, 0, h]);
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
    board.addImage(f.bitmap, f.t);
  } else if (f.isUnmoved) {
    // 選択しただけで動かしていなければ、履歴に何も残さず元に戻す
    board.setPendingCut(null);
    f.bitmap.close();
  } else {
    board.commitSelection(f.selection.path, f.bitmap, f.t);
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
  board.commitSelection(f.selection!.path, null, null);
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
  toast("すべて消去しました（Ctrl+Z で戻せます）");
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

// ================================================================== キーボード

/** WebView の既定ショートカット（再読み込み・印刷・検索など）を殺しておく */
const BLOCKED_CTRL_KEYS = new Set(["a", "d", "f", "g", "h", "j", "k", "l", "n", "o", "p", "r", "s", "t", "u", "w", "=", "+", "-", "0"]);
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
      } else if (key === "c") {
        if (!e.repeat) void copyImage();
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
});

/** P / E / L / [ / ] / 1〜8 */
function handleToolKeys(e: KeyboardEvent, key: string): void {
  if (key === "p" || key === "b") setTool("pen");
  else if (key === "e") setTool("eraser");
  else if (key === "l") setTool("lasso");
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

updateUi();

// 開発時だけ、動作確認用に内部状態を覗けるようにしておく
if (import.meta.env.DEV) {
  Object.assign(window, { __soyokaze: { board, getFloating: () => floating, state } });
}
