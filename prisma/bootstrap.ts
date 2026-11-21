import { PrismaClient } from "@prisma/client";
import { documentTypeFields, documentTypes, seededRoles } from "./reference-data.js";

/**
 * Start nowej instalacji: role, typy dokumentów i waluty. Bez kont, dokumentów i reguł.
 * Bez reguł każdy dokument przechodzi jeden etap: akceptację przełożonego autora.
 * Niczego nie kasuje, a to, co już istnieje, zostawia bez zmian. Można uruchamiać wielokrotnie.
 */
const prisma = new PrismaClient();

async function main() {
  let roles = 0;
  for (const code of seededRoles) {
    if (await prisma.role.findUnique({ where: { code } })) continue;
    await prisma.role.create({ data: { code, name: code.replaceAll("_", " "), isSystem: true } });
    roles += 1;
  }

  let types = 0;
  for (const [name, code, category, requiresAmount, requiresContractor] of documentTypes) {
    if (await prisma.documentType.findUnique({ where: { code } })) continue;
    const config = documentTypeFields[code];
    await prisma.documentType.create({
      data: {
        name,
        code,
        category,
        requiresAmount,
        requiresContractor,
        fieldsJson: config ? JSON.stringify(config.fields) : undefined,
        titleTemplate: config?.titleTemplate ?? undefined,
        ...(config
          ? {
              versions: {
                create: {
                  version: 1,
                  status: "PUBLISHED",
                  publishedAt: new Date(),
                  titleTemplate: config.titleTemplate,
                  fields: {
                    create: config.fields.map((field, index) => ({
                      key: field.key,
                      label: field.label,
                      fieldType: field.type,
                      sortOrder: index,
                      isRequired: field.required ?? false,
                      uiConfigJson: JSON.stringify({ options: field.options, placeholder: field.placeholder })
                    }))
                  }
                }
              }
            }
          : {})
      }
    });
    types += 1;
  }

  for (const [key, value] of [["PLN", "Polski złoty"], ["EUR", "Euro"], ["USD", "Dolar amerykański"]]) {
    await prisma.dictionaryEntry.upsert({ where: { type_key: { type: "CURRENCY", key } }, update: {}, create: { type: "CURRENCY", key, value } });
  }
  console.log(`Nowe role: ${roles}, nowe typy dokumentów: ${types}.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
