// The lock: a rule in the Windows Firewall, made with netsh, the Firewall's
// own command line, so it shows up in Windows like any other rule (wf.msc,
// group "Fresta Inspetor") and stays there with the Inspetor closed.
//
//   lista — fresta.exe can only reach the addresses of the hosts on the list
//           (and this PC and the local network). The Firewall works with
//           addresses, not names, so the rule blocks everything else.
//   tudo  — fresta.exe can't reach anything outside this PC and the local network.
//
// The rule is for fresta.exe. The window is drawn by WebView2, which Windows
// shares among programs (Teams, Outlook…), and the Firewall can't tell them
// apart: that part is watched and reported, not blocked.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::os::windows::process::CommandExt;
use std::process::Command;

pub const LIST_RULE: &str = "Fresta Inspetor (somente a lista)";
pub const ALL_RULE: &str = "Fresta Inspetor (sem internet)";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn netsh(args: &str) -> Result<String, String> {
    let out = Command::new("netsh").raw_arg(args).creation_flags(CREATE_NO_WINDOW).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        Ok(text)
    } else {
        Err(text)
    }
}

fn exists(name: &str) -> bool {
    netsh(&format!(r#"advfirewall firewall show rule name="{name}""#)).is_ok()
}

pub fn mode() -> &'static str {
    if exists(ALL_RULE) {
        "tudo"
    } else if exists(LIST_RULE) {
        "lista"
    } else {
        "livre"
    }
}

/// This PC, the local network, multicast: never blocked.
const LOCAL_V4: &[(&str, &str)] = &[
    ("0.0.0.0", "0.255.255.255"),
    ("10.0.0.0", "10.255.255.255"),
    ("100.64.0.0", "100.127.255.255"),
    ("127.0.0.0", "127.255.255.255"),
    ("169.254.0.0", "169.254.255.255"),
    ("172.16.0.0", "172.31.255.255"),
    ("192.168.0.0", "192.168.255.255"),
    ("224.0.0.0", "255.255.255.255"),
];
const LOCAL_V6: &[(&str, &str)] = &[
    ("::", "::1"),
    ("fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"),
    ("fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"),
    ("ff00::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"),
];

/// Everything outside `keep`, as "a-b" ranges.
fn outside(mut keep: Vec<(u128, u128)>, max: u128, show: impl Fn(u128) -> String) -> Vec<String> {
    keep.sort();
    let mut out = Vec::new();
    let mut next = 0u128;
    for (a, b) in keep {
        if a > next {
            out.push(if a - 1 == next { show(next) } else { format!("{}-{}", show(next), show(a - 1)) });
        }
        if b >= next {
            if b == max {
                return out;
            }
            next = b + 1;
        }
    }
    out.push(format!("{}-{}", show(next), show(max)));
    out
}

fn v4(s: &str) -> u128 {
    u32::from(s.parse::<Ipv4Addr>().unwrap()) as u128
}

fn v6(s: &str) -> u128 {
    u128::from(s.parse::<Ipv6Addr>().unwrap())
}

/// The blocked addresses for a mode: (IPv4 ranges, IPv6 ranges).
pub fn blocked(mode: &str, allowed: &[IpAddr]) -> (Vec<String>, Vec<String>) {
    let mut keep4: Vec<(u128, u128)> = LOCAL_V4.iter().map(|(a, b)| (v4(a), v4(b))).collect();
    let mut keep6: Vec<(u128, u128)> = LOCAL_V6.iter().map(|(a, b)| (v6(a), v6(b))).collect();
    if mode == "lista" {
        for ip in allowed {
            match ip {
                IpAddr::V4(a) => keep4.push((u32::from(*a) as u128, u32::from(*a) as u128)),
                IpAddr::V6(a) => keep6.push((u128::from(*a), u128::from(*a))),
            }
        }
    }
    (
        outside(keep4, u32::MAX as u128, |n| Ipv4Addr::from(n as u32).to_string()),
        outside(keep6, u128::MAX, |n| Ipv6Addr::from(n).to_string()),
    )
}

/// The netsh commands for a mode, exactly as they run.
pub fn commands(mode: &str, exe: &str, allowed: &[IpAddr]) -> Vec<String> {
    let mut out = vec![
        format!(r#"advfirewall firewall delete rule name="{LIST_RULE}""#),
        format!(r#"advfirewall firewall delete rule name="{ALL_RULE}""#),
    ];
    if mode == "livre" {
        return out;
    }
    let name = if mode == "lista" { LIST_RULE } else { ALL_RULE };
    let (four, six) = blocked(mode, allowed);
    for ranges in [four, six] {
        out.push(format!(
            r#"advfirewall firewall add rule name="{name}" dir=out action=block program="{exe}" remoteip={} enable=yes profile=any description="Criada pelo Fresta Inspetor. Apague aqui ou no Inspetor.""#,
            ranges.join(",")
        ));
    }
    out
}

pub fn apply(mode: &str, exe: &str, allowed: &[IpAddr]) -> Result<(), String> {
    if mode != "livre" && !std::path::Path::new(exe).is_file() {
        return Err(format!("A Fresta não foi encontrada em {exe}."));
    }
    for (i, cmd) in commands(mode, exe, allowed).iter().enumerate() {
        // The first two only clear what was there; they fail when there was nothing.
        if let Err(e) = netsh(cmd) {
            if i >= 2 {
                return Err(e);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        let (four, _) = blocked("tudo", &[]);
        assert_eq!(four.first().unwrap(), "1.0.0.0-9.255.255.255");
        assert!(four.contains(&"11.0.0.0-100.63.255.255".to_string()));
        assert_eq!(four.last().unwrap(), "192.169.0.0-223.255.255.255");
        let ip: IpAddr = "142.250.79.46".parse().unwrap();
        let (four, _) = blocked("lista", &[ip]);
        assert!(four.contains(&"128.0.0.0-142.250.79.45".to_string()));
        assert!(four.contains(&"142.250.79.47-169.253.255.255".to_string()));
        let (_, six) = blocked("tudo", &[]);
        assert_eq!(six.first().unwrap(), "::2-fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
    }
}
