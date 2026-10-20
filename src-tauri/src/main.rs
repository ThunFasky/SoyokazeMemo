// リリースビルドでは Windows でコンソールウィンドウを出さない
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clipboard;
mod screen_capture;

fn main() {
    tauri::Builder::default()
        .manage(screen_capture::CaptureState::default())
        .invoke_handler(tauri::generate_handler![
            clipboard::copy_png_to_clipboard,
            clipboard::read_clipboard_image,
            screen_capture::capture_screen_region,
            screen_capture::get_screen_capture,
            screen_capture::show_capture_overlay,
            screen_capture::finish_screen_capture,
            screen_capture::cancel_screen_capture,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SoyokazeMemo");
}
