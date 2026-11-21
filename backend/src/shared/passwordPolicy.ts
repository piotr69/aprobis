import { z } from "zod";

/** Jedna polityka haseł dla zakładania kont, edycji, resetu i pierwszego administratora. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

export const passwordSchema = z.string()
  .min(MIN_PASSWORD_LENGTH, `Hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków`)
  .max(MAX_PASSWORD_LENGTH, `Hasło może mieć najwyżej ${MAX_PASSWORD_LENGTH} znaków`);

/** Login i e-mail są wymienne przy logowaniu, więc login nie może wyglądać jak adres. */
export const loginSchema = z.string().trim().max(60).regex(/^[^@\s]*$/, "Login nie może zawierać znaku @ ani spacji");
