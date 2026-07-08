#!/bin/bash
# Claude Code integration installer shim.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

exec bash "$SCRIPT_DIR/integrations/claude-code/install.sh" "$@"
