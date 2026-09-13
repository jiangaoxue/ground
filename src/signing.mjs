// ============================================================
// signing.mjs — Ed25519 signatures over every receipt.
//
// Why: half the field signs its deliverables (Veritas, Yuzu, Witness,
// TrustSieve). An unsigned receipt is a promise; a signed one is a
// fact a third party can check offline with our public key at /pubkey.
//
// What is signed: the canonical JSON of the receipt payload (every
// field except the signature block itself), with object keys sorted —
// so verification does not depend on key order or whitespace.
// The signature travels INSIDE the packed receipt URL, so it is
// self-contained like everything else we ship.
// ============================================================

import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, createPublicKey, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEYFILE = fileURLToPath(new URL("../.signing_key.json", import.meta.url));

let _keys = null;

function loadKeys() {
  if (_keys) return _keys;
  try {
    const j = JSON.parse(readFileSync(KEYFILE, "utf8"));
    if (j?.private_key_pem && j?.public_key_b64) {
      _keys = j;
      return _keys;
    }
  } catch {
    /* generate below */
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubRaw = publicKey.export({ type: "spki", format: "der" });
  _keys = {
    key_id: createHash("sha256").update(pubRaw).digest("hex").slice(0, 16),
    private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }),
    public_key_b64: pubRaw.toString("base64"),
    created_at: new Date().toISOString(),
  };
  try {
    writeFileSync(KEYFILE, JSON.stringify(_keys, null, 1));
  } catch {
    /* read-only deploy: keys stay in-process; /pubkey still serves them */
  }
  return _keys;
}

/** Order-independent canonical JSON: sorted keys, no whitespace. */
export function canon(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(",")}}`;
}

/** Signature block to embed in the payload. Sign over everything else. */
export function signPayload(payload) {
  const keys = loadKeys();
  const data = Buffer.from(canon(payload), "utf8");
  return {
    signature: {
      alg: "ed25519",
      key_id: keys.key_id,
      public_key: keys.public_key_b64,
      sig: cryptoSign(null, data, keys.private_key_pem).toString("base64"),
      covers: "canonical JSON of this receipt minus the signature block",
    },
  };
}

/** Verify a payload that carries a signature block. True only if the
 *  canonical form matches and the signature validates. */
export function verifyPayload(payload) {
  try {
    const sig = payload?.signature;
    if (!sig || sig.alg !== "ed25519" || !sig.public_key || !sig.sig) return false;
    const rest = { ...payload };
    delete rest.signature;
    const data = Buffer.from(canon(rest), "utf8");
    const key = createPublicKey({ key: Buffer.from(sig.public_key, "base64"), format: "der", type: "spki" });
    return cryptoVerify(null, data, key, Buffer.from(sig.sig, "base64"));
  } catch {
    return false;
  }
}

export function publicKeyInfo() {
  const keys = loadKeys();
  return {
    alg: "ed25519",
    key_id: keys.key_id,
    public_key: keys.public_key_b64,
    format: "base64 SPKI (der)",
    note: "Verify any Ground receipt offline: canon(receipt minus .signature), ed25519-verify with this key against receipt.signature.sig. Or just use GET /verify?d=<receipt>, which does it for you and names each check.",
    created_at: keys.created_at,
  };
}
