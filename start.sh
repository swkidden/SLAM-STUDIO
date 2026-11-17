#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export PATH="$PWD/.tools/node-v22.15.0-linux-x64/bin:/usr/bin:/bin:/usr/local/bin:$PATH"
if [[ ! -d node_modules ]]; then npm install; fi
npm run build
if [[ -f /opt/ros/noetic/setup.bash ]]; then
    set +u
    source /opt/ros/noetic/setup.bash
    set -u
fi
exec /usr/bin/python3 server.py --port "${VIO_STUDIO_PORT:-8765}"
