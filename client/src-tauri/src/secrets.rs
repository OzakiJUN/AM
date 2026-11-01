//! The user's password for joining more servers without typing it again
//! (docs/design.md §7, "资料同步"). Kept in the operating system's credential
//! store (Windows Credential Manager: encrypted, readable only by this
//! Windows user), never in a file of ours. Other platforms: not supported
//! yet, the UI then simply asks for the password.

const SERVICE: &str = "AM";

#[cfg(target_os = "windows")]
fn entry(key: &str) -> Result<keyring_core::Entry, String> {
    use std::sync::OnceLock;
    static INIT: OnceLock<Result<(), String>> = OnceLock::new();
    INIT.get_or_init(|| {
        let store = windows_native_keyring_store::Store::new().map_err(|e| e.to_string())?;
        keyring_core::set_default_store(store);
        Ok(())
    })
    .clone()?;
    keyring_core::Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
pub fn get(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(target_os = "windows")]
pub fn set(key: &str, value: &str) -> Result<(), String> {
    entry(key)?.set_password(value).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
pub fn delete(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(target_os = "windows"))]
pub fn get(_key: &str) -> Result<Option<String>, String> {
    let _ = SERVICE;
    Ok(None)
}

#[cfg(not(target_os = "windows"))]
pub fn set(_key: &str, _value: &str) -> Result<(), String> {
    Err("unsupported".into())
}

#[cfg(not(target_os = "windows"))]
pub fn delete(_key: &str) -> Result<(), String> {
    Ok(())
}
