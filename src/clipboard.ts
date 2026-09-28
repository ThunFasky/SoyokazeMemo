import { invoke, isTauri } from "@tauri-apps/api/core";

const IMAGE_FILE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i;

/** Tauri のウィンドウ内で動いているか（ブラウザで `npm run dev` を開いたときは false） */
export function isNativeApp(): boolean {
  return isTauri();
}

// ------------------------------------------------------------------ 書き出し

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG へのエンコードに失敗しました"))), "image/png");
  });
}

/**
 * キャンバスを PNG として OS のクリップボードへコピーする。
 *
 * 1. Tauri 上では Rust 側（arboard）で書き込む。
 *    WebView のフォーカスやユーザー操作の有無に左右されず確実で、
 *    Windows では "PNG" と CF_DIBV5 の両形式が登録される。
 * 2. 失敗した場合やブラウザで開発しているときは Async Clipboard API を使う。
 */
export async function copyCanvasToClipboard(canvas: HTMLCanvasElement): Promise<void> {
  // toBlob は非同期でエンコードされるので UI を止めない
  const pngPromise = canvasToPngBlob(canvas);

  if (isNativeApp()) {
    try {
      const bytes = new Uint8Array(await (await pngPromise).arrayBuffer());
      // Uint8Array を渡すと JSON を経由せず raw バイト列のまま Rust に届く
      await invoke("copy_png_to_clipboard", bytes);
      return;
    } catch (err) {
      console.warn("ネイティブのクリップボード書き込みに失敗。Web API にフォールバックします", err);
    }
  }

  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("この環境は画像のクリップボードコピーに対応していません");
  }
  // Promise<Blob> のまま ClipboardItem に渡すと、ユーザー操作の直後という扱いを保てる
  await navigator.clipboard.write([new ClipboardItem({ "image/png": pngPromise })]);
}

// ------------------------------------------------------------------ 取り込み

/**
 * paste / drop イベントの DataTransfer から画像を 1 つ取り出す。
 * - スクリーンショットやブラウザの「画像をコピー」→ image/* の File
 * - エクスプローラーでコピー/ドラッグした画像ファイル → File（拡張子で判定）
 *
 * DataTransfer はイベントハンドラを抜けると読めなくなるので、必ず同期的に呼ぶこと。
 */
export function imageFromDataTransfer(dt: DataTransfer | null): Blob | null {
  if (!dt) return null;
  for (const item of Array.from(dt.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  for (const file of Array.from(dt.files)) {
    if (file.type.startsWith("image/") || IMAGE_FILE_EXT.test(file.name)) return file;
  }
  return null;
}

export function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes("Files");
}

/**
 * WebView の paste イベントで画像が取れなかったときの保険。
 * Rust 側で CF_HDROP（コピーしたファイル）→ ビットマップの順に探す。
 */
export async function readNativeClipboardImage(): Promise<Blob | null> {
  if (!isNativeApp()) return null;
  try {
    const buf = await invoke<ArrayBuffer>("read_clipboard_image");
    return buf && buf.byteLength > 0 ? new Blob([buf]) : null;
  } catch (err) {
    console.warn("ネイティブのクリップボード読み取りに失敗", err);
    return null;
  }
}

/** Blob を描画可能な ImageBitmap にする（SVG など createImageBitmap が直接読めない形式は <img> 経由） */
export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const w = img.naturalWidth || 512;
      const h = img.naturalHeight || 512;
      return await createImageBitmap(img, { resizeWidth: w, resizeHeight: h });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
