// リリースビルドでは Windows でコンソールウィンドウを出さない
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clipboard;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            clipboard::copy_png_to_clipboard,
            clipboard::read_clipboard_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SoyokazeMemo");
}
