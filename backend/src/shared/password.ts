import argon2 from "argon2";

const argonOptions = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1
} as const;

export function hashPassword(password: string) {
  return argon2.hash(password, argonOptions);
}

/** Skrót w innym formacie niż argon2 nie przechodzi: program przechowuje tylko argon2id. */
export async function verifyPassword(hash: string, password: string) {
  if (!hash.startsWith("$argon2")) return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// Liczony raz na proces, z tymi samymi parametrami kosztu co hasła kont.
let dummyHash: Promise<string> | null = null;

/** Porównanie bez skutku przy nieznanym koncie: wyrównuje koszt weryfikacji z kontem istniejącym. */
export async function verifyAgainstDummy(password: string) {
  dummyHash ??= hashPassword("::aprobis-dummy::");
  await argon2.verify(await dummyHash, password);
  return false;
}
