//! `whispera-apns-mock` binary. See the library docs for behaviour.
//!
//! ```text
//! whispera-apns-mock --listen 127.0.0.1:18082 --log pushes.jsonl \
//!     [--public-key key.pub.pem] [--exec '<cmd>'] [--env sandbox|production] \
//!     [--unregistered <token-suffix>]...
//! ```

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (addr, opts) = match whispera_apns_mock::parse_args(&args) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("bind {addr}: {e}");
            std::process::exit(1);
        }
    };
    let bound = listener.local_addr().unwrap_or(addr);
    println!(
        "whispera-apns-mock listening on http://{bound} (log {}, jwt check {}, exec {})",
        opts.log.display(),
        if opts.public_key.is_some() {
            "on"
        } else {
            "off"
        },
        if opts.exec.is_some() { "on" } else { "off" },
    );
    if let Err(e) = whispera_apns_mock::serve(listener, opts).await {
        eprintln!("whispera-apns-mock: {e}");
        std::process::exit(1);
    }
}
