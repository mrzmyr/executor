const encryptedPrefix = "enc:v1:";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type EncryptionKeyEntry = {
  keyVersion: string;
  passphrase: string;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const normalizeKeyVersion = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "v1";
};

const parseEncryptionKeyEntries = (): Array<EncryptionKeyEntry> => {
  const configured = process.env.CREDENTIAL_ENCRYPTION_KEYS?.trim() ?? "";
  if (configured.length > 0) {
    const entries = configured
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .flatMap((part) => {
        const separatorIndex = part.indexOf("=") >= 0
          ? part.indexOf("=")
          : part.indexOf(":");
        if (separatorIndex <= 0) {
          return [];
        }

        const keyVersion = normalizeKeyVersion(part.slice(0, separatorIndex));
        const passphrase = part.slice(separatorIndex + 1).trim();
        if (passphrase.length === 0) {
          return [];
        }

        return [{ keyVersion, passphrase }];
      });

    if (entries.length > 0) {
      return entries;
    }
  }

  const fallback = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim() ?? "";
  if (fallback.length === 0) {
    throw new Error(
      "Encrypted credential storage requires CREDENTIAL_ENCRYPTION_KEY or CREDENTIAL_ENCRYPTION_KEYS",
    );
  }

  return [{ keyVersion: "v1", passphrase: fallback }];
};

const resolveEncryptionKeyEntries = (): Array<EncryptionKeyEntry> =>
  parseEncryptionKeyEntries();

const keyCache = new Map<string, Promise<CryptoKey>>();

const deriveAesKey = async (passphrase: string): Promise<CryptoKey> => {
  const cacheKey = passphrase;
  const existing = keyCache.get(cacheKey);
  if (existing) {
    return await existing;
  }

  const keyPromise = (async () => {
    const passphraseBytes = encoder.encode(passphrase);
    const hashBuffer = await crypto.subtle.digest("SHA-256", passphraseBytes);
    return await crypto.subtle.importKey(
      "raw",
      hashBuffer,
      {
        name: "AES-GCM",
      },
      false,
      ["encrypt", "decrypt"],
    );
  })();

  keyCache.set(cacheKey, keyPromise);
  return await keyPromise;
};

const parseEncryptedValue = (
  value: string,
): { keyVersion: string | null; iv: Uint8Array; cipher: Uint8Array } | null => {
  if (!value.startsWith(encryptedPrefix)) {
    return null;
  }

  const payload = value.slice(encryptedPrefix.length);
  const parts = payload.split(":");

  try {
    if (parts.length === 2) {
      return {
        keyVersion: null,
        iv: base64ToBytes(parts[0] ?? ""),
        cipher: base64ToBytes(parts[1] ?? ""),
      };
    }

    if (parts.length === 3) {
      return {
        keyVersion: normalizeKeyVersion(parts[0] ?? ""),
        iv: base64ToBytes(parts[1] ?? ""),
        cipher: base64ToBytes(parts[2] ?? ""),
      };
    }

    return null;
  } catch {
    return null;
  }
};

const resolveKeyEntryForDecrypt = (
  keyVersion: string | null,
): EncryptionKeyEntry => {
  const entries = resolveEncryptionKeyEntries();

  if (!keyVersion) {
    return entries[0]!;
  }

  const matched = entries.find((entry) => entry.keyVersion === keyVersion);
  if (matched) {
    return matched;
  }

  throw new Error(`Credential encryption key version is not configured: ${keyVersion}`);
};

export const currentCredentialEncryptionKeyVersion = (): string =>
  resolveEncryptionKeyEntries()[0]!.keyVersion;

export const isEncryptedSecret = (value: string): boolean =>
  value.startsWith(encryptedPrefix);

export const encryptSecretValue = async (plainText: string): Promise<string> => {
  const activeKey = resolveEncryptionKeyEntries()[0]!;
  const key = await deriveAesKey(activeKey.passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    encoder.encode(plainText),
  );

  return `${encryptedPrefix}${activeKey.keyVersion}:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(encrypted))}`;
};

export const decryptSecretValue = async (storedValue: string): Promise<string> => {
  const parsed = parseEncryptedValue(storedValue);
  if (parsed === null) {
    throw new Error("Credential secret is not encrypted");
  }

  const keyEntry = resolveKeyEntryForDecrypt(parsed.keyVersion);
  const key = await deriveAesKey(keyEntry.passphrase);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: parsed.iv as unknown as BufferSource,
    },
    key,
    parsed.cipher as unknown as BufferSource,
  );

  return decoder.decode(decrypted);
};
