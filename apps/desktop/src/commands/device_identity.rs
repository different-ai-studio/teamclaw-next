use tracing::info;

fn secret_key_to_device_id(bytes: &[u8; 32]) -> (String, Vec<u8>) {
    (hex::encode(bytes), bytes.to_vec())
}

pub(crate) fn get_device_id() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let key_path = home
        .join(concat!(".", env!("APP_SHORT_NAME"), "/iroh"))
        .join("secret_key");
    if !key_path.exists() {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes)
            .map_err(|e| format!("Failed to generate random bytes: {e}"))?;
        let (device_id, key_bytes) = secret_key_to_device_id(&bytes);
        let dir = key_path.parent().unwrap();
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create device identity dir: {e}"))?;
        std::fs::write(&key_path, &key_bytes)
            .map_err(|e| format!("Failed to write device identity key: {e}"))?;
        info!("Generated new device identity: {device_id}");
        return Ok(device_id);
    }
    let bytes =
        std::fs::read(&key_path).map_err(|e| format!("Failed to read device identity key: {e}"))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "Device identity key file has invalid length".to_string())?;
    let (device_id, _) = secret_key_to_device_id(&bytes);
    Ok(device_id)
}

#[tauri::command]
pub fn get_persistent_device_id() -> Result<String, String> {
    get_device_id()
}
