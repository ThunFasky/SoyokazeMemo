//! 画面の一部を撮ってキャンバスにする（「画面から取得」ボタン）。
//!
//! 1. メイン画面から `capture_screen_region` を呼ぶ。
//!    自分のウィンドウを隠す → 全モニターをまとめた画面全体を静止画として 1 回だけ撮る →
//!    その静止画を全面に敷いた枠なしウィンドウ（capture.html）を開いて、範囲が選ばれるのを待つ。
//! 2. capture.html は `get_screen_capture` で静止画を受け取って描き、描き終わったら `show_capture_overlay`。
//! 3. 範囲を選んだら `finish_screen_capture`、Esc なら `cancel_screen_capture`。
//! 4. `capture_screen_region` が切り抜いた画像を返す（キャンセルなら空）。メインウィンドウは元に戻す。
//!
//! 撮るのはボタンを押した直後の 1 回だけなので、範囲を選んでいる間に画面が動いても、
//! 選ぶのは押した瞬間の静止画になる。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tauri::ipc::Response;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tokio::sync::oneshot;

const OVERLAY_LABEL: &str = "capture";
/// 自分のウィンドウを隠してから撮るまでの待ち時間（隠したのが画面に反映されるのを待つ）
const HIDE_DELAY: Duration = Duration::from_millis(220);
/// 範囲選択の画面がこの時間内に表示されなければ諦める（メインウィンドウが隠れたままにならないように）
const OVERLAY_READY_TIMEOUT: Duration = Duration::from_secs(8);

/// 撮った画面（全モニターを含む仮想スクリーン全体）
pub struct Screenshot {
    /// 仮想スクリーンの左上（物理ピクセル。メインモニターより左や上にモニターがあると負になる）
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// RGBA（上の行から）
    pub rgba: Vec<u8>,
}

/// 静止画の中の矩形（静止画の左上からの物理ピクセル）
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

enum Outcome {
    Selected(Region),
    Cancelled,
    Failed(String),
}

struct Session {
    id: u64,
    shot: Option<Arc<Screenshot>>,
    /// 案内を出す場所（メインウィンドウがあったモニター）
    focus: Region,
    ready: bool,
    done: Option<oneshot::Sender<Outcome>>,
}

/// 進行中の「画面から取得」（同時に 1 つだけ）
#[derive(Default)]
pub struct CaptureState {
    session: Mutex<Option<Session>>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

impl CaptureState {
    fn lock(&self) -> MutexGuard<'_, Option<Session>> {
        self.session.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 範囲選択の結果を待っている側に渡す（2 回目以降は無視される）
    fn resolve(&self, outcome: Outcome) {
        if let Some(tx) = self.lock().as_mut().and_then(|s| s.done.take()) {
            let _ = tx.send(outcome);
        }
    }
}

// ------------------------------------------------------------------ コマンド

/// 画面を撮って範囲を選んでもらい、切り抜いた画像を返す。
/// 戻り値: [width u32 LE][height u32 LE][RGBA...]。キャンセルされたら空。
#[tauri::command]
pub async fn capture_screen_region(
    app: AppHandle,
    state: State<'_, CaptureState>,
) -> Result<Response, String> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    {
        let mut slot = state.lock();
        if slot.is_some() {
            return Err("すでに画面の取得中です".into());
        }
        *slot = Some(Session { id, shot: None, focus: Region::default(), ready: false, done: Some(tx) });
    }

    let main = app.get_webview_window("main");
    let result = select_region(&app, &state, main.as_ref(), id, rx).await;

    // 後片付け: 範囲選択の画面を閉じて、メインウィンドウを元に戻す
    state.lock().take();
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.destroy();
    }
    if let Some(main) = main {
        restore_main_window(main);
    }
    result
}

/// 範囲選択の画面（capture.html）用: 撮った静止画を渡す。
/// 戻り値: [width][height][案内を出す x][y][width][height]（すべて u32 LE）[RGBA...]
#[tauri::command]
pub async fn get_screen_capture(state: State<'_, CaptureState>) -> Result<Response, String> {
    let (shot, focus) = {
        let slot = state.lock();
        let session = slot.as_ref().ok_or("画面の取得中ではありません")?;
        (session.shot.clone().ok_or("画面をまだ撮っていません")?, session.focus)
    };
    let header = [shot.width, shot.height, focus.x, focus.y, focus.width, focus.height];
    let mut out = Vec::with_capacity(header.len() * 4 + shot.rgba.len());
    for v in header {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&shot.rgba);
    Ok(Response::new(out))
}

/// 範囲選択の画面用: 静止画を描き終えたので、画面全体を覆って表示する
#[tauri::command]
pub async fn show_capture_overlay(
    window: WebviewWindow,
    state: State<'_, CaptureState>,
) -> Result<(), String> {
    let shot = {
        let mut slot = state.lock();
        let session = slot.as_mut().ok_or("画面の取得中ではありません")?;
        session.ready = true;
        session.shot.clone()
    };
    platform::set_transitions(&window, false);
    if let Some(shot) = &shot {
        place_overlay(&window, shot);
    }
    window.show().map_err(|e| format!("範囲選択の画面を表示できませんでした: {e}"))?;
    // DPI の違うモニターをまたぐと表示した時点で大きさが変わることがあるので、もう一度合わせる
    if let Some(shot) = &shot {
        place_overlay(&window, shot);
    }
    let _ = window.set_focus();
    Ok(())
}

/// 範囲選択の画面用: 範囲が決まった（静止画のピクセル座標）
#[tauri::command]
pub fn finish_screen_capture(x: u32, y: u32, width: u32, height: u32, state: State<'_, CaptureState>) {
    let outcome = if width > 0 && height > 0 {
        Outcome::Selected(Region { x, y, width, height })
    } else {
        Outcome::Cancelled
    };
    state.resolve(outcome);
}

/// 範囲選択の画面用: Esc でキャンセル
#[tauri::command]
pub fn cancel_screen_capture(state: State<'_, CaptureState>) {
    state.resolve(Outcome::Cancelled);
}

// ------------------------------------------------------------------ 内部処理

async fn select_region(
    app: &AppHandle,
    state: &CaptureState,
    main: Option<&WebviewWindow>,
    id: u64,
    rx: oneshot::Receiver<Outcome>,
) -> Result<Response, String> {
    // 案内は、ボタンを押したときにメインウィンドウがあったモニターに出す
    let monitor = main.and_then(|w| w.current_monitor().ok().flatten());

    // 自分のウィンドウが写り込まないように隠してから撮る（アニメーションも止めて、すぐ消えるようにする）
    if let Some(main) = main {
        platform::set_transitions(main, false);
        main.hide().map_err(|e| format!("ウィンドウを隠せませんでした: {e}"))?;
    }
    tokio::time::sleep(HIDE_DELAY).await;

    let shot = tauri::async_runtime::spawn_blocking(platform::capture_virtual_screen)
        .await
        .map_err(|e| format!("画面を取得できませんでした: {e}"))??;
    let shot = Arc::new(shot);
    let focus = monitor
        .map(|m| monitor_region(&shot, *m.position(), *m.size()))
        .unwrap_or(Region { x: 0, y: 0, width: shot.width, height: shot.height });
    if let Some(session) = state.lock().as_mut() {
        session.shot = Some(shot.clone());
        session.focus = focus;
    }

    open_overlay(app, &shot)?;
    spawn_ready_watchdog(app.clone(), id);

    match rx.await.unwrap_or(Outcome::Cancelled) {
        Outcome::Cancelled => Ok(Response::new(Vec::<u8>::new())),
        Outcome::Failed(message) => Err(message),
        Outcome::Selected(region) => {
            let (w, h, rgba) = crop_rgba(&shot.rgba, shot.width, shot.height, region)
                .ok_or("選んだ範囲が画面の外です")?;
            let mut out = Vec::with_capacity(8 + rgba.len());
            out.extend_from_slice(&w.to_le_bytes());
            out.extend_from_slice(&h.to_le_bytes());
            out.extend_from_slice(&rgba);
            Ok(Response::new(out))
        }
    }
}

/// 撮った静止画を全面に敷く枠なしウィンドウを、全モニターを覆う位置に作る（表示は capture.html の準備ができてから）
fn open_overlay(app: &AppHandle, shot: &Screenshot) -> Result<(), String> {
    let overlay = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("capture.html".into()))
        .title("SoyokazeMemo - 画面から取得")
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(true)
        .build()
        .map_err(|e| format!("範囲選択の画面を開けませんでした: {e}"))?;
    place_overlay(&overlay, shot);

    // Alt+F4 などで閉じられたらキャンセル扱い
    let handle = app.clone();
    overlay.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            handle.state::<CaptureState>().resolve(Outcome::Cancelled);
        }
    });
    Ok(())
}

fn place_overlay(window: &WebviewWindow, shot: &Screenshot) {
    let _ = window.set_position(PhysicalPosition::new(shot.x, shot.y));
    let _ = window.set_size(PhysicalSize::new(shot.width, shot.height));
}

/// 範囲選択の画面がいつまでも出てこなければ諦めて、メインウィンドウを戻す
fn spawn_ready_watchdog(app: AppHandle, id: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(OVERLAY_READY_TIMEOUT).await;
        let state = app.state::<CaptureState>();
        let stalled = state.lock().as_ref().is_some_and(|s| s.id == id && !s.ready);
        if stalled {
            state.resolve(Outcome::Failed("範囲選択の画面を表示できませんでした".into()));
        }
    });
}

fn restore_main_window(main: WebviewWindow) {
    let _ = main.show();
    if main.is_minimized().unwrap_or(false) {
        let _ = main.unminimize();
    }
    let _ = main.set_focus();
    // 表示し終わってから、最小化などのアニメーションを元に戻す
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        platform::set_transitions(&main, true);
    });
}

/// モニターの範囲を、静止画の中の座標に直す
fn monitor_region(shot: &Screenshot, pos: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> Region {
    let x = (pos.x - shot.x).clamp(0, shot.width as i32) as u32;
    let y = (pos.y - shot.y).clamp(0, shot.height as i32) as u32;
    Region {
        x,
        y,
        width: size.width.min(shot.width - x),
        height: size.height.min(shot.height - y),
    }
}

/// RGBA 画像から矩形を切り抜く（画像からはみ出した分は切り詰める）。範囲が空なら None
fn crop_rgba(src: &[u8], src_w: u32, src_h: u32, r: Region) -> Option<(u32, u32, Vec<u8>)> {
    let x0 = r.x.min(src_w) as usize;
    let y0 = r.y.min(src_h) as usize;
    let x1 = r.x.saturating_add(r.width).min(src_w) as usize;
    let y1 = r.y.saturating_add(r.height).min(src_h) as usize;
    if x1 <= x0 || y1 <= y0 || src.len() < src_w as usize * src_h as usize * 4 {
        return None;
    }
    let row_bytes = (x1 - x0) * 4;
    let mut out = Vec::with_capacity(row_bytes * (y1 - y0));
    for row in y0..y1 {
        let start = (row * src_w as usize + x0) * 4;
        out.extend_from_slice(&src[start..start + row_bytes]);
    }
    Some(((x1 - x0) as u32, (y1 - y0) as u32, out))
}

// ------------------------------------------------------------------ OS ごとの処理

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr::null_mut;

    use tauri::WebviewWindow;
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
        SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };

    use super::Screenshot;

    /// 全モニターをまとめた仮想スクリーン全体を GDI で撮る（Tauri は Per-Monitor DPI Aware なので物理ピクセル）
    pub fn capture_virtual_screen() -> Result<Screenshot, String> {
        unsafe {
            let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if w <= 0 || h <= 0 {
                return Err("画面の大きさを取得できませんでした".into());
            }

            let screen = GetDC(null_mut());
            if screen.is_null() {
                return Err("画面を取得できませんでした".into());
            }
            let mem = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, bitmap);
            // CAPTUREBLT: 半透明なウィンドウ（レイヤードウィンドウ）も写す
            let copied = BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT) != 0;
            SelectObject(mem, old);

            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // 負 = 上の行から
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut pixels = vec![0u8; w as usize * h as usize * 4];
            let lines = if copied {
                GetDIBits(mem, bitmap, 0, h as u32, pixels.as_mut_ptr().cast(), &mut info, DIB_RGB_COLORS)
            } else {
                0
            };

            DeleteObject(bitmap);
            DeleteDC(mem);
            ReleaseDC(null_mut(), screen);

            if lines != h {
                return Err("画面を取得できませんでした".into());
            }
            // BGRA → RGBA（GDI のアルファは不定なので不透明にする）
            for px in pixels.chunks_exact_mut(4) {
                px.swap(0, 2);
                px[3] = 255;
            }
            Ok(Screenshot { x, y, width: w as u32, height: h as u32, rgba: pixels })
        }
    }

    /// ウィンドウの表示/非表示のアニメーションを止める / 戻す（撮るときに消えかけのウィンドウが写らないように）
    pub fn set_transitions(window: &WebviewWindow, enabled: bool) {
        let Ok(hwnd) = window.hwnd() else { return };
        let hwnd = hwnd.0 as isize;
        let _ = window.run_on_main_thread(move || unsafe {
            let disabled: BOOL = if enabled { 0 } else { 1 };
            DwmSetWindowAttribute(
                hwnd as HWND,
                DWMWA_TRANSITIONS_FORCEDISABLED as u32,
                (&disabled as *const BOOL).cast::<c_void>(),
                size_of::<BOOL>() as u32,
            );
        });
    }
}

#[cfg(not(windows))]
mod platform {
    use tauri::WebviewWindow;

    use super::Screenshot;

    pub fn capture_virtual_screen() -> Result<Screenshot, String> {
        Err("画面からの取得は Windows 版でのみ使えます".into())
    }

    pub fn set_transitions(_window: &WebviewWindow, _enabled: bool) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 各ピクセルの R = x, G = y にした 4×3 の画像
    fn sample() -> Vec<u8> {
        let mut v = Vec::new();
        for y in 0..3u8 {
            for x in 0..4u8 {
                v.extend_from_slice(&[x, y, 0, 255]);
            }
        }
        v
    }

    #[test]
    fn crops_the_requested_rectangle() {
        let (w, h, px) = crop_rgba(&sample(), 4, 3, Region { x: 1, y: 1, width: 2, height: 2 }).unwrap();
        assert_eq!((w, h), (2, 2));
        assert_eq!(px, [1, 1, 0, 255, 2, 1, 0, 255, 1, 2, 0, 255, 2, 2, 0, 255]);
    }

    #[test]
    fn clamps_to_the_image() {
        let (w, h, px) = crop_rgba(&sample(), 4, 3, Region { x: 3, y: 2, width: 10, height: 10 }).unwrap();
        assert_eq!((w, h), (1, 1));
        assert_eq!(px, [3, 2, 0, 255]);
    }

    #[test]
    fn rejects_empty_or_outside() {
        assert!(crop_rgba(&sample(), 4, 3, Region { x: 4, y: 0, width: 2, height: 2 }).is_none());
        assert!(crop_rgba(&sample(), 4, 3, Region { x: 0, y: 0, width: 0, height: 2 }).is_none());
        assert!(crop_rgba(&sample(), 4, 3, Region { x: u32::MAX, y: 0, width: u32::MAX, height: 1 }).is_none());
    }

    #[test]
    fn maps_monitor_into_the_virtual_screen() {
        // モニターが 2 枚（左が -1920 から）。右（メイン）のモニターは静止画の x = 1920 から
        let shot = Screenshot { x: -1920, y: 0, width: 3840, height: 1080, rgba: Vec::new() };
        let r = monitor_region(&shot, PhysicalPosition::new(0, 0), PhysicalSize::new(1920, 1080));
        assert_eq!(r, Region { x: 1920, y: 0, width: 1920, height: 1080 });
    }
}
