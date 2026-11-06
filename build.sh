#!/bin/bash
# Сборка Pomodoro (macOS).
#
#   ./build.sh          — версия для разработки: build/Pomodoro Dev.app
#                         (порт 47322, данные в ~/Library/Application Support/Pomodoro Dev)
#   ./build.sh prod     — рабочая версия: build/Pomodoro.app
#                         (порт 47321, реальные данные). Устанавливается через ./release.sh
set -euo pipefail
cd "$(dirname "$0")"

CHANNEL="${1:-dev}"
VERSION="$(date +%Y.%m.%d-%H%M)"
if [ "$CHANNEL" = "prod" ]; then
  NAME="Pomodoro"; BUNDLE_ID="local.pomodoro.timer"; ICON_VARIANT=""
else
  CHANNEL="dev"; NAME="Pomodoro Dev"; BUNDLE_ID="local.pomodoro.timer.dev"; ICON_VARIANT="dev"
fi
APP="build/$NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "→ сборка бинаря ($CHANNEL, $VERSION)"
LDFLAGS="-s -w -X main.channel=$CHANNEL -X main.version=$VERSION"
GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="$LDFLAGS" -o build/pomodoro-arm64 .
GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags="$LDFLAGS" -o build/pomodoro-amd64 .
lipo -create -output "$APP/Contents/MacOS/pomodoro" build/pomodoro-arm64 build/pomodoro-amd64
rm build/pomodoro-arm64 build/pomodoro-amd64

echo "→ иконка"
ICONSET="build/Pomodoro.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
go build -o build/icongen ./tools/icon
for s in 16 32 128 256 512; do
  ICON_VARIANT="$ICON_VARIANT" ./build/icongen $s "$ICONSET/icon_${s}x${s}.png"
  ICON_VARIANT="$ICON_VARIANT" ./build/icongen $((s*2)) "$ICONSET/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Pomodoro.icns"
rm -rf "$ICONSET" build/icongen

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>pomodoro</string>
  <key>CFBundleIconFile</key><string>Pomodoro</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <!-- фоновое приложение: без иконки в Dock, интерфейс открывается в браузере -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Подпись: локальный сертификат «Pomodoro Local Signing», если он есть в связке ключей.
# С ним macOS узнаёт приложение после пересборки и не сбрасывает «Полный доступ к диску».
SIGN_ID=$(security find-identity -p codesigning 2>/dev/null | awk '/"Pomodoro Local Signing"/ {print $2; exit}')
if [ -n "$SIGN_ID" ]; then
  codesign --force --deep -s "$SIGN_ID" "$APP" >/dev/null 2>&1
  echo "→ подписано сертификатом Pomodoro Local Signing"
else
  codesign --force --deep -s - "$APP" >/dev/null 2>&1 || true
  echo "→ временная подпись (доступ к диску будет сбрасываться при пересборке)"
fi
echo "✓ готово: $APP"
