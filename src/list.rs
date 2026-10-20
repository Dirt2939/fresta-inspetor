// The public list (lista.json, at the root of the repository): every place
// Fresta may reach, every program it may start, every folder it keeps things
// in and every key it may store, each with its reason. It is built into the
// program, so a build from source checks against the list in that source.
//
// "Meus endereços" are the hosts the person marks as their own (an n8n, a
// relay, an Ollama on another PC). They live in one small file on this PC.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Deserialize, Serialize, Clone)]
pub struct List {
    pub versao: String,
    pub sobre: String,
    pub rede: Vec<Service>,
    pub programas: Vec<Program>,
    pub pastas: Vec<Folder>,
    pub chaves: Keys,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Service {
    pub nome: String,
    pub motivo: String,
    pub hosts: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Program {
    pub exe: String,
    /// Part of Fresta: watched as if it were Fresta itself. Otherwise it is a
    /// program opened for the person (a browser, a terminal) and only listed.
    pub parte: bool,
    pub motivo: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Folder {
    pub pasta: String,
    pub motivo: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Keys {
    pub servico: String,
    pub antigo: String,
    pub nomes: BTreeMap<String, String>,
}

pub fn load() -> List {
    serde_json::from_str(include_str!("../lista.json")).expect("lista.json is valid")
}

impl List {
    /// The service a host belongs to: an exact name wins over a wildcard,
    /// a longer wildcard over a shorter one.
    pub fn service(&self, host: &str) -> Option<&Service> {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        self.rede
            .iter()
            .filter_map(|s| s.hosts.iter().filter_map(|p| score(p, &host)).max().map(|n| (n, s)))
            .max_by_key(|(n, _)| *n)
            .map(|(_, s)| s)
    }

    pub fn program(&self, exe: &str) -> Option<&Program> {
        self.programas.iter().find(|p| glob(&p.exe, exe))
    }

    pub fn key_label(&self, name: &str) -> Option<&String> {
        self.chaves.nomes.iter().find(|(k, _)| glob(k, name)).map(|(_, v)| v)
    }
}

fn score(pattern: &str, host: &str) -> Option<usize> {
    match pattern.strip_prefix("*.") {
        Some(base) => host.strip_suffix(base).is_some_and(|rest| rest.ends_with('.')).then_some(base.len()),
        None => (host == pattern).then_some(1000),
    }
}

/// `name` against a pattern with at most one `*`, without caring for case.
fn glob(pattern: &str, name: &str) -> bool {
    let (p, n) = (pattern.to_ascii_lowercase(), name.to_ascii_lowercase());
    match p.split_once('*') {
        Some((head, tail)) => n.len() >= head.len() + tail.len() && n.starts_with(head) && n.ends_with(tail),
        None => p == n,
    }
}

fn mine_file() -> PathBuf {
    PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("Fresta Inspetor").join("meus-enderecos.json")
}

pub fn mine() -> Vec<String> {
    std::fs::read(mine_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn set_mine(hosts: &[String]) -> Result<(), String> {
    let file = mine_file();
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(file, serde_json::to_vec_pretty(hosts).unwrap()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts() {
        let list = load();
        assert_eq!(list.service("api.spotify.com").unwrap().nome, "Spotify");
        assert_eq!(list.service("generativelanguage.googleapis.com").unwrap().nome, "Gemini");
        assert_eq!(list.service("rr3---sn-x.googlevideo.com").unwrap().nome, "YouTube");
        assert_eq!(list.service("abc.supabase.co.").unwrap().nome, "Supabase");
        assert!(list.service("supabase.co").is_none());
        assert!(list.service("evil-supabase.co").is_none());
        assert!(list.service("exemplo.com").is_none());
    }

    #[test]
    fn programs() {
        let list = load();
        assert!(list.program("MsEdgeWebView2.exe").unwrap().parte);
        assert!(list.program("Fresta-Setup-0.19.0.exe").unwrap().parte);
        assert!(!list.program("rundll32.exe").unwrap().parte);
        assert!(list.program("curl.exe").is_none());
        assert_eq!(list.key_label("gemini-key-work").unwrap(), "Chave do Gemini");
    }
}
