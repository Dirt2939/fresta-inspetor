// Small questions to Windows, each answered by Windows itself: which programs
// are running, their path and command line, the TCP connections open right
// now, the name behind an address, and where the Downloads folder is.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::{SystemTime, UNIX_EPOCH};
use windows::core::{HSTRING, PWSTR};
use windows::Wdk::System::Threading::{NtQueryInformationProcess, PROCESSINFOCLASS};
use windows::Win32::Foundation::{CloseHandle, UNICODE_STRING};
use windows::Win32::NetworkManagement::Dns::{DnsFree, DnsFreeRecordList, DnsQuery_W, DNS_QUERY_STANDARD, DNS_RECORDA, DNS_RECORDW, DNS_TYPE_PTR};
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6TABLE_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_CONNECTIONS,
};
use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};
use windows::Win32::Storage::FileSystem::QueryDosDeviceW;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A Windows FILETIME (100 ns since 1601) as milliseconds since 1970.
pub fn filetime_ms(ft: u64) -> u64 {
    ft.saturating_sub(116_444_736_000_000_000) / 10_000
}

fn wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
}

/// Every running process, as the Task Manager sees it.
pub fn processes() -> Vec<Proc> {
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut e = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snap, &mut e).is_ok();
        while more {
            out.push(Proc { pid: e.th32ProcessID, ppid: e.th32ParentProcessID, name: wide(&e.szExeFile) });
            more = Process32NextW(snap, &mut e).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    out
}

pub fn image_path(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// The command line a process was started with.
pub fn command_line(pid: u32) -> Option<String> {
    const PROCESS_COMMAND_LINE_INFORMATION: PROCESSINFOCLASS = PROCESSINFOCLASS(60);
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u64; 8192];
        let mut len = 0u32;
        let status = NtQueryInformationProcess(h, PROCESS_COMMAND_LINE_INFORMATION, buf.as_mut_ptr().cast(), (buf.len() * 8) as u32, &mut len);
        let _ = CloseHandle(h);
        if status.is_err() {
            return None;
        }
        let s = &*(buf.as_ptr() as *const UNICODE_STRING);
        if s.Buffer.is_null() {
            return None;
        }
        Some(String::from_utf16_lossy(std::slice::from_raw_parts(s.Buffer.0, s.Length as usize / 2)))
    }
}

/// `\Device\HarddiskVolume3` → `C:`, for every drive letter in use.
pub fn drives() -> Vec<(String, String)> {
    (b'A'..=b'Z')
        .filter_map(|l| {
            let drive = format!("{}:", l as char);
            let mut buf = [0u16; 512];
            let n = unsafe { QueryDosDeviceW(&HSTRING::from(drive.as_str()), Some(&mut buf)) };
            (n > 0).then(|| (wide(&buf), drive))
        })
        .collect()
}

pub fn dos_path(drives: &[(String, String)], device: &str) -> Option<String> {
    drives.iter().find_map(|(dev, drive)| {
        let rest = device.strip_prefix(dev.as_str())?;
        (rest.len() > 1 && rest.starts_with('\\')).then(|| format!("{drive}{rest}"))
    })
}

/// The name an address answers by (its PTR record), asked to the PC's own DNS.
pub fn reverse(ip: IpAddr) -> Option<String> {
    let name = match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            format!("{}.{}.{}.{}.in-addr.arpa", o[3], o[2], o[1], o[0])
        }
        IpAddr::V6(v6) => v6.octets().iter().rev().map(|b| format!("{:x}.{:x}.", b & 0xf, b >> 4)).collect::<String>() + "ip6.arpa",
    };
    unsafe {
        let mut first: *mut DNS_RECORDW = std::ptr::null_mut();
        if DnsQuery_W(&HSTRING::from(name), DNS_TYPE_PTR, DNS_QUERY_STANDARD, None, (&mut first as *mut *mut DNS_RECORDW).cast::<*mut DNS_RECORDA>(), None).is_err() || first.is_null() {
            return None;
        }
        let mut found = None;
        let mut r = first;
        while !r.is_null() && found.is_none() {
            if (*r).wType == DNS_TYPE_PTR.0 {
                found = (*r).Data.PTR.pNameHost.to_string().ok();
            }
            r = (*r).pNext;
        }
        DnsFree(Some(first as *const _), DnsFreeRecordList);
        found
    }
}

/// TCP connections open right now: (process, remote address, remote port).
pub fn tcp() -> Vec<(u32, IpAddr, u16)> {
    let mut out = Vec::new();
    for family in [AF_INET.0 as u32, AF_INET6.0 as u32] {
        let mut buf = vec![0u64; 1 << 16];
        let mut size = (buf.len() * 8) as u32;
        let ret = unsafe { GetExtendedTcpTable(Some(buf.as_mut_ptr().cast()), &mut size, false, family, TCP_TABLE_OWNER_PID_CONNECTIONS, 0) };
        if ret != 0 {
            continue;
        }
        unsafe {
            if family == AF_INET.0 as u32 {
                let t = &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
                for r in std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize) {
                    let ip = IpAddr::V4(Ipv4Addr::from(r.dwRemoteAddr.to_ne_bytes()));
                    out.push((r.dwOwningPid, ip, u16::from_be(r.dwRemotePort as u16)));
                }
            } else {
                let t = &*(buf.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID);
                for r in std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize) {
                    let ip = IpAddr::V6(Ipv6Addr::from(r.ucRemoteAddr));
                    out.push((r.dwOwningPid, ip, u16::from_be(r.dwRemotePort as u16)));
                }
            }
        }
    }
    out
}

pub fn downloads() -> Option<String> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_Downloads, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    unsafe {
        let p = SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_DEFAULT, None).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }
}

/// An address that never leaves this PC or the local network.
pub fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_multicast() || v4.is_broadcast() || v4.is_unspecified(),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_local(IpAddr::V4(v4)),
            None => v6.is_loopback() || v6.is_multicast() || v6.is_unspecified() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80,
        },
    }
}

/// `::ffff:1.2.3.4` is just 1.2.3.4.
pub fn plain(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}
