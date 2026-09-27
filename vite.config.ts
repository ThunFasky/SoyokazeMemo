import { defineConfig } from "vite";

// Tauri CLI から起動されたときに渡される開発用ホスト（モバイル向け）。デスクトップでは未設定。
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Tauri 側のエラー表示を Vite が消さないように
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Rust 側の変更で Vite がリロードしないように
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Windows の WebView2 は Chromium ベースなので新しめの構文で出力して OK
    target: "chrome110",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
