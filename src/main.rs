// Fresta Inspetor: shows, from outside and through Windows itself, what Fresta
// does on this PC. It never talks to Fresta and never sends anything anywhere.
//
//   watch.rs    processes, network, files and DNS (Windows event tracing)
//   sensors.rs  camera, microphone and location (Windows' privacy record)
//   keys.rs     Fresta's keys in the Credential Manager
//   lock.rs     the Windows Firewall rule
//   list.rs     the public list everything is checked against (lista.json)
//   win.rs      small Windows helpers
//
// The window (ui/) only draws what these return.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod keys;
mod list;
mod lock;
mod sensors;
mod watch;
mod win;

use serde::Serialize;
use std::collections::HashSet;
use std::net::IpAddr;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use watch::{ConnKey, Launch, Member, Shared, Watch};

#[derive(Serialize, Clone, Default)]
struct LockInfo {
    mode: &'static str,
    exe: String,
    allowed: usize,
    error: Option<String>,
}

struct App {
    watch: Shared,
    lock: Arc<Mutex<LockInfo>>,
}

#[derive(Serialize)]
struct Net {
    host: Option<String>,
    ip: String,
    port: u16,
    udp: bool,
    proc: String,
    sent: u64,
    recv: u64,
    opened: u32,
    first: u64,
    last: u64,
    open: bool,
    /// "lista", "meu", "fora", "local", "chamada" or "?" (still looking for its name).
    verdict: &'static str,
    service: Option<String>,
}

#[derive(Serialize, Default)]
struct Place {
    zone: &'static str,
    path: String,
    motivo: String,
    files: u32,
    opened: u32,
    written: u32,
    created: u32,
    deleted: u32,
    last: u64,
}

#[derive(Serialize)]
struct Loose {
    path: String,
    #[serde(flatten)]
    used: watch::FileUse,
}

#[derive(Serialize)]
struct Snapshot {
    now: u64,
    started: u64,
    etw: Option<String>,
    members: Vec<Member>,
    launches: Vec<Launch>,
    net: Vec<Net>,
    places: Vec<Place>,
    loose: Vec<Loose>,
    sensors: Vec<sensors::Sensor>,
    keys: Vec<keys::Key>,
    lock: LockInfo,
    mine: Vec<String>,
}

fn expand(path: &str) -> String {
    let mut out = path.to_string();
    for var in ["LOCALAPPDATA", "APPDATA", "USERPROFILE", "WINDIR", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"] {
        out = out.replace(&format!("%{var}%"), &std::env::var(var).unwrap_or_default());
    }
    out.replace("{Downloads}", &win::downloads().unwrap_or_default())
}

/// The folders files are grouped in: Fresta's (from the list), then Windows'.
fn places(list: &list::List) -> Vec<Place> {
    let mut out: Vec<Place> = list
        .pastas
        .iter()
        .map(|f| Place { zone: "fresta", path: expand(&f.pasta), motivo: f.motivo.clone(), ..Default::default() })
        .collect();
    let system = [
        ("%WINDIR%", "O próprio Windows: bibliotecas, fontes e configurações que todo programa usa."),
        ("%ProgramFiles(x86)%", "Programas instalados para todos, como o WebView2 que desenha a janela."),
        ("%ProgramFiles%", "Programas instalados para todos."),
        ("%ProgramData%", "Dados do Windows e de programas, comuns a todos os usuários."),
        ("%LOCALAPPDATA%\\Microsoft", "Arquivos do Windows na sua conta, como fontes e caches."),
    ];
    out.extend(system.iter().map(|(p, m)| Place { zone: "sistema", path: expand(p), motivo: m.to_string(), ..Default::default() }));
    out.retain(|p| p.path.len() > 3);
    out
}

fn under(path: &str, folder: &str) -> bool {
    path.len() > folder.len()
        && path.as_bytes()[folder.len()] == b'\\'
        && path[..folder.len()].eq_ignore_ascii_case(folder)
}

fn mine_matches(mine: &[String], host: &str) -> bool {
    mine.iter().any(|m| host == m || host.ends_with(&format!(".{m}")))
}

fn verdict(w: &Watch, mine: &[String], k: &ConnKey) -> (&'static str, Option<String>, Option<String>) {
    let host = w.names.get(&k.ip).cloned();
    if win::is_local(k.ip) {
        return ("local", None, host);
    }
    let ip = k.ip.to_string();
    let Some(h) = host.clone() else {
        if mine.contains(&ip) {
            return ("meu", None, None);
        }
        // A call in the rooms goes straight to the other person's PC: no name, UDP, from the window.
        if k.udp && k.proc.eq_ignore_ascii_case("msedgewebview2.exe") {
            return ("chamada", None, None);
        }
        return (if w.looking(k.ip) { "?" } else { "fora" }, None, None);
    };
    if let Some(s) = w.list.service(&h) {
        return ("lista", Some(s.nome.clone()), host);
    }
    if mine_matches(mine, &h) || mine.contains(&ip) {
        return ("meu", None, host);
    }
    ("fora", None, host)
}

fn allowed(w: &Watch, mine: &[String]) -> Vec<IpAddr> {
    let mut ips: Vec<IpAddr> = w.names.iter().filter(|(_, n)| w.list.service(n).is_some() || mine_matches(mine, n)).map(|(ip, _)| *ip).collect();
    ips.extend(mine.iter().filter_map(|m| m.parse::<IpAddr>().ok()));
    ips.sort();
    ips.dedup();
    ips
}

fn fresta_exe(w: &Watch) -> String {
    w.members
        .values()
        .find(|m| m.name.eq_ignore_ascii_case("fresta.exe") && !m.path.is_empty())
        .map(|m| m.path.clone())
        .unwrap_or_else(|| expand(r"%LOCALAPPDATA%\Fresta\fresta.exe"))
}

#[tauri::command]
fn snapshot(app: tauri::State<App>) -> Snapshot {
    let mine = list::mine();
    let w = app.watch.lock().unwrap();
    let net = w
        .conns
        .iter()
        .map(|(k, c)| {
            let (verdict, service, host) = verdict(&w, &mine, k);
            Net {
                host,
                ip: k.ip.to_string(),
                port: k.port,
                udp: k.udp,
                proc: k.proc.clone(),
                sent: c.sent,
                recv: c.recv,
                opened: c.opened,
                first: c.first,
                last: c.last,
                open: c.open_now,
                verdict,
                service,
            }
        })
        .collect();

    let mut places = places(&w.list);
    let mut loose = Vec::new();
    for (path, f) in &w.files {
        match places.iter_mut().find(|p| under(path, &p.path)) {
            Some(p) => {
                p.files += 1;
                p.opened += f.opened;
                p.written += f.written as u32;
                p.created += f.created as u32;
                p.deleted += f.deleted as u32;
                p.last = p.last.max(f.last);
            }
            None => loose.push(Loose { path: path.clone(), used: f.clone() }),
        }
    }
    loose.sort_by(|a, b| b.used.last.cmp(&a.used.last));
    loose.truncate(400);

    let mut members: Vec<Member> = w.members.values().cloned().collect();
    members.sort_by_key(|m| (m.since, m.pid));
    Snapshot {
        now: win::now_ms(),
        started: w.started,
        etw: w.etw.clone(),
        members,
        launches: w.launches.clone(),
        net,
        places,
        loose,
        sensors: sensors::read(),
        keys: keys::read(&w.list),
        lock: app.lock.lock().unwrap().clone(),
        mine,
    }
}

#[tauri::command]
fn list(app: tauri::State<App>) -> list::List {
    app.watch.lock().unwrap().list.clone()
}

#[tauri::command]
fn lock_preview(app: tauri::State<App>, mode: String) -> Vec<String> {
    let w = app.watch.lock().unwrap();
    lock::commands(&mode, &fresta_exe(&w), &allowed(&w, &list::mine())).into_iter().map(|c| format!("netsh {c}")).collect()
}

#[tauri::command]
fn lock_set(app: tauri::State<App>, mode: String) -> Result<(), String> {
    let (exe, ips) = {
        let w = app.watch.lock().unwrap();
        (fresta_exe(&w), allowed(&w, &list::mine()))
    };
    let result = lock::apply(&mode, &exe, &ips);
    let mut info = app.lock.lock().unwrap();
    *info = LockInfo { mode: lock::mode(), exe, allowed: ips.len(), error: result.clone().err() };
    result
}

#[tauri::command]
fn key_delete(app: tauri::State<App>, target: String) -> Result<(), String> {
    let w = app.watch.lock().unwrap();
    keys::delete(&target, &w.list)
}

#[tauri::command]
fn mine_set(hosts: Vec<String>) -> Result<(), String> {
    let mut clean: Vec<String> = hosts.iter().map(|h| h.trim().trim_end_matches('.').to_ascii_lowercase()).filter(|h| !h.is_empty()).collect();
    clean.sort();
    clean.dedup();
    list::set_mine(&clean)
}

/// Opens one of a few known places in Windows. Through Explorer, so a page
/// opens in the person's own browser and not as administrator.
#[tauri::command]
fn open(what: String) {
    let explorer = |arg: &str| Command::new("explorer.exe").arg(arg).spawn().map(|_| ());
    let _ = match what.as_str() {
        "firewall" => Command::new("mmc.exe").arg("wf.msc").spawn().map(|_| ()),
        "credenciais" => Command::new("control.exe").args(["/name", "Microsoft.CredentialManager"]).spawn().map(|_| ()),
        "camera" => explorer("ms-settings:privacy-webcam"),
        "microphone" => explorer("ms-settings:privacy-microphone"),
        "location" => explorer("ms-settings:privacy-location"),
        "codigo" => explorer("https://github.com/Dirt2939/fresta-inspetor"),
        "lista" => explorer("https://github.com/Dirt2939/fresta-inspetor/blob/main/lista.json"),
        path if std::path::Path::new(path).exists() => Command::new("explorer.exe").arg(format!("/select,{path}")).spawn().map(|_| ()),
        _ => Ok(()),
    };
}

/// Keeps the lock's state fresh, and in "lista" mode adds to the rule the new
/// addresses the list's hosts answer by (services move between servers).
fn keep_lock(app: Shared, info: Arc<Mutex<LockInfo>>) {
    let mut applied: HashSet<IpAddr> = HashSet::new();
    let mut tick = 0u64;
    loop {
        let mode = if tick % 6 == 0 { lock::mode() } else { info.lock().unwrap().mode };
        let (exe, ips) = {
            let w = app.lock().unwrap();
            (fresta_exe(&w), allowed(&w, &list::mine()))
        };
        let mut error = info.lock().unwrap().error.clone();
        if mode == "lista" && ips.iter().any(|ip| !applied.contains(ip)) {
            error = lock::apply("lista", &exe, &ips).err();
            if error.is_none() {
                applied = ips.iter().copied().collect();
            }
        }
        *info.lock().unwrap() = LockInfo { mode, exe, allowed: ips.len(), error };
        tick += 1;
        std::thread::sleep(Duration::from_secs(5));
    }
}

fn main() {
    let shared: Shared = Arc::new(Mutex::new(Watch::new(list::load())));
    let mut trace = match watch::trace(&shared) {
        Ok(t) => Some(t),
        Err(e) => {
            shared.lock().unwrap().etw = Some(e);
            None
        }
    };
    let poller = shared.clone();
    std::thread::spawn(move || watch::poll(poller));
    let lock = Arc::new(Mutex::new(LockInfo { mode: "livre", ..Default::default() }));
    let (a, b) = (shared.clone(), lock.clone());
    std::thread::spawn(move || keep_lock(a, b));

    tauri::Builder::default()
        .manage(App { watch: shared, lock })
        .invoke_handler(tauri::generate_handler![snapshot, list, lock_preview, lock_set, key_delete, mine_set, open])
        .build(tauri::generate_context!())
        .expect("the window could not be created")
        .run(move |_, event| {
            if let tauri::RunEvent::Exit = event {
                drop(trace.take());
                let _ = ferrisetw::trace::stop_trace_by_name(watch::SESSION);
            }
        });
}
