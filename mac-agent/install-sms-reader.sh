#!/bin/bash
# Install the SMS reader launchd agent with the correct API secret.
# Usage: bash mac-agent/install-sms-reader.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_SRC="$SCRIPT_DIR/com.mcsecretary.sms-reader.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.mcsecretary.sms-reader.plist"

# Try to get API_SECRET from .env
ENV_FILE="$PROJECT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  API_SECRET=$(grep -E '^MCSECRETARY_API_SECRET=' "$ENV_FILE" | cut -d'=' -f2 | tr -d '"' | tr -d "'")
fi

if [ -z "$API_SECRET" ]; then
  echo "ERROR: MCSECRETARY_API_SECRET not found in $ENV_FILE"
  echo "Add it to .env: MCSECRETARY_API_SECRET=your_secret_here"
  exit 1
fi

# Unload existing agent if running
launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || true

# Copy and patch the plist with the real secret
cp "$PLIST_SRC" "$PLIST_DST"
sed -i '' "s|SET_VIA_INSTALL_SCRIPT|$API_SECRET|" "$PLIST_DST"

echo "Installed plist to $PLIST_DST"

# Load the agent
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
echo "SMS reader agent loaded."

# Verify
if launchctl list | grep -q "com.mcsecretary.sms-reader"; then
  echo "SUCCESS: SMS reader is running."
else
  echo "WARNING: Agent loaded but not found in launchctl list."
fi
