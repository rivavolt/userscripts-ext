#!/usr/bin/env bash
set -euo pipefail

ZIP="${1:?Usage: import.sh <tampermonkey-backup.zip> [scripts-dir]}"
SCRIPTS_DIR="${2:-${USERSCRIPTS_DIR:-$HOME/.local/share/userscripts}}"

mkdir -p "$SCRIPTS_DIR"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

unzip -o "$ZIP" '*.user.js' '*.options.json' -d "$tmpdir" >/dev/null

disabled=()

while IFS= read -r -d '' f; do
    basename_full=$(basename "$f")
    script_name="${basename_full%.user.js}"

    # check if disabled in Tampermonkey
    options_file="$tmpdir/${script_name}.options.json"
    if [ -f "$options_file" ]; then
        enabled=$(python3 -c "import json,sys; print(json.load(sys.stdin)['settings']['enabled'])" < "$options_file" 2>/dev/null || echo "True")
        if [ "$enabled" = "False" ] || [ "$enabled" = "false" ]; then
            disabled+=("$script_name")
        fi
    fi

    # sanitize filename: lowercase, replace non-alphanumeric with hyphens
    sanitized=$(echo "$basename_full" | tr '[:upper:]' '[:lower:]' | sed "s/[^a-z0-9._-]/-/g; s/--*/-/g; s/^-//; s/-\./\./g")

    cp "$f" "$SCRIPTS_DIR/$sanitized"
    echo "  $basename_full -> $sanitized"
done < <(find "$tmpdir" -maxdepth 1 -name '*.user.js' -print0 | sort -z)

echo ""
echo "Imported to: $SCRIPTS_DIR"
echo "Total: $(find "$SCRIPTS_DIR" -name '*.user.js' | wc -l) scripts"

if [ ${#disabled[@]} -gt 0 ]; then
    echo ""
    echo "These scripts were disabled in Tampermonkey:"
    for name in "${disabled[@]}"; do
        echo "  - $name"
    done
    echo "Disable them in the extension popup after loading."
fi
