#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.userscripts.host"

echo "Building native host..."
cd "$(dirname "$0")/host"
cargo build --release
cd ..

BINARY="$(pwd)/host/target/release/userscripts-host"

if [ -z "${1:-}" ]; then
    echo ""
    echo "To complete setup:"
    echo "1. Load the extension from ./extension/ in chrome://extensions (Developer mode ON)"
    echo "2. Note the extension ID"
    echo "3. Run: $0 <extension-id>"
    exit 0
fi

EXT_ID="$1"

# detect browser config dirs
for dir in \
    "$HOME/.config/chromium/NativeMessagingHosts" \
    "$HOME/.config/google-chrome/NativeMessagingHosts"; do
    if [ -d "$(dirname "$dir")" ]; then
        mkdir -p "$dir"
        cat > "$dir/$HOST_NAME.json" <<EOF
{
    "name": "$HOST_NAME",
    "description": "Userscripts native messaging host",
    "path": "$BINARY",
    "type": "stdio",
    "allowed_origins": [
        "chrome-extension://$EXT_ID/"
    ]
}
EOF
        echo "Wrote native messaging manifest: $dir/$HOST_NAME.json"
    fi
done

SCRIPTS_DIR="${USERSCRIPTS_DIR:-$HOME/.local/share/userscripts}"
mkdir -p "$SCRIPTS_DIR"
echo "Scripts directory: $SCRIPTS_DIR"
echo ""
echo "Setup complete! Reload the extension to connect."
