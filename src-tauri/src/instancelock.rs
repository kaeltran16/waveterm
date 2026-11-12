// wavesrv takes a per-data-dir lock and exits when it is held (wavebase.AcquireWaveLock), so a second Arc on
// the same data dir would open a window whose backend is dead. The host checks that lock before it builds
// any window.
use std::fs::{OpenOptions, TryLockError};
use std::io;
use std::path::Path;

// wavebase.WaveLockFile, in wavesrv's data home
const LOCK_FILE_NAME: &str = "wave.lock";

// true when another process holds wavesrv's lock in data_home. go-filemutex locks byte 0 with LockFileEx
// (exclusive); std's try_lock is LockFileEx over the whole file, so the two conflict. the probe's handle
// closes on return, releasing the lock before wavesrv starts and takes it.
pub fn held_elsewhere(data_home: &Path) -> io::Result<bool> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data_home.join(LOCK_FILE_NAME))?;
    match file.try_lock() {
        Ok(()) => Ok(false),
        Err(TryLockError::WouldBlock) => Ok(true),
        Err(TryLockError::Error(e)) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("arc-instancelock-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_lock_held_by_another_handle_refuses_the_check() {
        let dir = temp_dir("held");
        let holder = File::create(dir.join(LOCK_FILE_NAME)).unwrap();
        holder.lock().unwrap();
        assert!(held_elsewhere(&dir).unwrap());
        drop(holder);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_free_lock_is_allowed_and_released_afterwards() {
        let dir = temp_dir("free");
        assert!(!held_elsewhere(&dir).unwrap());
        assert!(!held_elsewhere(&dir).unwrap());
        let other = File::open(dir.join(LOCK_FILE_NAME)).unwrap();
        other.try_lock().expect("the check left the lock held");
        drop(other);
        let _ = fs::remove_dir_all(&dir);
    }
}
