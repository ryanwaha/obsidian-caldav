const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32，小寫

/** sha256(UID 的 UTF-8) 前 40 bits → 8 個 Crockford base32 字元（設計稿 §6.2）。 */
export async function shortId(uid: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uid)));
  let bits = 0n;
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(digest[i]);
  let out = "";
  for (let i = 7; i >= 0; i--) out += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return out;
}
