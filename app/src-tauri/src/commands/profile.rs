use tauri::{Manager, State};

use crate::TelegramState;

/// The logged-in Telegram account's identity, returned to the sidebar/header
/// so it can show a real name + avatar instead of a generic placeholder.
#[derive(serde::Serialize)]
pub struct SelfProfile {
    pub id: i64,
    /// Display name (first + last name for a personal account).
    pub name: String,
    pub username: Option<String>,
    /// Absolute local filesystem path to the downloaded avatar JPEG, or `None`
    /// if the account has no profile photo. The frontend turns this into a
    /// loadable `asset://` URL via `convertFileSrc` (same convention already
    /// used for thumbnails/previews in `commands/preview.rs`).
    pub photo_path: Option<String>,
}

/// Fetches the signed-in user's name/username and downloads their profile
/// photo (small variant) to the app data dir, caching it on disk so we don't
/// re-download on every app launch.
///
/// Verified against this project's pinned grammers commit (`rev = "d07f96f"`
/// in `Cargo.toml`), fetched directly from github.com/Lonami/grammers at that
/// revision:
/// - `User` (the type `Client::get_me()` resolves to) has no `name()` or
///   `id()` method. Display name comes from `full_name()` (first + last,
///   falling back to first name alone). The numeric id comes from
///   `bare_id() -> i64`, a thin wrapper over the underlying raw TL id.
/// - There is no `User::photo_downloadable()`. Downloadable avatar locations
///   are built one level up, on the `Peer` enum: `Peer::photo(&self, big:
///   bool) -> Option<types::ChatPhoto>`, and `ChatPhoto` (not `User`) is what
///   implements the `Downloadable` trait `client.download_media` needs. So we
///   wrap `me` in `Peer::User(..)` first, then call `.photo(false)` on that.
#[tauri::command]
pub async fn cmd_get_self_profile(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<SelfProfile, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Client not connected")?.clone()
    };

    let me = client.get_me().await.map_err(|e| e.to_string())?;

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let avatar_dir = app_data_dir.join("profile");
    if !avatar_dir.exists() {
        std::fs::create_dir_all(&avatar_dir).map_err(|e| e.to_string())?;
    }
    let avatar_path = avatar_dir.join(format!("self-{}.jpg", me.bare_id()));

    let mut photo_path: Option<String> = None;
    let self_peer = grammers_client::types::Peer::User(me.clone());
    if let Some(photo) = self_peer.photo(false) {
        match client.download_media(&photo, &avatar_path).await {
            Ok(_) => photo_path = Some(avatar_path.to_string_lossy().to_string()),
            Err(e) => {
                log::warn!("Failed to download self avatar: {}", e);
            }
        }
    }

    Ok(SelfProfile {
        id: me.bare_id(),
        name: me.full_name(),
        username: me.username().map(|s| s.to_string()),
        photo_path,
    })
}
