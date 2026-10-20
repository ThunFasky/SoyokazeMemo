import { invoke } from "@tauri-apps/api/core";

/** 「画面から取得」で Rust 側とやり取りする、ヘッダー付きの生の RGBA 画像を ImageBitmap にする */
export function rgbaToBitmap(buf: ArrayBuffer, offset: number, width: number, height: number): Promise<ImageBitmap> {
  const pixels = new Uint8ClampedArray(buf, offset, width * height * 4);
  return createImageBitmap(new ImageData(pixels, width, height));
}

/**
 * 画面を撮って、ユーザーが四角形で選んだ範囲を返す（キャンセルされたら null）。
 * 撮るのは呼んだ直後の 1 回だけで、範囲はその静止画から選ぶ。アプリ版（Tauri）専用。
 */
export async function captureScreenRegion(): Promise<ImageBitmap | null> {
  const buf = await invoke<ArrayBuffer>("capture_screen_region");
  if (!buf || buf.byteLength < 8) return null;
  const view = new DataView(buf);
  return rgbaToBitmap(buf, 8, view.getUint32(0, true), view.getUint32(4, true));
}
