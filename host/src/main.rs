use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::env;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

fn home_dir() -> PathBuf {
    PathBuf::from(env::var("HOME").expect("HOME not set"))
}

fn get_scripts_dir() -> PathBuf {
    if let Ok(dir) = env::var("USERSCRIPTS_DIR") {
        return PathBuf::from(dir);
    }

    let config_path = home_dir().join(".config/userscripts/config.json");
    if let Ok(content) = fs::read_to_string(&config_path) {
        if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(dir) = config["scripts_dir"].as_str() {
                return PathBuf::from(dir);
            }
        }
    }

    home_dir().join(".local/share/userscripts")
}

fn is_userscript(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(".user.js"))
}

fn hash_content(content: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    hasher.finish()
}

fn send_message(msg: &serde_json::Value) -> io::Result<()> {
    let data = serde_json::to_vec(msg)?;
    let len = (data.len() as u32).to_le_bytes();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    out.write_all(&len)?;
    out.write_all(&data)?;
    out.flush()
}

fn main() {
    let scripts_dir = get_scripts_dir();
    fs::create_dir_all(&scripts_dir).expect("Failed to create scripts directory");

    let mut known: HashMap<String, u64> = HashMap::new();

    // initial scan
    if let Ok(entries) = fs::read_dir(&scripts_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_userscript(&path) {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&path) {
                let id = path.file_name().unwrap().to_string_lossy().to_string();
                let hash = hash_content(&content);
                if send_message(&json!({
                    "type": "added",
                    "id": id,
                    "content": content
                }))
                .is_err()
                {
                    return;
                }
                known.insert(id, hash);
            }
        }
    }

    if send_message(&json!({"type": "ready"})).is_err() {
        return;
    }

    // read messages from extension (log errors to stderr/journalctl)
    thread::spawn(|| {
        let stdin = io::stdin();
        let mut handle = stdin.lock();
        loop {
            let mut len_bytes = [0u8; 4];
            if handle.read_exact(&mut len_bytes).is_err() {
                break;
            }
            let len = u32::from_le_bytes(len_bytes) as usize;
            let mut buf = vec![0u8; len];
            if handle.read_exact(&mut buf).is_err() {
                break;
            }
            if let Ok(msg) = serde_json::from_slice::<serde_json::Value>(&buf) {
                if msg["type"] == "log" {
                    let level = msg["level"].as_str().unwrap_or("info");
                    let text = msg["message"].as_str().unwrap_or("");
                    eprintln!("[userscripts] [{level}] {text}");
                }
            }
        }
    });

    // watch for changes
    let (tx, rx) = mpsc::channel();
    let mut watcher =
        RecommendedWatcher::new(tx, Config::default()).expect("Failed to create file watcher");
    watcher
        .watch(&scripts_dir, RecursiveMode::NonRecursive)
        .expect("Failed to watch scripts directory");

    for event in rx.into_iter().flatten() {
        match event.kind {
            EventKind::Create(_) | EventKind::Modify(_) => {
                for path in &event.paths {
                    if !is_userscript(path) {
                        continue;
                    }
                    // brief delay to let writes finish
                    thread::sleep(Duration::from_millis(50));
                    let Ok(content) = fs::read_to_string(path) else {
                        continue;
                    };
                    let id = path.file_name().unwrap().to_string_lossy().to_string();
                    let hash = hash_content(&content);
                    if known.get(&id) == Some(&hash) {
                        continue;
                    }
                    let msg_type = if known.contains_key(&id) {
                        "changed"
                    } else {
                        "added"
                    };
                    if send_message(&json!({
                        "type": msg_type,
                        "id": id,
                        "content": content
                    }))
                    .is_err()
                    {
                        return;
                    }
                    known.insert(id, hash);
                }
            }
            EventKind::Remove(_) => {
                for path in &event.paths {
                    if !is_userscript(path) {
                        continue;
                    }
                    let id = path.file_name().unwrap().to_string_lossy().to_string();
                    if known.remove(&id).is_some() {
                        if send_message(&json!({
                            "type": "removed",
                            "id": id
                        }))
                        .is_err()
                        {
                            return;
                        }
                    }
                }
            }
            _ => {}
        }
    }
}
