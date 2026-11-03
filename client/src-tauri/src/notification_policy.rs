// Automatic notifications are for hidden/minimized windows, regardless of focus or chat.
// Kept independent of Tauri so CI can test this policy on the Windows build runner.
pub fn suppress(visible: bool, minimized: bool, force: bool) -> bool {
    visible && !minimized && !force
}

#[cfg(test)]
mod tests {
    use super::suppress;

    #[test]
    fn an_open_window_is_quiet() {
        assert!(suppress(true, false, false));
    }

    #[test]
    fn tray_and_minimized_windows_still_notify() {
        assert!(!suppress(false, false, false));
        assert!(!suppress(true, true, false));
        assert!(!suppress(false, true, false));
    }

    #[test]
    fn explicit_settings_test_bypasses_visibility() {
        for visible in [true, false] {
            for minimized in [true, false] {
                assert!(!suppress(visible, minimized, true));
            }
        }
    }
}
