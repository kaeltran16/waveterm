use std::path::{Path, PathBuf};

// WAVETERM_APP_PATH: the dir whose `bin/` subdir holds the bundled wavesrv + wsh
// (wavebase.GetWaveAppBinPath = WAVETERM_APP_PATH + "/bin"). Dev keeps the spike's
// source-tree path; packaged uses Tauri's resource dir.
pub fn resolve_app_path(is_dev: bool, manifest_dir: &Path, resource_dir: &Path) -> PathBuf {
    if is_dev {
        manifest_dir.join("..").join("dist")
    } else {
        resource_dir.to_path_buf()
    }
}

// wavesrv hard-requires both WAVETERM_DATA_HOME and WAVETERM_CONFIG_HOME; split the
// per-user base dir into those two homes.
pub fn data_home_dirs(base: &Path) -> (PathBuf, PathBuf) {
    (base.join("data"), base.join("config"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_uses_source_tree_dist() {
        let got = resolve_app_path(true, Path::new("C:/proj/src-tauri"), Path::new("C:/ignored"));
        assert_eq!(got, Path::new("C:/proj/src-tauri").join("..").join("dist"));
    }

    #[test]
    fn packaged_uses_resource_dir() {
        let got = resolve_app_path(false, Path::new("C:/ignored"), Path::new("C:/app/res"));
        assert_eq!(got, PathBuf::from("C:/app/res"));
    }

    #[test]
    fn data_home_splits_into_data_and_config() {
        let base = Path::new("C:/u/AppData/Local/dev.waveterm.tauri");
        let (data, config) = data_home_dirs(base);
        assert_eq!(data, base.join("data"));
        assert_eq!(config, base.join("config"));
    }
}
