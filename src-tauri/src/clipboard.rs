//! OS クリップボードとのやり取り。
//!
//! - 書き込み: フロントで作った PNG を受け取り、arboard 経由で書き込む。
//!   Windows では "PNG" 形式と CF_DIBV5 の両方が登録されるので、
//!   Discord / Slack / LINE / Office / ペイント など大抵のアプリに貼り付けられる。
//! - 読み取り: WebView の paste イベントで画像が取れなかったときの保険。
//!   エクスプローラーでコピーした画像ファイル（CF_HDROP）→ ビットマップの順に探す。

use std::borrow::Cow;
use std::io::Cursor;
use std::path::Path;

use arboard::{Clipboard, ImageData};
use image::{ImageFormat, RgbaImage};
use tauri::ipc::{InvokeBody, Request, Response};

/// 読み込みを許可する画像ファイルの最大サイズ（誤って巨大ファイルを掴んだとき用）
const MAX_IMAGE_FILE_BYTES: u64 = 64 * 1024 * 1024;

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico"];

/// PNG のバイト列（raw body）を受け取り、画像としてクリップボードへ書き込む。
///
/// JS 側: `invoke("copy_png_to_clipboard", pngBytes /* Uint8Array */)`
#[tauri::command]
pub async fn copy_png_to_clipboard(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(png) = request.body() else {
        return Err("PNG のバイト列を Uint8Array で渡してください".into());
    };

    let rgba = image::load_from_memory_with_format(png, ImageFormat::Png)
        .map_err(|e| format!("PNG のデコードに失敗しました: {e}"))?
        .into_rgba8();
    let (width, height) = rgba.dimensions();

    let data = ImageData {
        width: width as usize,
        height: height as usize,
        bytes: Cow::Owned(rgba.into_raw()),
    };

    Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_image(data))
        .map_err(|e| format!("クリップボードへの書き込みに失敗しました: {e}"))
}

/// クリップボードから画像を探して、エンコード済みのバイト列（PNG/JPEG 等）で返す。
/// 見つからなければ空のバイト列を返す。
///
/// JS 側: `const buf = await invoke<ArrayBuffer>("read_clipboard_image")`
#[tauri::command]
pub async fn read_clipboard_image() -> Result<Response, String> {
    let mut clipboard =
        Clipboard::new().map_err(|e| format!("クリップボードを開けませんでした: {e}"))?;

    // 1) エクスプローラーでコピーされた画像ファイル
    if let Ok(paths) = clipboard.get().file_list() {
        for path in paths.iter().filter(|p| is_image_path(p)) {
            let small_enough = std::fs::metadata(path)
                .map(|m| m.is_file() && m.len() <= MAX_IMAGE_FILE_BYTES)
                .unwrap_or(false);
            if small_enough {
                if let Ok(bytes) = std::fs::read(path) {
                    return Ok(Response::new(bytes));
                }
            }
        }
    }

    // 2) スクリーンショットなどのビットマップ
    if let Ok(img) = clipboard.get_image() {
        let rgba = RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned())
            .ok_or("クリップボードの画像サイズが不正です")?;
        let mut png = Vec::new();
        rgba.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .map_err(|e| format!("PNG へのエンコードに失敗しました: {e}"))?;
        return Ok(Response::new(png));
    }

    Ok(Response::new(Vec::<u8>::new()))
}

fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| IMAGE_EXTENSIONS.iter().any(|e| ext.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}
