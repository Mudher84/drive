use tauri::State;
use tauri::Manager;
use grammers_client::Client;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use grammers_mtsender::SenderPool;
use grammers_session::storages::SqliteSession;
use grammers_session::Session;
use tokio::sync::oneshot;
use tokio::time::Duration;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use grammers_tl_types as tl;

use crate::TelegramState;
use crate::models::{AuthResult};
use crate::commands::utils::map_error;
use grammers_client::SignInError;

/// Ensures the Telegram client is initialized.
/// 
/// IMPORTANT: This function properly manages runner lifecycle to prevent stack overflow.
/// Before spawning a new runner, it signals the old runner to shutdown.
pub async fn ensure_client_initialized(
    app_handle: &tauri::AppHandle,
    state: &State<'_, TelegramState>,
    api_id: i32,
) -> Result<Client, String> {
    #[cfg(target_os = "android")]
    {
        let mut count = 0;
        while ndk_context::android_context().vm().is_null() || ndk_context::android_context().context().is_null() {
            if count >= 200 { // 10 seconds timeout
                return Err("Timeout waiting for Android JNI context initialization.".to_string());
            }
            log::info!("Waiting for Android JNI context to initialize ({}ms)...", count * 50);
            tokio::time::sleep(Duration::from_millis(50)).await;
            count += 1;
        }
        log::info!("Android JNI context is ready!");
    }

    let mut client_guard = state.client.lock().await;

    if let Some(client) = client_guard.as_ref() {
        return Ok(client.clone());
    }

    // CRITICAL: Shutdown existing runner before creating a new one
    // This prevents runner task accumulation which causes stack overflow
    let did_shutdown_old_runner = {
        let mut guard = state.runner_shutdown.lock().unwrap();
        if let Some(shutdown_tx) = guard.take() {
            log::info!("Signaling old runner to shutdown...");
            let _ = shutdown_tx.send(());
            true
        } else {
            false
        }
    }; // MutexGuard dropped here — before the await
    if did_shutdown_old_runner {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let runner_num = state.runner_count.fetch_add(1, Ordering::SeqCst) + 1;
    log::info!("Initializing Telegram Client #{} with API ID: {}", runner_num, api_id);
    
    // Resolve session path safely
    let app_data_dir = app_handle.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
        
    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    }
    
    let session_path = app_data_dir.join("telegram.session");
    let session_path_str = session_path.to_string_lossy().to_string();
    log::info!("Opening session at: {}", session_path_str);
    
    let mut session_open_result = SqliteSession::open(&session_path_str);
    
    // Retry opening the session database up to 5 times (every 100ms)
    // in case the database is temporarily locked by the old shutting down runner.
    if session_open_result.is_err() {
        for attempt in 1..=5 {
            log::warn!("Failed to open session on attempt {} (database may be locked). Retrying in 100ms...", attempt);
            tokio::time::sleep(Duration::from_millis(100)).await;
            session_open_result = SqliteSession::open(&session_path_str);
            if session_open_result.is_ok() {
                break;
            }
        }
    }

    let session = match session_open_result.map_err(|e| e.to_string()) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("Session file could not be opened after retries ({}). Recreating...", e);
            let _ = std::fs::remove_file(&session_path);
            let _ = std::fs::remove_file(format!("{}-wal", session_path_str));
            let _ = std::fs::remove_file(format!("{}-shm", session_path_str));
            
            SqliteSession::open(&session_path_str)
                .map_err(|err| format!("Failed to open session after recreation: {}", err))?
        }
    };
        
    let net_config = app_handle.state::<Arc<crate::vpn_optimizer::NetworkConfig>>();
    let preferred_dc = {
        let vpn = net_config.vpn.read().unwrap();
        if vpn.enabled {
            vpn.preferred_dc.clone()
        } else {
            "auto".to_string()
        }
    };
    if preferred_dc.starts_with("dc") && preferred_dc.len() > 2 {
        if let Ok(dc_id) = preferred_dc[2..].parse::<i32>() {
            log::info!("Setting preferred home DC ID: {}", dc_id);
            session.set_home_dc_id(dc_id);
        }
    }

    let mut connection_params = grammers_mtsender::ConnectionParams::default();
    if let Some(proxy_url) = net_config.effective_proxy_url() {
        log::info!("Using proxy: {}", proxy_url);
        connection_params.proxy_url = Some(proxy_url);
    }

    let session = Arc::new(session);
    let pool = SenderPool::with_configuration(session, api_id, connection_params);
    let client = Client::new(&pool);
    
    // Create shutdown channel for this runner
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    *state.runner_shutdown.lock().unwrap() = Some(shutdown_tx);
    
    // Spawn the network runner with shutdown support
    let SenderPool { runner, updates, .. } = pool;
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            // Normal runner operation
            _ = runner.run() => {
                log::info!("Runner #{} exited normally", runner_num);
            }
            // Shutdown requested
            _ = shutdown_rx => {
                log::info!("Runner #{} shutdown requested, exiting", runner_num);
            }
        }
    });

    *client_guard = Some(client.clone());
    drop(client_guard);

    spawn_notification_listener(app_handle.clone(), state, client.clone(), updates);

    Ok(client)
}

/// Listens for incoming Telegram updates and shows a desktop notification for
/// each new (non-outgoing) message, across every chat — mirroring how a real
/// Telegram client would notify you, not just uploads/sync events.
///
/// Verified against this project's pinned grammers commit (see `Cargo.toml`'s
/// `rev = "d07f96f"`), fetched directly from
/// github.com/Lonami/grammers at that revision. That fork replaced the old
/// `Client::next_update()` polling method with a `SenderPool`-based design:
/// `SenderPool::with_configuration(..)` returns `{ runner, handle, updates }`
/// where `updates` is a single (non-cloneable) `UnboundedReceiver<UpdatesLike>`
/// fed by the low-level network runner. A `Client` turns that receiver into an
/// `UpdateStream` via `client.stream_updates(updates, UpdatesConfiguration)`,
/// and `UpdateStream::next().await -> Result<Update, InvocationError>` is the
/// new per-update poll, used below in place of the old `next_update()` call.
/// Likewise `Message::sender()` returns `Option<&types::Peer>` and
/// `Peer::name()` returns `Option<&str>` (not `&str`), so the sender-name
/// lookup below unwraps both layers before falling back to "Telegram".
fn spawn_notification_listener(
    app_handle: tauri::AppHandle,
    state: &State<'_, TelegramState>,
    client: Client,
    updates: tokio::sync::mpsc::UnboundedReceiver<grammers_session::updates::UpdatesLike>,
) {
    use grammers_client::{Update, UpdatesConfiguration};
    use tauri_plugin_notification::NotificationExt;

    // Give this listener its own shutdown channel (independent from the
    // low-level network runner's), signalled on logout/reconnect.
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    *state.notifier_shutdown.lock().unwrap() = Some(shutdown_tx);

    tauri::async_runtime::spawn(async move {
        let mut update_stream = client.stream_updates(updates, UpdatesConfiguration::default());
        loop {
            tokio::select! {
                update = update_stream.next() => {
                    match update {
                        Ok(Update::NewMessage(message)) => {
                            if message.outgoing() {
                                continue;
                            }
                            let notifications_enabled = app_handle
                                .try_state::<crate::NotificationSettings>()
                                .map(|s| s.0.load(std::sync::atomic::Ordering::Relaxed))
                                .unwrap_or(true);
                            if !notifications_enabled {
                                continue;
                            }
                            let sender_name = message
                                .sender()
                                .and_then(|chat| chat.name().map(|n| n.to_string()))
                                .unwrap_or_else(|| "Telegram".to_string());
                            let text = message.text();
                            if text.trim().is_empty() {
                                continue;
                            }
                            let preview: String = if text.chars().count() > 120 {
                                text.chars().take(120).collect::<String>() + "…"
                            } else {
                                text.to_string()
                            };

                            if let Err(e) = app_handle
                                .notification()
                                .builder()
                                .title(sender_name)
                                .body(preview)
                                .show()
                            {
                                log::warn!("Failed to show message notification: {}", e);
                            }
                        }
                        Ok(_other_update) => {
                            // Not a new message (e.g. read receipts, typing, etc.) — ignore.
                        }
                        Err(e) => {
                            log::warn!("Notification listener update error: {}. Retrying in 2s...", e);
                            tokio::time::sleep(Duration::from_secs(2)).await;
                        }
                    }
                }
                _ = &mut shutdown_rx => {
                    log::info!("Notification listener shutdown requested, exiting");
                    break;
                }
            }
        }
    });
}

#[tauri::command]
pub async fn cmd_connect(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    // Yam Drive ships with its own embedded Telegram app credentials
    // (see `telegram_credentials.rs`) — no per-user API ID/Hash setup step.
    let api_id = crate::telegram_credentials::api_id();
    // Store API ID for auto-reconnect
    *state.api_id.lock().await = Some(api_id);
    ensure_client_initialized(&app_handle, &state, api_id).await?;
    Ok(true)
}

#[tauri::command]
pub async fn cmd_check_connection(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    // 1. Check if client exists and is responsive
    let client_msg_opt = {
        let guard = state.client.lock().await;
        guard.as_ref().cloned()
    };

    if let Some(client) = client_msg_opt {
        // Ping (e.g., get_me)
        if client.get_me().await.is_ok() {
            return Ok(true);
        }
        log::warn!("Connection check failed (get_me). Attempting reconnect...");
    } else {
         log::warn!("Connection check: No client found. Checking for saved API ID...");
    }

    // 2. Reconnect Logic
    let api_id_opt = *state.api_id.lock().await;
    if let Some(api_id) = api_id_opt {
        // Force re-init: Clear old client first to ensure fresh pool
        *state.client.lock().await = None;
        
        match ensure_client_initialized(&app_handle, &state, api_id).await {
            Ok(c) => {
                // Double check
                if c.get_me().await.is_ok() {
                    log::info!("Auto-reconnect successful.");
                    return Ok(true);
                } else {
                    return Err("Reconnect succeeded but ping failed.".to_string());
                }
            },
            Err(e) => return Err(format!("Auto-reconnect failed: {}", e))
        }
    }

    Ok(false) // Not connected and no credentials to reconnect
}

#[tauri::command]
pub async fn cmd_reconnect_with_network_settings(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    let api_id = *state.api_id.lock().await;
    let api_id = match api_id {
        Some(id) => id,
        None => return Err("Not authenticated — no API ID saved.".into()),
    };

    log::info!("Reconnecting with updated network settings...");

    // 1. Shutdown existing runner
    {
        let mut shutdown_guard = state.runner_shutdown.lock().unwrap();
        if let Some(shutdown_tx) = shutdown_guard.take() {
            log::info!("Signaling runner shutdown for reconnect...");
            let _ = shutdown_tx.send(());
        }
    }
    // 1b. Shutdown existing notification listener (ensure_client_initialized will spawn a fresh one)
    {
        let mut notifier_guard = state.notifier_shutdown.lock().unwrap();
        if let Some(notifier_tx) = notifier_guard.take() {
            log::info!("Signaling notification listener shutdown for reconnect...");
            let _ = notifier_tx.send(());
        }
    }
    tokio::time::sleep(Duration::from_millis(100)).await;

    // 2. Clear old client
    *state.client.lock().await = None;

    // 3. Reinitialize with current network config (reads from NetworkConfig state)
    let client = ensure_client_initialized(&app_handle, &state, api_id).await?;

    // 4. Verify the new connection works
    match client.get_me().await {
        Ok(_me) => {
            log::info!("Reconnect successful — verified via get_me().");
            Ok(true)
        }
        Err(e) => {
            log::error!("Reconnect init succeeded but get_me failed: {}", e);
            Err(format!("Reconnected but ping failed: {}", e))
        }
    }
}

#[tauri::command]
pub async fn cmd_logout(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    crypto_state: State<'_, crate::crypto::state::CryptoState>,
) -> Result<bool, String> {
    log::info!("Logging out...");
    crypto_state.lock();

    // 1. Shutdown the network runner FIRST to prevent any operations
    {
        let mut shutdown_guard = state.runner_shutdown.lock().unwrap();
        if let Some(shutdown_tx) = shutdown_guard.take() {
            log::info!("Signaling runner shutdown for logout...");
            let _ = shutdown_tx.send(());
        }
    }

    // 1b. Shutdown the message-notification listener
    {
        let mut notifier_guard = state.notifier_shutdown.lock().unwrap();
        if let Some(notifier_tx) = notifier_guard.take() {
            log::info!("Signaling notification listener shutdown for logout...");
            let _ = notifier_tx.send(());
        }
    }
    
    // 2. Try to sign out from Telegram (if connected)
    let client_opt = { state.client.lock().await.clone() };
    if let Some(client) = client_opt {
        // We don't strictly care if this fails (e.g. network down), we just want to clear local state.
        let _ = client.sign_out().await; 
    }

    // 3. Clear State
    *state.client.lock().await = None;
    *state.login_token.lock().await = None;
    *state.password_token.lock().await = None;
    *state.api_id.lock().await = None;
    crate::commands::utils::clear_peer_cache(&state.peer_cache).await;
    state.cancelled_transfers.write().await.clear();

    // 4. Remove Session File
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let session_path = app_data_dir.join("telegram.session");
    let _ = std::fs::remove_file(session_path);
    let _ = std::fs::remove_file(app_data_dir.join("telegram.session-wal"));
    let _ = std::fs::remove_file(app_data_dir.join("telegram.session-shm"));

    log::info!("Logout complete. Vault locked. Runner count: {}", state.runner_count.load(Ordering::SeqCst));
    Ok(true)
}

#[tauri::command]
pub async fn cmd_auth_request_code(
    app_handle: tauri::AppHandle,
    phone: String,
    state: State<'_, TelegramState>,
) -> Result<String, String> {
    // Yam Drive ships with its own embedded Telegram app credentials
    // (see `telegram_credentials.rs`) — no per-user API ID/Hash setup step.
    let api_id = crate::telegram_credentials::api_id();
    let api_hash = crate::telegram_credentials::api_hash();

    // Store API ID
    *state.api_id.lock().await = Some(api_id);

    let client_handle = ensure_client_initialized(&app_handle, &state, api_id).await?;

    log::info!("Requesting code for {}", phone);
    
    let mut last_error = String::new();
    
    // Retry up to 2 times for AUTH_RESTART or 500
    for i in 1..=2 {
        match client_handle.request_login_code(&phone, &api_hash).await {
            Ok(token) => {
                let mut token_guard = state.login_token.lock().await;
                *token_guard = Some(token);
                return Ok("code_sent".to_string());
            },
            Err(e) => {
                let err_msg = e.to_string();
                log::warn!("Error requesting code (Attempt {}): {}", i, err_msg);
                
                if err_msg.contains("AUTH_RESTART") || err_msg.contains("500") {
                    log::info!("AUTH_RESTART error detected. Retrying...");
                    last_error = err_msg;
                    // Prepare for retry
                    continue;
                }
                
                // Other errors, fail immediately
                return Err(map_error(e));
            }
        }
    }

    Err(format!("Telegram Error after retry: {}", last_error))
}

#[tauri::command]
pub async fn cmd_auth_sign_in(
    code: String,
    state: State<'_, TelegramState>,
) -> Result<AuthResult, String> {
    log::info!("Signing in with code...");
    
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    let token_guard = state.login_token.lock().await;
    let login_token = token_guard.as_ref().ok_or("No login session found (restart flow)")?;

    match client.sign_in(login_token, &code).await {
        Ok(_user) => {
             log::info!("Successfully logged in.");
             Ok(AuthResult {
                success: true,
                next_step: Some("dashboard".to_string()),
                error: None,
            })
        }
        Err(SignInError::PasswordRequired(token)) => {
            let mut pw_guard = state.password_token.lock().await;
            *pw_guard = Some(token);

            Ok(AuthResult {
                success: false,
                next_step: Some("password".to_string()),
                error: None,
            })
        }
        Err(e) => {
           log::error!("Sign in error: {}", e);
           Err(format!("Sign in failed: {}", e))
        }
    }
}

#[tauri::command]
pub async fn cmd_auth_check_password(
    password: String,
    state: State<'_, TelegramState>,
) -> Result<AuthResult, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };
    
    let mut pw_guard = state.password_token.lock().await;
    let pw_token = pw_guard.take().ok_or("No password session found")?;

    match client.check_password(pw_token, password.as_str()).await {
        Ok(_user) => {
             log::info!("2FA Success.");
             Ok(AuthResult {
                success: true,
                next_step: Some("dashboard".to_string()),
                error: None,
            })
        }
        Err(e) => Err(format!("2FA Failed: {}", e))
    }
}

/// QR Login -- Step 1: Export a login token and return the `tg://login?token=...` URL.
/// The frontend renders this as a QR code for the user to scan with their phone.
#[tauri::command]
pub async fn cmd_auth_qr_login(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<String, String> {
    // Yam Drive ships with its own embedded Telegram app credentials
    // (see `telegram_credentials.rs`) — no per-user API ID/Hash setup step.
    let api_id = crate::telegram_credentials::api_id();
    let api_hash = crate::telegram_credentials::api_hash();

    // Store API ID
    *state.api_id.lock().await = Some(api_id);

    let client = ensure_client_initialized(&app_handle, &state, api_id).await?;

    log::info!("Requesting QR login token...");

    let result = client.invoke(&tl::functions::auth::ExportLoginToken {
        api_id,
        api_hash: api_hash.clone(),
        except_ids: vec![],
    }).await.map_err(|e| format!("ExportLoginToken failed: {}", e))?;

    match result {
        tl::enums::auth::LoginToken::Token(t) => {
            let encoded = URL_SAFE_NO_PAD.encode(&t.token);
            let url = format!("tg://login?token={}", encoded);
            log::info!("QR login URL generated, expires at {}", t.expires);
            Ok(url)
        }
        tl::enums::auth::LoginToken::Success(_s) => {
            // Already authorized (e.g. from a previous session)
            log::info!("QR login: already authorized");
            Ok("__authorized__".to_string())
        }
        tl::enums::auth::LoginToken::MigrateTo(m) => {
            log::info!("QR login: need to migrate to DC {}", m.dc_id);
            let encoded = URL_SAFE_NO_PAD.encode(&m.token);
            let url = format!("tg://login?token={}", encoded);
            Ok(url)
        }
    }
}

/// QR Login -- Step 2: Poll for scan completion.
/// Checks if the session became authorized after the user scanned the QR code.
///
/// IMPORTANT: We must NOT call auth.exportLoginToken here for polling.
/// Each call to exportLoginToken generates a NEW token and invalidates the
/// previous one, causing the scanned QR code to fail with "Invalid code".
/// Instead, we probe with updates.getState (via is_authorized()'s own raw
/// call, replicated here) which succeeds once the phone app accepts the
/// token via auth.acceptLoginToken.
///
/// 2FA (cloud password) accounts: `Client::is_authorized()` maps *any*
/// 401-class RPC error — including `SESSION_PASSWORD_NEEDED` — to `Ok(false)`,
/// discarding the specific error name. That collapses "not yet scanned" and
/// "scanned, but needs your Telegram password" into the same state, so a
/// 2FA-enabled account would poll forever and never reach the password step.
/// Fixed by inlining the same `updates.getState` probe ourselves and
/// inspecting the raw `InvocationError` for `SESSION_PASSWORD_NEEDED`
/// (via `InvocationError::is`, from `grammers-mtsender`'s `errors.rs`) before
/// falling back to "still waiting". On that match we build a `PasswordToken`
/// the same way `Client::sign_in()` does internally — `account.getPassword`
/// (raw TL, public `invoke`) wrapped via the public `PasswordToken::new(..)`
/// constructor — and hand it to `cmd_auth_check_password` via `state.password_token`,
/// exactly like the phone-login 2FA path already does.
#[tauri::command]
pub async fn cmd_auth_qr_poll(
    state: State<'_, TelegramState>,
) -> Result<AuthResult, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    // Check if the session is now authorized (user scanned QR on phone).
    // Inlined instead of calling client.is_authorized() so we can inspect
    // the raw error instead of having it collapsed to a plain bool.
    match client.invoke(&tl::functions::updates::GetState {}).await {
        Ok(_) => {
            log::info!("QR login: session authorized!");
            Ok(AuthResult {
                success: true,
                next_step: Some("dashboard".to_string()),
                error: None,
            })
        }
        Err(e) if e.is("SESSION_PASSWORD_NEEDED") => {
            log::info!("QR login: scanned, 2FA password required.");
            match client.invoke(&tl::functions::account::GetPassword {}).await {
                Ok(password) => {
                    let password: tl::types::account::Password = password.into();
                    let token = grammers_client::types::PasswordToken::new(password);
                    let mut pw_guard = state.password_token.lock().await;
                    *pw_guard = Some(token);

                    Ok(AuthResult {
                        success: false,
                        next_step: Some("password".to_string()),
                        error: None,
                    })
                }
                Err(e) => {
                    log::warn!("QR login: failed to fetch password info: {}", e);
                    Ok(AuthResult {
                        success: false,
                        next_step: Some("waiting".to_string()),
                        error: None,
                    })
                }
            }
        }
        Err(e) => {
            log::warn!("QR poll auth check failed: {}", e);
            Ok(AuthResult {
                success: false,
                next_step: Some("waiting".to_string()),
                error: None,
            })
        }
    }
}
