import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  HELDOUT_PACK_SCHEMA_VERSION,
  type HeldoutCasePublicDescriptor,
  type HeldoutSandboxCase,
  type SealedHeldoutPack,
} from "./types";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function decodeKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) {
    throw new Error("LAB_HELDOUT_KEY must be a base64-encoded 32-byte key.");
  }
  return key;
}

function publicDescriptor(entry: HeldoutSandboxCase): HeldoutCasePublicDescriptor {
  return {
    opaqueId: entry.opaqueId,
    family: entry.family,
    dimensions: [...entry.dimensions].sort(),
    qualitative: entry.qualitative,
  };
}

function validateCases(cases: HeldoutSandboxCase[]): void {
  if (cases.length === 0) throw new Error("A held-out pack requires at least one case.");
  const ids = new Set<string>();
  for (const entry of cases) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.opaqueId)) {
      throw new Error(`Held-out case ID ${JSON.stringify(entry.opaqueId)} is unsafe.`);
    }
    if (ids.has(entry.opaqueId)) {
      throw new Error(`Held-out case ID ${JSON.stringify(entry.opaqueId)} is duplicated.`);
    }
    ids.add(entry.opaqueId);
    if (entry.dimensions.length === 0) {
      throw new Error(`Held-out case ${JSON.stringify(entry.opaqueId)} has no dimensions.`);
    }
  }
}

export function createHeldoutKey(): string {
  return randomBytes(32).toString("base64");
}

export function sealHeldoutCases(
  packId: string,
  cases: HeldoutSandboxCase[],
  encodedKey: string,
  createIv: () => Buffer = () => randomBytes(12),
): SealedHeldoutPack {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packId)) {
    throw new Error("Held-out pack ID contains unsafe path characters.");
  }
  validateCases(cases);
  const key = decodeKey(encodedKey);
  const plaintext = canonical(cases);
  const iv = createIv();
  if (iv.length !== 12) throw new Error("Held-out AES-GCM IV must contain 12 bytes.");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    manifest: {
      schemaVersion: HELDOUT_PACK_SCHEMA_VERSION,
      kind: "sealed-heldout-pack",
      packId,
      caseCount: cases.length,
      cases: cases.map(publicDescriptor).sort((left, right) =>
        left.opaqueId.localeCompare(right.opaqueId)),
      payloadSha256: sha256(plaintext),
    },
    encryption: {
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    },
  };
}

export function openHeldoutPack(
  pack: SealedHeldoutPack,
  encodedKey: string,
): HeldoutSandboxCase[] {
  if (pack.manifest.schemaVersion !== HELDOUT_PACK_SCHEMA_VERSION) {
    throw new Error(`Unsupported held-out pack schema ${pack.manifest.schemaVersion}.`);
  }
  const key = decodeKey(encodedKey);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(pack.encryption.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(pack.encryption.authTag, "base64"));
  let plaintext: string;
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(pack.encryption.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Held-out pack authentication failed.");
  }
  if (sha256(plaintext) !== pack.manifest.payloadSha256) {
    throw new Error("Held-out pack payload hash does not match its public manifest.");
  }
  const cases = JSON.parse(plaintext) as HeldoutSandboxCase[];
  validateCases(cases);
  const descriptors = cases.map(publicDescriptor).sort((left, right) =>
    left.opaqueId.localeCompare(right.opaqueId));
  if (canonical(descriptors) !== canonical(pack.manifest.cases) ||
      cases.length !== pack.manifest.caseCount) {
    throw new Error("Held-out case descriptors do not match the public manifest.");
  }
  return cases;
}

export function publicHeldoutView(pack: SealedHeldoutPack): SealedHeldoutPack["manifest"] {
  return structuredClone(pack.manifest);
}

export function sealHeldoutEvidence(value: unknown, encodedKey: string): string {
  const key = decodeKey(encodedKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(canonical(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.from(JSON.stringify({
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }), "utf8").toString("base64");
}

export function openHeldoutEvidence<T>(sealed: string, encodedKey: string): T {
  const envelope = JSON.parse(Buffer.from(sealed, "base64").toString("utf8")) as {
    algorithm: string;
    iv: string;
    authTag: string;
    ciphertext: string;
  };
  if (envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported held-out evidence encryption algorithm.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    decodeKey(encodedKey),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  try {
    return JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8")) as T;
  } catch {
    throw new Error("Held-out evidence authentication failed.");
  }
}
