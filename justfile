# ── Development ──

check:
    cargo check -p tva-core

check-all:
    cargo check --workspace

test:
    cargo test -p tva-core --lib

test-all:
    cargo test --workspace

lint:
    cargo fmt --all --check
    cargo clippy -p tva-core --all-targets -- -D warnings

fix:
    cargo fmt --all
    cargo clippy -p tva-core --all-targets --fix

# ── CI (local) ──

ci: msrv lint test deny targets megalinter

msrv:
    cargo check -p tva-core

deny:
    cargo deny check advisories bans licenses

targets:
    cargo check -p tva-wasm --target wasm32-unknown-unknown
    cargo build -p tva-ffi

megalinter:
    docker run --rm -v .:/repo oxsecurity/megalinter-rust:v9

# ── Release ──

release:
    cargo build --release -p tva-cli

publish:
    cargo publish -p tva-core
    cargo publish -p tva-cli
    cargo publish -p tva-ffi
    cargo publish -p tva-wasm

# ── Docs ──

doc:
    cargo doc -p tva-core --open

# ── Clean ──

clean:
    cargo clean
