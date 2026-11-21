import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { writeAuditInTransaction } from "./audit.js";
import { SystemRole } from "./domain.js";
import { hashPassword } from "./password.js";
import { loginSchema, passwordSchema } from "./passwordPolicy.js";

/**
 * Pierwszy administrator nowej instalacji. Bez publicznego endpointu: wołają go tylko CLI i instalatory.
 * Ponowne uruchomienie niczego nie zmienia (nie resetuje hasła), więc instalator i Docker mogą je powtarzać.
 */
export const adminInputSchema = z.object({
  email: z.string().trim().email("Podaj poprawny adres e-mail"),
  login: loginSchema.optional().transform((value) => value || null),
  password: passwordSchema,
  firstName: z.string().trim().min(1, "Podaj imię").max(100),
  lastName: z.string().trim().min(1, "Podaj nazwisko").max(100)
});

export type AdminInput = z.input<typeof adminInputSchema>;

export type BootstrapAdminResult =
  | { result: "CREATED"; userId: string }
  | { result: "ALREADY_INITIALIZED" };

/** Konta są, ale żadne nie jest aktywnym administratorem: tego nie naprawiamy automatycznie. */
export class AdminBootstrapError extends Error {}

export async function bootstrapAdmin(prisma: PrismaClient, rawInput: AdminInput): Promise<BootstrapAdminResult> {
  const input = adminInputSchema.parse(rawInput);
  // Kosztowny skrót poza transakcją, żeby nie trzymać blokad.
  const passwordHash = await hashPassword(input.password);

  try {
    return await prisma.$transaction(async (tx) => {
      // Blokada aplikacyjna: dwa równoległe uruchomienia (np. ponowiony kontener) nie utworzą dwóch kont.
      // sp_getapplock nie rzuca błędu przy timeoucie/deadlocku, tylko zwraca ujemny kod — zamieniamy go na wyjątek.
      await tx.$executeRaw`
        DECLARE @res INT;
        EXEC @res = sp_getapplock @Resource = N'aprobis:bootstrap-admin', @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 30000;
        IF @res < 0 THROW 50001, N'Nie udało się uzyskać blokady inicjalizacji administratora', 1;`;

      const activeAdmin = await tx.user.findFirst({ where: { role: SystemRole.SYSTEM_ADMIN, isActive: true }, select: { id: true } });
      if (activeAdmin) return { result: "ALREADY_INITIALIZED" } as const;

      const anyUser = await tx.user.count();
      if (anyUser > 0) {
        throw new AdminBootstrapError(
          "W bazie są konta, ale żadne nie jest aktywnym administratorem. Pierwszego administratora nie tworzę automatycznie: przywróć dostęp ręcznie (np. aktywuj istniejące konto w bazie)."
        );
      }

      const role = await tx.role.findUnique({ where: { code: SystemRole.SYSTEM_ADMIN } });
      if (!role?.isActive) throw new AdminBootstrapError("Brak roli SYSTEM_ADMIN. Najpierw uruchom: npm run db:bootstrap");

      const created = await tx.user.create({
        data: {
          email: input.email,
          login: input.login,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          role: SystemRole.SYSTEM_ADMIN,
          isActive: true
        }
      });
      await tx.userRole.create({ data: { userId: created.id, roleId: role.id } });
      await writeAuditInTransaction(tx, {
        entityType: "USER",
        entityId: created.id,
        action: "BOOTSTRAP_ADMIN",
        after: { email: created.email, login: created.login, role: created.role }
      });
      return { result: "CREATED", userId: created.id } as const;
    }, { timeout: 60_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AdminBootstrapError("Konto z tym e-mailem lub loginem już istnieje");
    }
    throw error;
  }
}
