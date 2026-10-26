import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";

export function localAddresses() {
  const result = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (
        entry.family !== "IPv4" ||
        entry.internal ||
        /^(utun|tun|bridge|awdl|llw)/.test(name)
      )
        continue;
      const ip = entry.address;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip))
        result.push({ name, ip });
    }
  }
  return result.sort((a, b) =>
    a.name === "en0" ? -1 : b.name === "en0" ? 1 : 0,
  );
}

export function ensureCertificate(directory, addresses) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyFile = path.join(directory, "tls-key.pem");
  const certFile = path.join(directory, "tls-cert.pem");
  const ips = [
    ...new Set([
      "127.0.0.1",
      ...addresses.map((value) =>
        typeof value === "string" ? value : value.ip,
      ),
    ]),
  ];
  let existing;
  try {
    existing = new X509Certificate(fs.readFileSync(certFile));
  } catch {}
  if (
    !existing ||
    new Date(existing.validTo).getTime() < Date.now() + 86400000 ||
    !ips.every((ip) => existing.checkIP(ip)) ||
    !fs.existsSync(keyFile)
  ) {
    const config = path.join(directory, "openssl.cnf");
    fs.writeFileSync(
      config,
      `[req]\nprompt = no\ndistinguished_name = dn\nx509_extensions = ext\n[dn]\nCN = NearBridge Local\n[ext]\nbasicConstraints = critical, CA:FALSE\nkeyUsage = critical, digitalSignature, keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectAltName = @alt\n[alt]\nDNS.1 = localhost\n${ips.map((ip, i) => `IP.${i + 1} = ${ip}`).join("\n")}\n`,
      { mode: 0o600 },
    );
    execFileSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "365",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-config",
        config,
      ],
      { stdio: "pipe" },
    );
    fs.chmodSync(keyFile, 0o600);
    fs.rmSync(config);
  }
  const cert = fs.readFileSync(certFile);
  return {
    key: fs.readFileSync(keyFile),
    cert,
    fingerprint: new X509Certificate(cert).fingerprint256,
  };
}

// Native clients trust this private CA from the pairing QR and pin the leaf
// public key. Renewing an IP-address certificate therefore preserves pairing.
export function ensureNativeCertificate(directory, addresses) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const rootKey = path.join(directory, "root-key.pem");
  const rootCert = path.join(directory, "root-cert.pem");
  const key = path.join(directory, "server-key.pem");
  const cert = path.join(directory, "server-cert.pem");
  const run = (args) =>
    execFileSync("/usr/bin/openssl", args, { stdio: "pipe" });
  if (!fs.existsSync(rootKey) || !fs.existsSync(rootCert)) {
    const config = path.join(directory, "root.cnf");
    fs.writeFileSync(
      config,
      "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=NearBridge Private Root\n[ext]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n",
      { mode: 0o600 },
    );
    run([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "3650",
      "-keyout",
      rootKey,
      "-out",
      rootCert,
      "-config",
      config,
    ]);
    fs.chmodSync(rootKey, 0o600);
    fs.rmSync(config);
  }
  if (!fs.existsSync(key)) {
    run(["genrsa", "-out", key, "2048"]);
    fs.chmodSync(key, 0o600);
  }
  const ips = [
    ...new Set([
      "127.0.0.1",
      ...addresses.map((value) =>
        typeof value === "string" ? value : value.ip,
      ),
    ]),
  ];
  let existing;
  try {
    existing = new X509Certificate(fs.readFileSync(cert));
  } catch {}
  if (
    !existing ||
    !ips.every((ip) => existing.checkIP(ip)) ||
    new Date(existing.validTo).getTime() < Date.now() + 86400000
  ) {
    const csr = path.join(directory, "server.csr");
    const ext = path.join(directory, "server.ext");
    run([
      "req",
      "-new",
      "-key",
      key,
      "-out",
      csr,
      "-subj",
      "/CN=NearBridge Native",
    ]);
    fs.writeFileSync(
      ext,
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,${ips.map((ip) => `IP:${ip}`).join(",")}\n`,
      { mode: 0o600 },
    );
    run([
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      rootCert,
      "-CAkey",
      rootKey,
      "-CAcreateserial",
      "-out",
      cert,
      "-days",
      "365",
      "-sha256",
      "-extfile",
      ext,
    ]);
    fs.rmSync(csr);
    fs.rmSync(ext);
  }
  return {
    key: fs.readFileSync(key),
    cert: fs.readFileSync(cert),
    ca: fs.readFileSync(rootCert),
  };
}
