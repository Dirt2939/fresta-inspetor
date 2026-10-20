// The program asks Windows for administrator rights when it opens: the event
// tracing it reads (ETW) and the Firewall only answer to administrators.
fn main() {
    let windows = tauri_build::WindowsAttributes::new().app_manifest(include_str!("app.manifest"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri build");
}
