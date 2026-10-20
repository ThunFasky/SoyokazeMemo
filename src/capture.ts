/**
 * 「画面から取得」の範囲選択画面（capture.html）。
 *
 * Rust 側（screen_capture.rs）が全モニターを覆う枠なしウィンドウでこのページを開く。
 * ボタンを押した瞬間に撮った静止画を暗くして全面に敷き、ドラッグした四角形の部分だけ元の明るさで見せる。
 * 離したら範囲を Rust 側に返し（その範囲がキャンバスになる）、Esc / 右クリックならキャンセル。
 *
 * ブラウザで開いたとき（npm run dev で /capture.html）は、動作確認用のダミー画面を使う。
 */
import "./capture.css";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { rgbaToBitmap } from "./screen";

interface Vec {
  x: number;
  y: number;
}

/** 静止画のピクセル単位の矩形 */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`${selector} が見つかりません`);
  return el;
}

const shotCanvas = $<HTMLCanvasElement>("#shot");
const selCanvas = $<HTMLCanvasElement>("#selection");
const hint = $("#hint");
const shotCtx = shotCanvas.getContext("2d")!;
const selCtx = selCanvas.getContext("2d")!;

/** 選んでいない部分を暗くする色 */
const DIM = "rgba(0, 0, 0, 0.45)";
const FRAME_COLOR = "#3a7bd5";
/** これより小さい範囲（ただのクリック）は選択しなかったことにする（静止画のピクセル） */
const MIN_SIZE = 3;

let image: ImageBitmap | null = null;
let drag: { pointerId: number; start: Vec; current: Vec; square: boolean } | null = null;
/** 確定 / キャンセル済み（以降の操作は受け付けない） */
let finished = false;

// ================================================================== 読み込み

async function init(): Promise<void> {
  const { bitmap, focus } = isTauri() ? await loadScreenshot() : await demoScreenshot();
  image = bitmap;
  for (const c of [shotCanvas, selCanvas]) {
    c.width = bitmap.width;
    c.height = bitmap.height;
  }
  shotCtx.drawImage(bitmap, 0, 0);
  shotCtx.fillStyle = DIM;
  shotCtx.fillRect(0, 0, bitmap.width, bitmap.height);
  placeHint(focus);

  // 描き終わってから表示する（白い画面が一瞬見えないように）
  if (isTauri()) await invoke("show_capture_overlay");
  window.focus();
  document.body.dataset.ready = "true";
}

/** Rust 側から静止画を受け取る: [width][height][案内の x][y][width][height]（u32 LE）[RGBA...] */
async function loadScreenshot(): Promise<{ bitmap: ImageBitmap; focus: Rect }> {
  const buf = await invoke<ArrayBuffer>("get_screen_capture");
  const v = new DataView(buf);
  const u = (i: number) => v.getUint32(i * 4, true);
  return {
    bitmap: await rgbaToBitmap(buf, 24, u(0), u(1)),
    focus: { x: u(2), y: u(3), w: u(4), h: u(5) },
  };
}

/** ブラウザで開いたとき用のダミー画面 */
async function demoScreenshot(): Promise<{ bitmap: ImageBitmap; focus: Rect }> {
  const w = 1920;
  const h = 1080;
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, "#4c6f96");
  grad.addColorStop(1, "#6e9a6e");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#f6f3ec";
  g.fillRect(200, 150, 900, 600);
  g.fillStyle = "#b5524c";
  g.fillRect(1300, 300, 400, 400);
  g.fillStyle = "#34373b";
  g.font = "bold 64px sans-serif";
  g.fillText("デモ画面（ブラウザ）", 260, 300);
  return { bitmap: c.transferToImageBitmap(), focus: { x: 0, y: 0, w, h } };
}

/** 案内は、ボタンを押したときにアプリがあったモニターの上端中央に出す */
function placeHint(focus: Rect): void {
  const k = cssPerImagePixel();
  hint.style.left = `${(focus.x + focus.w / 2) * k}px`;
  hint.style.top = `${focus.y * k + 16}px`;
}

// ================================================================== 範囲選択

/** 画面の 1 CSS px が静止画の何ピクセルか（ウィンドウは静止画と同じ大きさなので通常は devicePixelRatio） */
function imagePixelPerCss(): number {
  const r = selCanvas.getBoundingClientRect();
  return r.width > 0 ? selCanvas.width / r.width : 1;
}

function cssPerImagePixel(): number {
  return 1 / imagePixelPerCss();
}

function toImage(e: { clientX: number; clientY: number }): Vec {
  const r = selCanvas.getBoundingClientRect();
  const kx = r.width > 0 ? selCanvas.width / r.width : 1;
  const ky = r.height > 0 ? selCanvas.height / r.height : 1;
  return {
    x: clamp((e.clientX - r.left) * kx, 0, selCanvas.width),
    y: clamp((e.clientY - r.top) * ky, 0, selCanvas.height),
  };
}

/** ドラッグの始点と今の位置から、選んでいる四角形を求める（図形ツールと同じく、どの向きにドラッグしてもよい） */
function selectionRect(): Rect | null {
  if (!drag) return null;
  const { start, current, square } = drag;
  let dx = current.x - start.x;
  let dy = current.y - start.y;
  if (square) {
    // Shift: 正方形。画面の端で切れないよう、ドラッグしている向きに使える幅に収める
    const sx = dx < 0 ? -1 : 1;
    const sy = dy < 0 ? -1 : 1;
    const roomX = sx > 0 ? selCanvas.width - start.x : start.x;
    const roomY = sy > 0 ? selCanvas.height - start.y : start.y;
    const side = Math.min(Math.max(Math.abs(dx), Math.abs(dy)), roomX, roomY);
    dx = sx * side;
    dy = sy * side;
  }
  const left = Math.round(Math.min(start.x, start.x + dx));
  const top = Math.round(Math.min(start.y, start.y + dy));
  const right = Math.round(Math.max(start.x, start.x + dx));
  const bottom = Math.round(Math.max(start.y, start.y + dy));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

let renderQueued = false;

function requestRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render(): void {
  selCtx.clearRect(0, 0, selCanvas.width, selCanvas.height);
  const r = selectionRect();
  if (!image || !r || r.w < 1 || r.h < 1) return;

  // 選んでいる部分だけ元の明るさで見せる
  selCtx.drawImage(image, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);

  // 枠は選んだ範囲の外側に描く（撮る中身に枠がかぶらないように）
  const k = imagePixelPerCss();
  const frame = (width: number, color: string) => {
    selCtx.lineWidth = width;
    selCtx.strokeStyle = color;
    selCtx.strokeRect(r.x - width / 2, r.y - width / 2, r.w + width, r.h + width);
  };
  frame(3 * k, "rgba(255, 255, 255, 0.9)");
  frame(1.5 * k, FRAME_COLOR);

  drawSizeLabel(r, k);
}

/** 選んでいる大きさ（＝キャンバスになる大きさ）を枠の下に出す */
function drawSizeLabel(r: Rect, k: number): void {
  const text = `${r.w} × ${r.h}`;
  selCtx.font = `600 ${12 * k}px "Segoe UI", "Yu Gothic UI", sans-serif`;
  const padX = 7 * k;
  const boxW = selCtx.measureText(text).width + padX * 2;
  const boxH = 22 * k;
  const gap = 6 * k;
  let x = clamp(r.x, 0, selCanvas.width - boxW);
  let y = r.y + r.h + gap;
  if (y + boxH > selCanvas.height) y = r.y - gap - boxH; // 下に入らなければ上
  if (y < 0) y = r.y + gap; // 上にも入らなければ内側
  x = Math.max(0, x);

  selCtx.fillStyle = "rgba(20, 21, 24, 0.88)";
  selCtx.beginPath();
  selCtx.roundRect(x, y, boxW, boxH, 6 * k);
  selCtx.fill();
  selCtx.fillStyle = "#f3f3f0";
  selCtx.textBaseline = "middle";
  selCtx.fillText(text, x + padX, y + boxH / 2);
}

// ================================================================== 入力

selCanvas.addEventListener("pointerdown", (e) => {
  if (finished || !image) return;
  if (e.button === 2) {
    cancel();
    return;
  }
  if (e.button !== 0 || drag) return;
  const p = toImage(e);
  drag = { pointerId: e.pointerId, start: p, current: p, square: e.shiftKey };
  selCanvas.setPointerCapture(e.pointerId);
  hint.classList.add("hidden");
  requestRender();
});

selCanvas.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.current = toImage(e);
  drag.square = e.shiftKey;
  requestRender();
});

selCanvas.addEventListener("pointerup", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.current = toImage(e);
  const r = selectionRect();
  if (r && r.w >= MIN_SIZE && r.h >= MIN_SIZE) {
    render();
    finish(r);
    return;
  }
  // クリックしただけなら何もしない（選び直せる）
  drag = null;
  hint.classList.remove("hidden");
  requestRender();
});

selCanvas.addEventListener("pointercancel", () => {
  drag = null;
  hint.classList.remove("hidden");
  requestRender();
});

window.addEventListener("keydown", (e) => {
  // この画面では再読み込み（F5）などのブラウザの既定動作は全部止める
  e.preventDefault();
  if (finished) return;
  if (e.key === "Escape") {
    cancel();
  } else if (e.key === "Shift" && drag) {
    drag.square = true;
    requestRender();
  }
});

window.addEventListener("keyup", (e) => {
  if (e.key === "Shift" && drag) {
    drag.square = false;
    requestRender();
  }
});

window.addEventListener("contextmenu", (e) => e.preventDefault());

// ================================================================== 結果

function finish(r: Rect): void {
  finished = true;
  if (isTauri()) {
    void invoke("finish_screen_capture", { x: r.x, y: r.y, width: r.w, height: r.h });
  } else {
    Object.assign(window, { __captureResult: r });
  }
}

function cancel(): void {
  finished = true;
  drag = null;
  if (isTauri()) {
    void invoke("cancel_screen_capture");
  } else {
    Object.assign(window, { __captureResult: null });
    render();
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

init().catch((err) => {
  console.error(err);
  // 静止画を受け取れなかったら、メインウィンドウが隠れたままにならないようキャンセルする
  cancel();
});
