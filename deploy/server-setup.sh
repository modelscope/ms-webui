#!/bin/bash
# One-time host provisioning for the managed ms-webui deployment.
# Target: a GPU-less Linux host (training drives a remote twinkle-server, so CPU torch suffices).
# Layout produced:
#   /opt/ms-webui/          webui source tree (rsync'd by CI; see deploy.sh)
#   /opt/swift-venv/         python 3.12 venv with the swift v5 stack (editable installs)
#   /opt/src/ms-swift[/twinkle]   source checkouts the venv installs point at
#   systemd unit ms-webui.service (see ms-webui.service in this directory)
#
# Re-run safety: steps are idempotent (installs guarded, venv/clone reuse existing paths).
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq nodejs npm git rsync curl build-essential
node -v

# Python 3.12 via uv (recent distro pythons can be newer than the swift stack supports)
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="/root/.local/bin:$PATH"
uv python install 3.12
[ -d /opt/swift-venv ] || uv venv --seed /opt/swift-venv --python 3.12
export VIRTUAL_ENV=/opt/swift-venv
export PATH="/opt/swift-venv/bin:$PATH"

# Sources: the public dev-swift-v5 branches, same layout as the dev machine (twinkle nested in ms-swift)
mkdir -p /opt/src
[ -d /opt/src/ms-swift ] || git clone --depth 1 -b dev-swift-v5 https://github.com/modelscope/ms-swift.git /opt/src/ms-swift
[ -d /opt/src/ms-swift/twinkle ] || git clone --depth 1 -b dev-swift-v5 https://github.com/modelscope/twinkle.git /opt/src/ms-swift/twinkle

# CPU torch first so the editable installs do not pull the CUDA build
pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
pip install --no-cache-dir -e /opt/src/ms-swift/twinkle
pip install --no-cache-dir -e /opt/src/ms-swift
pip install --no-cache-dir tinker==0.16.1

python -c "import swift, twinkle, torch; print('stack ok')"

# Service (installs the unit shipped next to this script)
mkdir -p /opt/ms-webui
cp "$(dirname "$0")/ms-webui.service" /etc/systemd/system/ms-webui.service
systemctl daemon-reload
systemctl enable ms-webui
echo SETUP_DONE
