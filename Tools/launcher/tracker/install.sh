set -euo pipefail

INSTALL_PREFIX="${INSTALL_PREFIX:-/opt/opentracker}"
BUILD_DIR="$(mktemp -d)"
trap "rm -rf $BUILD_DIR" EXIT

echo "=== Installing build deps ==="
sudo apt-get update
sudo apt-get install -y build-essential cvs zlib1g-dev

echo "=== Fetching libowfat ==="
cd "$BUILD_DIR"
cvs -d :pserver:cvs@cvs.fefe.de:/cvs -z9 co libowfat
cd libowfat
make

echo "=== Fetching opentracker ==="
cd "$BUILD_DIR"
cvs -d :pserver:anoncvs@cvs.fefe.de:/cvs -z9 co opentracker
cd opentracker
make FEATURES='-DWANT_V6 -DWANT_FULLSCRAPE'

echo "=== Installing to $INSTALL_PREFIX ==="
sudo mkdir -p "$INSTALL_PREFIX/bin"
sudo cp opentracker "$INSTALL_PREFIX/bin/"
sudo cp opentracker.conf.sample "$INSTALL_PREFIX/opentracker.conf" || true
sudo useradd --system --home "$INSTALL_PREFIX" --shell /usr/sbin/nologin opentracker 2>/dev/null || true
sudo chown -R opentracker:opentracker "$INSTALL_PREFIX"

echo "=== Installing systemd unit ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sudo cp "$SCRIPT_DIR/opentracker.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable opentracker
sudo systemctl start opentracker

echo
echo "Done. Check status:"
echo "  sudo systemctl status opentracker"
echo "  curl http://127.0.0.1:6969/stats?mode=tpbs"
echo
echo "Don't forget to open port 6969/tcp + 6969/udp on your VPS firewall."
