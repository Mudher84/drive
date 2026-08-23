//! Embedded Telegram API credentials for Yam Drive.
//!
//! These identify the *application* to Telegram (registered once at
//! https://my.telegram.org), not any individual user's account. Every
//! installation of Yam Drive shares this single app identity; each user's
//! own login (phone number / QR scan + code) is what actually grants access
//! to their personal Telegram account and files. This is the same model
//! every mainstream Telegram client uses — Telegram Desktop, Telegram Web,
//! etc. all ship one fixed API ID/hash baked into the binary, and users
//! never see or manage it themselves.
//!
//! Values below are stored XOR-obfuscated rather than as plain string/int
//! literals, so a quick `strings`/hex-dump pass over the compiled binary
//! doesn't turn them up directly. This is NOT strong security: anyone
//! willing to attach a debugger or decompile the binary at the point of use
//! can still recover them, since the program must decode them in memory to
//! make any Telegram API call at all. Treat this as raising the bar against
//! casual extraction, not as a secret-management system.

const XOR_KEY: &[u8] = b"YamDriveKeepSafe";
const API_ID_MASK: i32 = 0x5A5A5A5A;

/// `20331438` XORed with `API_ID_MASK`.
const API_ID_OBF: i32 = 0x5b6c61f4;

/// `"6010fb1fb3f66caedbefe0400ea2d388"` (ASCII bytes) XORed against `XOR_KEY`, repeating.
const API_HASH_OBF: &[u8] = &[
    0x6f, 0x51, 0x5c, 0x74, 0x14, 0x0b, 0x47, 0x03, 0x29, 0x56, 0x03, 0x46, 0x65, 0x02, 0x07,
    0x00, 0x3d, 0x03, 0x08, 0x22, 0x17, 0x59, 0x42, 0x55, 0x7b, 0x00, 0x04, 0x42, 0x37, 0x52,
    0x5e, 0x5d,
];

fn xor_decode(data: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, b)| b ^ XOR_KEY[i % XOR_KEY.len()])
        .collect()
}

/// The app's Telegram `api_id`. Same value for every Yam Drive install.
pub fn api_id() -> i32 {
    API_ID_OBF ^ API_ID_MASK
}

/// The app's Telegram `api_hash`. Same value for every Yam Drive install.
pub fn api_hash() -> String {
    String::from_utf8(xor_decode(API_HASH_OBF)).expect("embedded api_hash is valid UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_to_expected_values() {
        assert_eq!(api_id(), 20331438);
        assert_eq!(api_hash(), "6010fb1fb3f66caedbefe0400ea2d388");
    }
}
