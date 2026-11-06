#!/bin/bash
# Создаёт локальный сертификат подписи «Pomodoro Local Signing» в связке ключей (login keychain).
#
# Зачем: macOS выдаёт «Полный доступ к диску» конкретной подписи приложения.
# Без постоянного сертификата каждая пересборка считается новым приложением,
# и доступ (нужен для экранного времени iPhone) приходится выдавать заново.
#
# Сертификат самоподписанный, работает только на этом Маке и годится только для подписи кода.
# Удалить: Keychain Access → поиск «Pomodoro Local Signing» → удалить сертификат и ключ.
set -euo pipefail

NAME="Pomodoro Local Signing"
if security find-identity -p codesigning 2>/dev/null | grep -q "\"$NAME\""; then
  echo "✓ сертификат «$NAME» уже есть"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

cat > ext.cnf <<EOF
[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=$NAME
[v3]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
EOF

/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 -config ext.cnf >/dev/null 2>&1
PASS="$(LC_ALL=C tr -dc A-Za-z0-9 </dev/urandom | head -c 24)"
/usr/bin/openssl pkcs12 -export -inkey key.pem -in cert.pem -out cert.p12 -passout "pass:$PASS" -name "$NAME" >/dev/null 2>&1
security import cert.p12 -k "$HOME/Library/Keychains/login.keychain-db" -P "$PASS" -T /usr/bin/codesign >/dev/null
echo "✓ сертификат «$NAME» создан — теперь пересобери приложение"
