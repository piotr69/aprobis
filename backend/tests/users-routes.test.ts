import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, patchUserSchema, userSchema } from "../src/modules/users/users.routes.js";

const validUser = {
  email: "nowy@aprobis.local",
  firstName: "Nowy",
  lastName: "Użytkownik",
  role: "EMPLOYEE"
};

const tooShort = "a".repeat(MIN_PASSWORD_LENGTH - 1);
const longEnough = "a".repeat(MIN_PASSWORD_LENGTH);

describe("polityka haseł", () => {
  it("zakładanie konta wymaga hasła o minimalnej długości", () => {
    expect(userSchema.safeParse({ ...validUser, password: tooShort }).success).toBe(false);
    expect(userSchema.safeParse({ ...validUser, password: longEnough }).success).toBe(true);
  });

  it("edycja konta stosuje ten sam próg co zakładanie", () => {
    // Wcześniej edycja dopuszczała 8 znaków, czyli dowolne konto dało się obniżyć
    // poniżej polityki obowiązującej przy zakładaniu.
    expect(patchUserSchema.safeParse({ password: tooShort }).success).toBe(false);
    expect(patchUserSchema.safeParse({ password: longEnough }).success).toBe(true);
  });

  it("edycja bez zmiany hasła nadal przechodzi", () => {
    expect(patchUserSchema.safeParse({ firstName: "Anna" }).success).toBe(true);
  });

  it("komunikat mówi, ile znaków jest wymaganych", () => {
    const result = userSchema.safeParse({ ...validUser, password: tooShort });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain(String(MIN_PASSWORD_LENGTH));
    }
  });
});
