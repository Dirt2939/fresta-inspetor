// What Fresta does, seen from outside. Windows' own event tracing (ETW) tells
// about every process that starts, every byte sent or received, every file
// opened and every name looked up, for the whole PC. Only what belongs to
// Fresta is kept: fresta.exe, fresta-hook.exe and the programs the public list
// marks as part of it (the WebView2 that draws its window, the PowerShell that
// installs an update), started by them.

use crate::list::List;
use crate::win;
use ferrisetw::parser::Parser;
use ferrisetw::provider::Provider;
use ferrisetw::schema_locator::SchemaLocator;
use ferrisetw::trace::{TraceProperties, UserTrace};
use ferrisetw::EventRecord;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, ToSocketAddrs, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const SESSION: &str = "Fresta Inspetor";
const ROOTS: &[&str] = &["fresta.exe", "fresta-hook.exe"];

const KERNEL_PROCESS: &str = "22FB2CD6-0E7B-422B-A0C7-2FAD1FD0E716";
const KERNEL_NETWORK: &str = "7DD42A49-5329-4832-8DFD-43D979153A88";
const KERNEL_FILE: &str = "EDD08927-9CC4-4E65-B970-C2560FB5C289";
const DNS_CLIENT: &str = "1C95126E-7EEA-49A9-A3FE-A378B03DDB4D";

// Microsoft-Windows-Kernel-Network event ids.
const SEND: &[u16] = &[10, 26, 42, 58];
const RECV: &[u16] = &[11, 27, 43, 59];
const CONNECT: &[u16] = &[12, 28];
const UDP: &[u16] = &[42, 43, 58, 59];

pub type Shared = Arc<Mutex<Watch>>;

#[derive(Serialize, Clone)]
pub struct Member {
    pub pid: u32,
    pub name: String,
    pub path: String,
    pub since: u64,
}

#[derive(Serialize, Clone)]
pub struct Launch {
    pub pid: u32,
    pub name: String,
    pub path: String,
    pub cmd: String,
    pub parent: String,
    pub start: u64,
    pub end: Option<u64>,
    /// "parte" (part of Fresta), "aberto" (opened for the person) or "fora" (not on the list).
    pub kind: &'static str,
    pub motivo: String,
}

#[derive(Hash, PartialEq, Eq, Clone)]
pub struct ConnKey {
    pub proc: String,
    pub ip: IpAddr,
    pub port: u16,
    pub udp: bool,
}

#[derive(Default, Clone)]
pub struct Conn {
    pub sent: u64,
    pub recv: u64,
    pub opened: u32,
    pub first: u64,
    pub last: u64,
    pub open_now: bool,
}

#[derive(Default, Clone, Serialize)]
pub struct FileUse {
    pub proc: String,
    pub opened: u32,
    pub created: bool,
    pub written: bool,
    pub deleted: bool,
    pub renamed: bool,
    pub first: u64,
    pub last: u64,
}

pub struct Watch {
    pub list: List,
    pub started: u64,
    pub etw: Option<String>,
    pub members: HashMap<u32, Member>,
    pub launches: Vec<Launch>,
    pub conns: HashMap<ConnKey, Conn>,
    pub names: HashMap<IpAddr, String>,
    pub files: HashMap<String, FileUse>,
    tried: HashSet<IpAddr>,
    objects: HashMap<u64, String>,
    locals: HashSet<IpAddr>,
    drives: Vec<(String, String)>,
}

impl Watch {
    pub fn new(list: List) -> Self {
        let mut locals = HashSet::new();
        // A UDP socket "connected" to an address picks the local address it
        // would use, without sending anything.
        for probe in ["192.0.2.1:9", "[2001:db8::1]:9"] {
            let bind = if probe.starts_with('[') { "[::]:0" } else { "0.0.0.0:0" };
            if let Some(a) = UdpSocket::bind(bind).and_then(|s| s.connect(probe).and_then(|_| s.local_addr())).ok() {
                locals.insert(a.ip());
            }
        }
        Watch {
            list,
            started: win::now_ms(),
            etw: None,
            members: HashMap::new(),
            launches: Vec::new(),
            conns: HashMap::new(),
            names: HashMap::new(),
            files: HashMap::new(),
            tried: HashSet::new(),
            objects: HashMap::new(),
            locals,
            drives: win::drives(),
        }
    }

    fn is_root(name: &str) -> bool {
        ROOTS.iter().any(|r| r.eq_ignore_ascii_case(name))
    }

    /// A process just started. If its parent is part of Fresta, it is listed,
    /// and watched too when the list says it is part of Fresta.
    fn started(&mut self, pid: u32, ppid: u32, name: &str, now: u64) {
        if self.members.contains_key(&pid) {
            return;
        }
        if Self::is_root(name) {
            let path = win::image_path(pid).unwrap_or_default();
            self.members.insert(pid, Member { pid, name: name.into(), path, since: now });
            return;
        }
        let Some(parent) = self.members.get(&ppid).map(|m| m.name.clone()) else { return };
        if self.launches.iter().any(|l| l.pid == pid && l.end.is_none()) {
            return;
        }
        let path = win::image_path(pid).unwrap_or_default();
        let entry = self.list.program(name);
        let kind = match entry {
            Some(p) if p.parte => "parte",
            Some(_) => "aberto",
            None => "fora",
        };
        let cmd = win::command_line(pid).unwrap_or_default();
        self.launches.push(Launch {
            pid,
            name: name.into(),
            path: path.clone(),
            cmd,
            parent,
            start: now,
            end: None,
            kind,
            motivo: entry.map(|p| p.motivo.clone()).unwrap_or_default(),
        });
        if kind == "parte" {
            self.members.insert(pid, Member { pid, name: name.into(), path, since: now });
        }
    }

    fn stopped(&mut self, pid: u32, now: u64) {
        self.members.remove(&pid);
        for l in self.launches.iter_mut().filter(|l| l.pid == pid && l.end.is_none()) {
            l.end = Some(now);
        }
    }

    /// The process list, once a second: catches what started before the
    /// Inspetor, and is the only source when event tracing is not available.
    pub fn poll_processes(&mut self) {
        let now = win::now_ms();
        let procs = win::processes();
        let alive: HashSet<u32> = procs.iter().map(|p| p.pid).collect();
        let gone: Vec<u32> = self.members.keys().copied().filter(|p| !alive.contains(p)).collect();
        for pid in gone {
            self.stopped(pid, now);
        }
        for l in self.launches.iter_mut().filter(|l| l.end.is_none() && !alive.contains(&l.pid)) {
            l.end = Some(now);
        }
        // Parents before children: repeat until nothing new joins.
        loop {
            let before = self.members.len();
            for p in &procs {
                self.started(p.pid, p.ppid, &p.name, now);
            }
            if self.members.len() == before {
                break;
            }
        }
    }

    /// TCP connections open right now, from Windows' connection table.
    pub fn poll_connections(&mut self) {
        let now = win::now_ms();
        for c in self.conns.values_mut() {
            c.open_now = false;
        }
        for (pid, ip, port) in win::tcp() {
            let Some(m) = self.members.get(&pid) else { continue };
            let key = ConnKey { proc: m.name.clone(), ip: win::plain(ip), port, udp: false };
            let c = self.conns.entry(key).or_insert_with(|| Conn { first: now, ..Default::default() });
            c.open_now = true;
            c.last = c.last.max(now);
        }
    }

    fn traffic(&mut self, id: u16, pid: u32, size: u32, daddr: IpAddr, saddr: IpAddr, dport: u16, sport: u16) {
        let Some(m) = self.members.get(&pid) else { return };
        let (daddr, saddr) = (win::plain(daddr), win::plain(saddr));
        if CONNECT.contains(&id) {
            self.locals.insert(saddr);
        }
        // The far end is whichever side is not this PC.
        let (ip, port) = if self.locals.contains(&daddr) && !self.locals.contains(&saddr) { (saddr, sport) } else { (daddr, dport) };
        let now = win::now_ms();
        let key = ConnKey { proc: m.name.clone(), ip, port, udp: UDP.contains(&id) };
        let c = self.conns.entry(key).or_insert_with(|| Conn { first: now, ..Default::default() });
        c.last = now;
        if SEND.contains(&id) {
            c.sent += size as u64;
        } else if RECV.contains(&id) {
            c.recv += size as u64;
        } else if CONNECT.contains(&id) {
            c.opened += 1;
        }
    }

    fn file(&mut self, pid: u32, device: &str, object: Option<u64>, what: u16) {
        let Some(proc) = self.members.get(&pid).map(|m| m.name.clone()) else { return };
        let Some(path) = win::dos_path(&self.drives, device) else { return };
        let now = win::now_ms();
        if let Some(o) = object {
            if self.objects.len() > 200_000 {
                self.objects.clear();
            }
            self.objects.insert(o, path.clone());
        }
        let f = self.files.entry(path).or_insert_with(|| FileUse { proc, first: now, ..Default::default() });
        f.last = now;
        match what {
            12 => f.opened += 1,
            30 => f.created = true,
            26 => f.deleted = true,
            27 => f.renamed = true,
            _ => {}
        }
    }

    fn written(&mut self, pid: u32, object: u64) {
        if !self.members.contains_key(&pid) {
            return;
        }
        if let Some(f) = self.objects.get(&object).and_then(|p| self.files.get_mut(p)) {
            f.written = true;
            f.last = win::now_ms();
        }
    }

    /// "type: 5 youtube-ui.l.google.com;::ffff:142.250.79.46;" → the addresses.
    fn resolved(&mut self, name: &str, results: &str) {
        for part in results.split(';').map(str::trim) {
            if let Ok(ip) = part.parse::<IpAddr>() {
                self.names.insert(win::plain(ip), name.trim_end_matches('.').to_ascii_lowercase());
            }
        }
    }

    /// Addresses with no name yet, for the reverse lookup.
    pub fn unnamed(&self) -> Vec<IpAddr> {
        let mut ips: Vec<IpAddr> = self
            .conns
            .keys()
            .map(|k| k.ip)
            .filter(|ip| !win::is_local(*ip) && !self.names.contains_key(ip) && !self.tried.contains(ip))
            .collect();
        ips.sort();
        ips.dedup();
        ips
    }

    /// The answer of a reverse lookup, if there was one.
    pub fn answered(&mut self, ip: IpAddr, name: Option<String>) {
        self.tried.insert(ip);
        if let Some(name) = name {
            self.named(ip, name);
        }
    }

    /// Still waiting for the reverse lookup of this address.
    pub fn looking(&self, ip: IpAddr) -> bool {
        !self.tried.contains(&ip)
    }

    pub fn named(&mut self, ip: IpAddr, name: String) {
        self.names.entry(ip).or_insert(name.trim_end_matches('.').to_ascii_lowercase());
    }

    /// Every address of every host the list names exactly, as this PC's DNS
    /// answers now (the same answers Fresta gets).
    pub fn seed(list: &List) -> Vec<(IpAddr, String)> {
        let mut out = Vec::new();
        for host in list.rede.iter().flat_map(|s| &s.hosts).filter(|h| !h.contains('*')) {
            if let Ok(addrs) = (host.as_str(), 443).to_socket_addrs() {
                out.extend(addrs.map(|a| (win::plain(a.ip()), host.clone())));
            }
        }
        out
    }
}

fn parser<'a>(r: &'a EventRecord, l: &SchemaLocator, f: impl FnOnce(&Parser)) {
    if let Ok(schema) = l.event_schema(r) {
        f(&Parser::create(r, &schema));
    }
}

/// Starts the trace. It runs until the program closes.
pub fn trace(shared: &Shared) -> Result<UserTrace, String> {
    let _ = ferrisetw::trace::stop_trace_by_name(SESSION);

    let s = shared.clone();
    let process = Provider::by_guid(KERNEL_PROCESS)
        .any(0x10) // WINEVENT_KEYWORD_PROCESS
        .add_callback(move |r, l| {
            let id = r.event_id();
            if id != 1 && id != 2 {
                return;
            }
            parser(r, l, |p| {
                let pid: u32 = p.try_parse("ProcessID").unwrap_or(0);
                let mut w = s.lock().unwrap();
                if id == 1 {
                    let ppid: u32 = p.try_parse("ParentProcessID").unwrap_or(0);
                    let image: String = p.try_parse("ImageName").unwrap_or_default();
                    let name = image.rsplit('\\').next().unwrap_or_default().to_string();
                    w.started(pid, ppid, &name, win::now_ms());
                } else {
                    w.stopped(pid, win::now_ms());
                }
            });
        })
        .build();

    let s = shared.clone();
    let network = Provider::by_guid(KERNEL_NETWORK)
        .any(0x30) // IPv4 and IPv6
        .add_callback(move |r, l| {
            let id = r.event_id();
            if !(SEND.contains(&id) || RECV.contains(&id) || CONNECT.contains(&id)) {
                return;
            }
            parser(r, l, |p| {
                let pid: u32 = p.try_parse("PID").unwrap_or(0);
                let (Ok(daddr), Ok(saddr)) = (p.try_parse::<IpAddr>("daddr"), p.try_parse::<IpAddr>("saddr")) else { return };
                // Ports travel in network byte order.
                let dport = u16::from_be(p.try_parse("dport").unwrap_or(0));
                let sport = u16::from_be(p.try_parse("sport").unwrap_or(0));
                let size: u32 = p.try_parse("size").unwrap_or(0);
                s.lock().unwrap().traffic(id, pid, size, daddr, saddr, dport, sport);
            });
        })
        .build();

    let s = shared.clone();
    let file = Provider::by_guid(KERNEL_FILE)
        // CREATE | WRITE | DELETE_PATH | RENAME_SETLINK_PATH | CREATE_NEW_FILE
        .any(0x80 | 0x200 | 0x400 | 0x800 | 0x1000)
        .add_callback(move |r, l| {
            let id = r.event_id();
            let pid = r.process_id();
            if !matches!(id, 12 | 16 | 26 | 27 | 30) || !s.lock().unwrap().members.contains_key(&pid) {
                return;
            }
            parser(r, l, |p| {
                let object = p.try_parse::<ferrisetw::parser::Pointer>("FileObject").ok().map(|o| *o as u64);
                let mut w = s.lock().unwrap();
                match id {
                    16 => {
                        if let Some(o) = object {
                            w.written(pid, o);
                        }
                    }
                    12 | 30 => {
                        let name: String = p.try_parse("FileName").unwrap_or_default();
                        w.file(pid, &name, object, id);
                    }
                    _ => {
                        let name: String = p.try_parse("FilePath").unwrap_or_default();
                        w.file(pid, &name, None, id);
                    }
                }
            });
        })
        .build();

    let s = shared.clone();
    let dns = Provider::by_guid(DNS_CLIENT)
        .any(u64::MAX)
        .add_callback(move |r, l| {
            if r.event_id() != 3008 {
                return;
            }
            parser(r, l, |p| {
                let name: String = p.try_parse("QueryName").unwrap_or_default();
                let results: String = p.try_parse("QueryResults").unwrap_or_default();
                if !name.is_empty() {
                    s.lock().unwrap().resolved(&name, &results);
                }
            });
        })
        .build();

    let props = TraceProperties { buffer_size: 256, min_buffer: 32, max_buffer: 256, flush_timer: Duration::from_secs(1), ..Default::default() };
    UserTrace::new()
        .named(SESSION.to_string())
        .set_trace_properties(props)
        .enable(process)
        .enable(network)
        .enable(file)
        .enable(dns)
        .start_and_process()
        .map_err(|e| format!("{e:?}"))
}

/// The loops that complete the trace: processes and connections every
/// second, names for unknown addresses every three.
pub fn poll(shared: Shared) {
    let seeds = Watch::seed(&shared.lock().unwrap().list);
    {
        let mut w = shared.lock().unwrap();
        for (ip, host) in seeds {
            w.named(ip, host);
        }
    }
    let mut tick = 0u64;
    loop {
        {
            let mut w = shared.lock().unwrap();
            w.poll_processes();
            w.poll_connections();
        }
        if tick % 3 == 0 {
            let ips = shared.lock().unwrap().unnamed();
            for ip in ips {
                let name = win::reverse(ip);
                shared.lock().unwrap().answered(ip, name);
            }
        }
        tick += 1;
        std::thread::sleep(Duration::from_secs(1));
    }
}
