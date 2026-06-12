#!/bin/bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"

if [[ ! -f .env ]]; then
  printf '%s\n' ".env가 없습니다. npm run auth:setup과 Telegram 설정을 먼저 완료하세요." >&2
  exit 1
fi

if [[ "$(stat -f '%Lp' .env)" != "600" ]]; then
  printf '%s\n' ".env 권한은 0600이어야 합니다. chmod 600 .env를 실행하세요." >&2
  exit 1
fi

exec "$(command -v node)" dist/index.js
