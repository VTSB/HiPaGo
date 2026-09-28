use crate::{BypassError, StreamingResponse};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

// Blocking file operations own this guard until they actually finish, even if
// the awaiting download is cancelled. Close the handle before removal (Windows).
struct PendingFile {
    file: Option<File>,
    path: PathBuf,
}

impl Drop for PendingFile {
    fn drop(&mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.path);
    }
}

impl PendingFile {
    fn create(destination: &Path) -> std::io::Result<Self> {
        static NEXT_ATTEMPT: AtomicU64 = AtomicU64::new(0);
        if let Some(parent) = destination
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)?;
        }
        loop {
            let id = NEXT_ATTEMPT.fetch_add(1, Ordering::Relaxed);
            let mut name = destination.as_os_str().to_os_string();
            name.push(format!(".{}.{}.part", std::process::id(), id));
            let path = PathBuf::from(name);
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => {
                    return Ok(Self {
                        file: Some(file),
                        path,
                    })
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(err),
            }
        }
    }
}

fn task_error(err: tokio::task::JoinError) -> BypassError {
    BypassError::HttpError(format!("Download file task failed: {err}"))
}

pub(crate) async fn save_response(
    mut response: StreamingResponse,
    destination: &str,
) -> Result<u64, BypassError> {
    if !(200..300).contains(&response.status) {
        return Err(BypassError::HttpError(format!(
            "Image fetch failed with HTTP {}",
            response.status
        )));
    }
    let destination = PathBuf::from(destination);
    let create_path = destination.clone();
    let pending = tokio::task::spawn_blocking(move || PendingFile::create(&create_path))
        .await
        .map_err(task_error)??;
    let pending = Arc::new(Mutex::new(pending));
    let mut total = 0;
    while let Some(chunk) = response.body_rx.recv().await {
        let chunk = chunk?;
        let size = chunk.len() as u64;
        let writer = Arc::clone(&pending);
        tokio::task::spawn_blocking(move || {
            writer
                .lock()
                .unwrap()
                .file
                .as_mut()
                .unwrap()
                .write_all(&chunk)
        })
        .await
        .map_err(task_error)??;
        total += size;
    }
    let writer = Arc::clone(&pending);
    tokio::task::spawn_blocking(move || {
        let mut pending = writer.lock().unwrap();
        pending.file.as_mut().unwrap().flush()?;
        pending.file.take();
        Ok::<(), std::io::Error>(())
    })
    .await
    .map_err(task_error)??;
    // Publish in this poll, after the final cancellable await. A detached
    // blocking task must not publish after its caller has been cancelled.
    // rename is atomic; on failure the previous destination remains intact.
    std::fs::rename(&pending.lock().unwrap().path, destination)?;
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tokio::sync::mpsc;

    fn destination() -> PathBuf {
        static ID: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "hipago-attempt-test-{}-{}",
            std::process::id(),
            ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory.join("image")
    }

    fn response() -> (
        mpsc::Sender<Result<Vec<u8>, BypassError>>,
        StreamingResponse,
    ) {
        let (tx, rx) = mpsc::channel(4);
        (
            tx,
            StreamingResponse {
                status: 200,
                headers: HashMap::new(),
                body_rx: rx,
            },
        )
    }

    async fn wait_for_temp(path: &Path) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while std::fs::read_dir(path.parent().unwrap()).unwrap().count() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn body_error_preserves_destination_and_cleans_temp() {
        let path = destination();
        std::fs::write(&path, b"previous").unwrap();
        let (tx, response) = response();
        tx.send(Ok(b"partial".to_vec())).await.unwrap();
        tx.send(Err(BypassError::HttpError("truncated".into())))
            .await
            .unwrap();
        drop(tx);
        assert!(save_response(response, path.to_str().unwrap())
            .await
            .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"previous");
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn cancellation_removes_attempt_without_publication() {
        let path = destination();
        let (tx, response) = response();
        let dest = path.clone();
        let task =
            tokio::spawn(async move { save_response(response, dest.to_str().unwrap()).await });
        wait_for_temp(&path).await;
        task.abort();
        let _ = task.await;
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while std::fs::read_dir(path.parent().unwrap()).unwrap().count() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!path.exists());
        tx.closed().await;
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn simultaneous_attempts_do_not_share_or_mix_files() {
        let path = destination();
        let (tx1, response1) = response();
        let (tx2, response2) = response();
        let dest1 = path.clone();
        let dest2 = path.clone();
        let first =
            tokio::spawn(async move { save_response(response1, dest1.to_str().unwrap()).await });
        let second =
            tokio::spawn(async move { save_response(response2, dest2.to_str().unwrap()).await });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while std::fs::read_dir(path.parent().unwrap()).unwrap().count() != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tx1.send(Ok(vec![1; 4096])).await.unwrap();
        tx2.send(Ok(vec![2; 8192])).await.unwrap();
        drop(tx1);
        drop(tx2);
        let results = (first.await.unwrap(), second.await.unwrap());
        assert!(results.0.is_ok() || results.1.is_ok());
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes == vec![1; 4096] || bytes == vec![2; 8192]);
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn rename_failure_removes_attempt_file() {
        let path = destination();
        std::fs::create_dir(&path).unwrap();
        let (tx, response) = response();
        tx.send(Ok(vec![1, 2])).await.unwrap();
        drop(tx);
        assert!(save_response(response, path.to_str().unwrap())
            .await
            .is_err());
        assert!(path.is_dir());
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
