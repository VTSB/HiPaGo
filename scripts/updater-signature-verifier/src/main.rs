use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use std::{env, error::Error, fs, io};

fn decode_base64_text(value: &str, label: &str) -> Result<String, Box<dyn Error>> {
    let decoded = STANDARD.decode(value.trim()).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{label} is not valid base64: {error}"),
        )
    })?;
    String::from_utf8(decoded).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{label} is not valid UTF-8: {error}"),
        )
        .into()
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let artifact_path = args.next().ok_or("missing artifact path")?;
    let signature_path = args.next().ok_or("missing signature path")?;
    let encoded_public_key = args.next().ok_or("missing updater public key")?;
    if args.next().is_some() {
        return Err("unexpected extra argument".into());
    }

    let artifact = fs::read(&artifact_path)?;
    let encoded_signature = fs::read_to_string(&signature_path)?;
    let public_key_text = decode_base64_text(&encoded_public_key, "updater public key")?;
    let signature_text = decode_base64_text(&encoded_signature, "updater signature")?;
    let public_key = PublicKey::decode(&public_key_text)?;
    let signature = Signature::decode(&signature_text)?;

    // Match tauri-plugin-updater's legacy-compatible verification mode.
    public_key.verify(&artifact, &signature, true)?;
    println!("Updater signature verified: {artifact_path}");
    Ok(())
}
