fn main() {
    // tauri-build は tauri.conf.json と capabilities の変更でしか再実行されないので、
    // アイコンだけ差し替えた（npm run icons）ときも exe に埋め込み直されるようにする
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
