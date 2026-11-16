#!/usr/bin/env bash
# Regenerates the TEST-ONLY certificates in this folder.
set -euo pipefail
cd "$(dirname "$0")"
rm -f ca.pem ca-key.pem server.pem server-key.pem other-ca.pem other-ca-key.pem

openssl req -x509 -newkey rsa:2048 -nodes -days 36500 -subj "/CN=CommyPanel test CA (TEST ONLY)" \
  -keyout ca-key.pem -out ca.pem 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 36500 -subj "/CN=Some other CA (TEST ONLY)" \
  -keyout other-ca-key.pem -out other-ca.pem 2>/dev/null

openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout server-key.pem -out server.csr 2>/dev/null
cat > server.ext <<'EXT'
subjectAltName = DNS:localhost, IP:127.0.0.1
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
EXT
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 36500 -extfile server.ext \
  -out server.pem 2>/dev/null
rm -f server.csr server.ext ca.srl other-ca-key.pem
echo "Regenerated the test certificates."
