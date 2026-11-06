#!/bin/bash
# Выпуск новой версии в рабочую копию: /Applications/Pomodoro.app
#
# 1. Собирает рабочую версию.
# 2. Делает резервную копию реальных данных в backups/release-<время>.
# 3. Останавливает запущенный Pomodoro, ставит новую версию, запускает её.
#
# Данные (~/Library/Application Support/Pomodoro) при этом не удаляются и не перезаписываются.
set -euo pipefail
cd "$(dirname "$0")"

DATA="$HOME/Library/Application Support/Pomodoro"
DEST="/Applications/Pomodoro.app"

./build.sh prod

if [ -d "$DATA" ]; then
  B="$DATA/backups/release-$(date +%Y-%m-%d_%H%M%S)"
  mkdir -p "$B"
  for f in data.json screentime.json; do
    [ -f "$DATA/$f" ] && cp "$DATA/$f" "$B/$f"
  done
  echo "→ резервная копия данных: $B"
fi

# останавливаем рабочий сервер, если он запущен
if curl -s -m 1 http://127.0.0.1:47321/api/ping | grep -q pomodoro; then
  echo "→ останавливаю запущенный Pomodoro"
  curl -s -m 2 -X POST http://127.0.0.1:47321/api/quit >/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -s -m 1 http://127.0.0.1:47321/api/ping >/dev/null 2>&1 || break
    sleep 0.3
  done
fi
pkill -f "/Pomodoro.app/Contents/MacOS/pomodoro" 2>/dev/null || true

rm -rf "$DEST"
cp -R "build/Pomodoro.app" "$DEST"
rm -rf "build/Pomodoro.app"
echo "→ установлено: $DEST"

open "$DEST"
echo "✓ рабочая версия обновлена"
