import { isTauri } from "@tauri-apps/api/core";

/**
 * OS ごとの違い（Windows / macOS）。
 * Mac の WebView（WKWebView）の UA には "Macintosh" が入るので、それで見分ける。
 */
export const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);

/** ショートカットの修飾キーの表記（Mac は ⌘、ほかは Ctrl）。キー操作は Ctrl / ⌘ のどちらでも受け付けている */
export const MOD = isMac ? "⌘" : "Ctrl";

/**
 * <html data-platform="mac|windows" data-native="true|false"> を付けて、CSS で OS ごとの見た目を切り替えられるようにする
 * （data-native はアプリ版かどうか。ブラウザで開いたときはタイトルバーに OS のボタンが重ならない）。
 * Mac では、HTML に書いてあるショートカットの「Ctrl」を「⌘」に書き換える（ツールチップと <kbd>）。
 */
export function applyPlatform(root: HTMLElement = document.documentElement): void {
  root.dataset.platform = isMac ? "mac" : "windows";
  root.dataset.native = String(isTauri());
  if (!isMac) return;
  for (const el of root.querySelectorAll<HTMLElement>("[title]")) {
    el.title = el.title.replace(/Ctrl/g, MOD);
  }
  for (const kbd of root.querySelectorAll("kbd")) {
    if (kbd.textContent === "Ctrl") kbd.textContent = MOD;
  }
}
