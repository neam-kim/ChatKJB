#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v claude >/dev/null 2>&1; then
  printf '%s\n' "Claude Code CLI를 찾을 수 없습니다."
  exit 1
fi

printf '%s\n' \
  "Claude OAuth 인증을 시작합니다." \
  "브라우저 인증 후 터미널에 출력되는 sk-ant-oat01-... 토큰을 복사하세요." \
  ""

claude setup-token

printf '\nOAuth 토큰을 붙여넣으세요: '
IFS= read -r -s token
printf '\n'

if [[ ! "$token" =~ ^sk-ant-oat01-[A-Za-z0-9_-]+$ ]]; then
  printf '%s\n' "유효한 setup-token 형식이 아닙니다."
  exit 1
fi

env_file=".env"
temp_file="$(mktemp "${TMPDIR:-/tmp}/telegram-claude-env.XXXXXX")"
trap 'rm -f "$temp_file"' EXIT

if [[ -f "$env_file" ]]; then
  awk '!/^CLAUDE_CODE_OAUTH_TOKEN=/' "$env_file" > "$temp_file"
else
  cp .env.example "$temp_file"
  awk '!/^CLAUDE_CODE_OAUTH_TOKEN=/' "$temp_file" > "${temp_file}.clean"
  mv "${temp_file}.clean" "$temp_file"
fi

printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$token" >> "$temp_file"
chmod 600 "$temp_file"
mv "$temp_file" "$env_file"
chmod 600 "$env_file"
trap - EXIT

unset token
printf '%s\n' "OAuth 토큰을 .env에 저장했고 권한을 0600으로 제한했습니다."
