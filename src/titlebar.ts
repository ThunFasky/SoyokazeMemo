import { getCurrentWindow } from "@tauri-apps/api/window";
import { isNativeApp } from "./clipboard";

/**
 * 自前のタイトルバー（tauri.conf.json で decorations: false にしている）。
 * ドラッグでの移動とダブルクリックでの最大化は data-tauri-drag-region に任せ、
 * ここでは右端の 最小化 / 最大化 / 閉じる ボタンと、非アクティブ時の表示だけを扱う。
 * ブラウザで開いたとき（npm run dev）はウィンドウを操作できないのでボタンを出さない。
 */
export function initTitlebar(titlebar: HTMLElement): void {
  // ボタンを押してもフォーカスを奪わない（ツールバーと同じく、Enter で再度押されるのを防ぐ）
  titlebar.addEventListener("mousedown", (e) => {
    if ((e.target as Element).closest("button")) e.preventDefault();
  });

  if (!isNativeApp()) return;

  const win = getCurrentWindow();
  const button = (name: string) => titlebar.querySelector<HTMLButtonElement>(`[data-window="${name}"]`)!;
  const maximizeBtn = button("maximize");

  titlebar.querySelector<HTMLElement>("#window-controls")!.hidden = false;
  button("minimize").addEventListener("click", () => void win.minimize());
  maximizeBtn.addEventListener("click", () => void win.toggleMaximize());
  button("close").addEventListener("click", () => void win.close());

  // 最大化中は「元に戻す」のアイコンに切り替える（ダブルクリックや Win+↑ で最大化した場合も）
  const syncMaximized = async () => {
    const maximized = await win.isMaximized();
    const label = maximized ? "元に戻す（縮小）" : "最大化";
    maximizeBtn.dataset.maximized = String(maximized);
    maximizeBtn.title = label;
    maximizeBtn.setAttribute("aria-label", label);
  };
  void syncMaximized();
  void win.onResized(() => void syncMaximized());

  // OS のタイトルバーと同じく、ほかのウィンドウを操作している間は薄く表示する
  void win.onFocusChanged(({ payload: focused }) => titlebar.classList.toggle("inactive", !focused));
}
