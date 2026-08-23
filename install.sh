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
CHECKSUM_URL="$URL.sha256"

INSTALL_DIR="${HOME}/.local/bin"
mkdir -p "$INSTALL_DIR"

DEST="$INSTALL_DIR/wachi"
TEMP="$(mktemp "$INSTALL_DIR/.wachi.XXXXXX")"
CHECKSUM_TEMP="$TEMP.sha256"
trap 'rm -f "$TEMP" "$CHECKSUM_TEMP"' EXIT HUP INT TERM

echo "Downloading $URL"
curl -fsSL "$URL" -o "$TEMP"
if curl -fsSL "$CHECKSUM_URL" -o "$CHECKSUM_TEMP"; then
  EXPECTED="$(tr -d '[:space:]' < "$CHECKSUM_TEMP")"
else
  # v0.6.0 predates checksum sidecars. Keep its GitHub-published asset digests
  # as a compatibility bridge until a release with sidecars is available.
  case "$ASSET" in
    wachi-darwin-arm64) EXPECTED="6ddd179e4f4c988b9f54f03be6cf52175318cb4eceb987db4ce5f642e727c3a5" ;;
    wachi-darwin-x64) EXPECTED="0df250c204475b1bb70c870378533e79e51289fcc78beea5c3095472d867f782" ;;
    wachi-linux-arm64) EXPECTED="ce95b77d7ca1c8db5c0fbac2dfc37365ddb8a171ae870678e1a5b1402394b5b1" ;;
    wachi-linux-x64) EXPECTED="bd75ea5ae655ba5a0a5a71db6921d907cd3cfd48685b0ace1b15a93fdb7160ec" ;;
  esac
fi
case "$EXPECTED" in
  *[!0-9a-fA-F]*|'')
    echo "Release checksum is invalid; keeping the existing installation." >&2
    exit 1
    ;;
esac
if [ "${#EXPECTED}" -ne 64 ]; then
  echo "Release checksum is invalid; keeping the existing installation." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TEMP" | cut -d ' ' -f 1)"
else
  ACTUAL="$(shasum -a 256 "$TEMP" | cut -d ' ' -f 1)"
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "Downloaded file failed SHA-256 verification; keeping the existing installation." >&2
  exit 1
fi
chmod +x "$TEMP"
if ! WACHI_NO_AUTO_UPDATE=1 "$TEMP" version >/dev/null 2>&1; then
  echo "Downloaded file is not a working wachi binary; keeping the existing installation." >&2
  exit 1
fi
mv -f "$TEMP" "$DEST"
rm -f "$CHECKSUM_TEMP"
trap - EXIT HUP INT TERM

echo "Installed wachi to $DEST"
echo "Ensure $INSTALL_DIR is on your PATH"
