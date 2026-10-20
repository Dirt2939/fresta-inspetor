// The keys Fresta keeps in the Windows Credential Manager: their names, when
// they were saved and how big they are. Never what is inside them. Each one
// can be deleted from here, and only Fresta's can.

use crate::list::List;
use crate::win::filetime_ms;
use serde::Serialize;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Security::Credentials::{CredDeleteW, CredEnumerateW, CredFree, CREDENTIALW, CRED_ENUMERATE_FLAGS, CRED_TYPE_GENERIC};

#[derive(Serialize)]
pub struct Key {
    pub target: String,
    pub name: String,
    pub label: String,
    /// Saved by the old app (Coucou) and copied by Fresta when it moved in.
    pub old: bool,
    pub written: u64,
    pub size: u32,
}

/// "spotify-refresh.app.fresta" → "spotify-refresh": the keyring library
/// Fresta uses names each key "<name>.<service>".
fn split<'a>(target: &'a str, list: &List) -> Option<(&'a str, bool)> {
    if let Some(n) = target.strip_suffix(&format!(".{}", list.chaves.servico)) {
        return Some((n, false));
    }
    target.strip_suffix(&format!(".{}", list.chaves.antigo)).map(|n| (n, true))
}

pub fn read(list: &List) -> Vec<Key> {
    let mut out = Vec::new();
    unsafe {
        let mut count = 0u32;
        let mut creds: *mut *mut CREDENTIALW = std::ptr::null_mut();
        if CredEnumerateW(PCWSTR::null(), Some(CRED_ENUMERATE_FLAGS(0)), &mut count, &mut creds).is_err() {
            return out;
        }
        for &c in std::slice::from_raw_parts(creds, count as usize) {
            let c = &*c;
            let target = c.TargetName.to_string().unwrap_or_default();
            let Some((name, old)) = split(&target, list) else { continue };
            let ft = ((c.LastWritten.dwHighDateTime as u64) << 32) | c.LastWritten.dwLowDateTime as u64;
            out.push(Key {
                name: name.to_string(),
                label: list.key_label(name).cloned().unwrap_or_else(|| name.to_string()),
                old,
                written: filetime_ms(ft),
                size: c.CredentialBlobSize,
                target,
            });
        }
        CredFree(creds as *const _);
    }
    out.sort_by(|a, b| a.old.cmp(&b.old).then(b.written.cmp(&a.written)));
    out
}

pub fn delete(target: &str, list: &List) -> Result<(), String> {
    if split(target, list).is_none() {
        return Err("Essa chave não é da Fresta.".into());
    }
    unsafe { CredDeleteW(&HSTRING::from(target), CRED_TYPE_GENERIC, None) }.map_err(|e| e.message())
}
