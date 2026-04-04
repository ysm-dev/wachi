#!/usr/bin/env sh
set -eu

REPO="ysm-dev/wachi"
VERSION="latest"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

case "$OS" in
  darwin) TARGET="darwin-$ARCH" ;;
  linux) TARGET="linux-$ARCH" ;;
  *)
    echo "Unsupported OS for install.sh: $OS" >&2
    echo "Use install.ps1 on Windows." >&2
    exit 1
    ;;
esac

ASSET="wachi-$TARGET"
URL="https://github.com/$REPO/releases/$VERSION/download/$ASSET"

INSTALL_DIR="${HOME}/.local/bin"
mkdir -p "$INSTALL_DIR"

DEST="$INSTALL_DIR/wachi"

echo "Downloading $URL"
curl -fsSL "$URL" -o "$DEST"
chmod +x "$DEST"

echo "Installed wachi to $DEST"
echo "Ensure $INSTALL_DIR is on your PATH"
