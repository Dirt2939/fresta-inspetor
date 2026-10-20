// Camera, microphone and location: Windows records, for each program, when it
// last started and stopped using each one. It is the same record that
// Settings → Privacy shows. A stop time of zero means "in use right now".

use crate::win::filetime_ms;
use serde::Serialize;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
use winreg::RegKey;

const STORE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";

#[derive(Serialize)]
pub struct Sensor {
    pub kind: &'static str,
    /// Windows lets desktop programs use it at all.
    pub allowed: bool,
    pub uses: Vec<Use>,
}

#[derive(Serialize)]
pub struct Use {
    pub path: String,
    /// fresta.exe itself, or the WebView2 engine that draws its window (shared with other programs).
    pub shared: bool,
    pub start: u64,
    pub stop: u64,
    pub now: bool,
}

fn allowed(root: &RegKey, key: &str) -> bool {
    root.open_subkey(key).and_then(|k| k.get_value::<String, _>("Value")).map(|v| v != "Deny").unwrap_or(true)
}

pub fn read() -> Vec<Sensor> {
    let user = RegKey::predef(HKEY_CURRENT_USER);
    let machine = RegKey::predef(HKEY_LOCAL_MACHINE);
    [("camera", "webcam"), ("microphone", "microphone"), ("location", "location")]
        .into_iter()
        .map(|(kind, key)| {
            let base = format!(r"{STORE}\{key}");
            let desktop = format!(r"{base}\NonPackaged");
            let mut uses = Vec::new();
            if let Ok(apps) = user.open_subkey(&desktop) {
                for name in apps.enum_keys().flatten() {
                    let path = name.replace('#', "\\");
                    let file = path.rsplit('\\').next().unwrap_or_default().to_ascii_lowercase();
                    if file != "fresta.exe" && file != "msedgewebview2.exe" {
                        continue;
                    }
                    let Ok(k) = apps.open_subkey(&name) else { continue };
                    let start: u64 = k.get_value("LastUsedTimeStart").unwrap_or(0);
                    let stop: u64 = k.get_value("LastUsedTimeStop").unwrap_or(0);
                    if start == 0 {
                        continue;
                    }
                    uses.push(Use { shared: file != "fresta.exe", start: filetime_ms(start), stop: filetime_ms(stop), now: stop == 0, path });
                }
            }
            uses.sort_by(|a, b| b.start.cmp(&a.start));
            Sensor { kind, allowed: allowed(&machine, &base) && allowed(&user, &base) && allowed(&user, &desktop), uses }
        })
        .collect()
}
