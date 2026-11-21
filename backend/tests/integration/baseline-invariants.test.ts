import { describe, expect, it } from "vitest";
import { prisma } from "./helpers.js";

/** Ograniczenia dopisane ręcznie w migracji init (prisma/MIGRATIONS.md). Baza musi je egzekwować sama. */
describe("ręczne ograniczenia bazy z migracji init", () => {
  async function anyDraft() {
    return prisma.document.findFirstOrThrow({ where: { status: "DRAFT" }, select: { id: true, authorId: true } });
  }

  it("odrzuca drugi aktywny obieg tego samego dokumentu", async () => {
    const doc = await anyDraft();
    const first = await prisma.workflowInstance.create({ data: { documentId: doc.id, startedById: doc.authorId, status: "ACTIVE" } });
    try {
      await expect(prisma.workflowInstance.create({ data: { documentId: doc.id, startedById: doc.authorId, status: "ACTIVE" } })).rejects.toThrow();
      const closed = await prisma.workflowInstance.create({ data: { documentId: doc.id, startedById: doc.authorId, status: "CANCELLED" } });
      await prisma.workflowInstance.delete({ where: { id: closed.id } });
    } finally {
      await prisma.workflowInstance.delete({ where: { id: first.id } });
    }
  });

  it("odrzuca dokument z niepoprawnym JSON", async () => {
    const doc = await anyDraft();
    await expect(prisma.document.update({ where: { id: doc.id }, data: { dataJson: "{nie-json" } })).rejects.toThrow();
    await expect(prisma.document.update({ where: { id: doc.id }, data: { metadataJson: "[" } })).rejects.toThrow();
  });

  it("login jest unikalny, ale wiele kont może go nie mieć", async () => {
    const stamp = `${Date.now()}`;
    const base = { passwordHash: "$argon2id$nieuzywany", firstName: "Test", lastName: "Login" };
    const a = await prisma.user.create({ data: { ...base, email: `a.${stamp}@example.test`, login: null } });
    const b = await prisma.user.create({ data: { ...base, email: `b.${stamp}@example.test`, login: null } });
    const c = await prisma.user.create({ data: { ...base, email: `c.${stamp}@example.test`, login: `login${stamp}` } });
    try {
      await expect(prisma.user.create({ data: { ...base, email: `d.${stamp}@example.test`, login: `login${stamp}` } })).rejects.toThrow();
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: [a.id, b.id, c.id] } } });
    }
  });

  it("kolumna row_version jest typu rowversion", async () => {
    const rows = await prisma.$queryRaw<Array<{ typeName: string }>>`
      SELECT TYPE_NAME(c.user_type_id) AS typeName FROM sys.columns c
      WHERE c.object_id = OBJECT_ID(N'dbo.Document') AND c.name = N'row_version'`;
    expect(rows[0]?.typeName).toBe("timestamp");
  });
});
