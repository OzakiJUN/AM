//! The user's password for joining more servers without typing it again
//! (docs/design.md §7, "资料同步"). Kept in the operating system's credential
//! store (Windows Credential Manager: encrypted, readable only by this
//! Windows user; on Android the Keystore-encrypted store of
//! android-native-keyring-store), never in a file of ours. Other platforms:
//! not supported yet, the UI then simply asks for the password.

const SERVICE: &str = "AM";

#[cfg(any(target_os = "windows", target_os = "android"))]
fn entry(key: &str) -> Result<keyring_core::Entry, String> {
    use std::sync::OnceLock;
    static INIT: OnceLock<Result<(), String>> = OnceLock::new();
    INIT.get_or_init(|| {
        #[cfg(target_os = "windows")]
        let store = windows_native_keyring_store::Store::new().map_err(|e| e.to_string())?;
        #[cfg(target_os = "android")]
        let store = android_native_keyring_store::Store::new().map_err(|e| e.to_string())?;
        keyring_core::set_default_store(store);
        Ok(())
    })
    .clone()?;
    keyring_core::Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "windows", target_os = "android"))]
pub fn get(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(any(target_os = "windows", target_os = "android"))]
pub fn set(key: &str, value: &str) -> Result<(), String> {
    entry(key)?.set_password(value).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "windows", target_os = "android"))]
pub fn delete(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
pub fn get(_key: &str) -> Result<Option<String>, String> {
    let _ = SERVICE;
    Ok(None)
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
pub fn set(_key: &str, _value: &str) -> Result<(), String> {
    Err("unsupported".into())
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
pub fn delete(_key: &str) -> Result<(), String> {
    Ok(())
}
