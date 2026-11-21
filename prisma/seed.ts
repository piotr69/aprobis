import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { DocumentCategory, documentTypeFields, documentTypes, seededRoles } from "./reference-data.js";

// Dane demonstracyjne KASUJĄ całą zawartość bazy. Najpierw .env (tak jak API), dopiero potem osłony:
// bez tego na serwerze z NODE_ENV="production" tylko w .env strażnik by nie zadziałał.
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

if (process.env.NODE_ENV === "production") {
  throw new Error("Odmowa: dane demonstracyjne są wyłączone przy NODE_ENV=production");
}
if (process.env.SEED_CONFIRM !== "delete-all" && !process.argv.includes("--yes-delete-all")) {
  throw new Error("Odmowa: seed kasuje całą bazę. Uruchom: npm run db:seed -- --yes-delete-all");
}

const prisma = new PrismaClient();

const SystemRole = {
  SYSTEM_ADMIN: "SYSTEM_ADMIN",
  EMPLOYEE: "EMPLOYEE",
  DEPARTMENT_MANAGER: "DEPARTMENT_MANAGER",
  DIRECTOR: "DIRECTOR",
  BOARD: "BOARD",
  ACCOUNTING: "ACCOUNTING",
  LEGAL: "LEGAL",
  PURCHASING: "PURCHASING",
  HR: "HR",
  AUDITOR: "AUDITOR",
  SECRETARIAT: "SECRETARIAT",
  IT: "IT"
} as const;

const DocumentStatus = {
  DRAFT: "DRAFT"
} as const;

type SeedUser = {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: string;
  departmentCode: string;
  positionName: string;
  managerEmail?: string;
};

async function main() {
  await prisma.outboxMessage.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.session.deleteMany();
  await prisma.rateLimitBucket.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.workflowAction.deleteMany();
  await prisma.workflowStageRecipient.deleteMany();
  await prisma.workflowTaskCandidate.deleteMany();
  await prisma.workflowTask.deleteMany();
  await prisma.workflowInstanceStage.deleteMany();
  await prisma.workflowInstance.deleteMany();
  await prisma.documentFile.deleteMany();
  await prisma.documentFieldProjection.deleteMany();
  await prisma.documentAccessPolicy.deleteMany();
  await prisma.document.deleteMany();
  await prisma.approvalRule.deleteMany();
  await prisma.workflowStageAssignee.deleteMany();
  await prisma.workflowStep.deleteMany();
  // Typ wskazuje domyślną definicję — bez tego ponowny seed łamie klucz obcy.
  await prisma.documentType.updateMany({ data: { defaultWorkflowId: null } });
  await prisma.workflowDefinition.deleteMany();
  await prisma.documentTransition.deleteMany();
  await prisma.documentStatusDefinition.deleteMany();
  await prisma.attachmentRequirement.deleteMany();
  await prisma.validationRule.deleteMany();
  await prisma.documentFieldDefinition.deleteMany();
  await prisma.documentTypeVersion.deleteMany();
  await prisma.documentType.deleteMany();
  await prisma.userSubstitution.deleteMany();
  await prisma.project.deleteMany();
  await prisma.costCenter.deleteMany();
  await prisma.organizationUnit.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.groupMember.deleteMany();
  await prisma.group.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.documentNumberSequence.deleteMany();
  // Klucze systemowe konfiguracji zostają (np. poczta lokalna), tracą tylko autora zmiany przed usunięciem kont.
  await prisma.appConfig.deleteMany({ where: { isSystem: false } });
  await prisma.appConfig.updateMany({ where: { updatedById: { not: null } }, data: { updatedById: null } });
  await prisma.department.updateMany({ data: { managerId: null, parentDepartmentId: null } });
  await prisma.user.updateMany({ data: { managerId: null, departmentId: null, positionId: null } });
  await prisma.user.deleteMany();
  await prisma.department.deleteMany();
  await prisma.position.deleteMany();
  await prisma.dictionaryEntry.deleteMany();

  const positions = new Map<string, string>();
  for (const position of [
    { name: "Pracownik", level: 1, isManagerial: false },
    { name: "Specjalista", level: 2, isManagerial: false },
    { name: "Kierownik działu", level: 3, isManagerial: true },
    { name: "Dyrektor", level: 4, isManagerial: true },
    { name: "Członek zarządu", level: 5, isManagerial: true }
  ]) {
    const created = await prisma.position.create({ data: position });
    positions.set(created.name, created.id);
  }

  const departmentInputs = [
    ["Zarząd", "ZARZAD"],
    ["Produkcja", "PROD"],
    ["Księgowość", "FIN"],
    ["Dział prawny", "LEGAL"],
    ["Dział zakupów", "PUR"],
    ["Dział IT", "IT"],
    ["Dział HR", "HR"],
    ["Jakość i compliance", "QUALITY"],
    ["Sekretariat / kancelaria", "SECRETARIAT"]
  ] as const;

  const departments = new Map<string, string>();
  for (const [name, code] of departmentInputs) {
    const created = await prisma.department.create({ data: { name, code } });
    departments.set(code, created.id);
  }

  const users: SeedUser[] = [
    { email: "admin@aprobis.local", password: "Admin#2026", firstName: "Admin", lastName: "Systemu", role: SystemRole.SYSTEM_ADMIN, departmentCode: "IT", positionName: "Dyrektor" },
    { email: "marek.prezes@aprobis.local", password: "Marek#2026", firstName: "Marek", lastName: "Prezes", role: SystemRole.BOARD, departmentCode: "ZARZAD", positionName: "Członek zarządu" },
    { email: "ewa.zarzad@aprobis.local", password: "Ewa#2026", firstName: "Ewa", lastName: "Zarząd", role: SystemRole.BOARD, departmentCode: "ZARZAD", positionName: "Członek zarządu", managerEmail: "marek.prezes@aprobis.local" },
    { email: "piotr.dyrektor@aprobis.local", password: "Piotr#2026", firstName: "Piotr", lastName: "Dyrektor", role: SystemRole.DIRECTOR, departmentCode: "ZARZAD", positionName: "Dyrektor", managerEmail: "ewa.zarzad@aprobis.local" },
    { email: "anna.kierownik@aprobis.local", password: "Anna#2026", firstName: "Anna", lastName: "Kierownik", role: SystemRole.DEPARTMENT_MANAGER, departmentCode: "PROD", positionName: "Kierownik działu", managerEmail: "piotr.dyrektor@aprobis.local" },
    { email: "jan.pracownik@aprobis.local", password: "Jan#2026", firstName: "Jan", lastName: "Pracownik", role: SystemRole.EMPLOYEE, departmentCode: "PROD", positionName: "Pracownik", managerEmail: "anna.kierownik@aprobis.local" },
    { email: "maria.ksiegowosc@aprobis.local", password: "Maria#2026", firstName: "Maria", lastName: "Księgowość", role: SystemRole.ACCOUNTING, departmentCode: "FIN", positionName: "Specjalista", managerEmail: "piotr.dyrektor@aprobis.local" },
    { email: "tomasz.prawny@aprobis.local", password: "Prawny#2026", firstName: "Tomasz", lastName: "Prawny", role: SystemRole.LEGAL, departmentCode: "LEGAL", positionName: "Specjalista", managerEmail: "piotr.dyrektor@aprobis.local" },
    { email: "olga.zakupy@aprobis.local", password: "Zakupy#2026", firstName: "Olga", lastName: "Zakupy", role: SystemRole.PURCHASING, departmentCode: "PUR", positionName: "Specjalista", managerEmail: "piotr.dyrektor@aprobis.local" },
    { email: "adam.it@aprobis.local", password: "IT#2026!!", firstName: "Adam", lastName: "IT", role: SystemRole.IT, departmentCode: "IT", positionName: "Specjalista", managerEmail: "piotr.dyrektor@aprobis.local" },
    { email: "karolina.hr@aprobis.local", password: "HR#2026!!", firstName: "Karolina", lastName: "HR", role: SystemRole.HR, departmentCode: "HR", positionName: "Specjalista", managerEmail: "piotr.dyrektor@aprobis.local" },
    { email: "sekretariat@aprobis.local", password: "Sekretariat#2026", firstName: "Katarzyna", lastName: "Sekretariat", role: SystemRole.SECRETARIAT, departmentCode: "SECRETARIAT", positionName: "Specjalista", managerEmail: "piotr.dyrektor@aprobis.local" },
    { email: "audytor@aprobis.local", password: "Audytor#2026", firstName: "Alicja", lastName: "Audytor", role: SystemRole.AUDITOR, departmentCode: "QUALITY", positionName: "Specjalista", managerEmail: "piotr.dyrektor@aprobis.local" }
  ];

  const createdUsers = new Map<string, string>();
  for (const user of users) {
    const passwordHash = await argon2.hash(user.password, { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 });
    const created = await prisma.user.create({
      data: {
        email: user.email,
        login: user.email.split("@")[0],
        passwordHash,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        departmentId: departments.get(user.departmentCode),
        positionId: positions.get(user.positionName),
        location: "Warszawa"
      }
    });
    createdUsers.set(created.email, created.id);
  }

  for (const user of users.filter((item) => item.managerEmail)) {
    await prisma.user.update({
      where: { email: user.email },
      data: { managerId: createdUsers.get(user.managerEmail!) }
    });
  }

  for (const roleCode of seededRoles) {
    const role = await prisma.role.create({ data: { code: roleCode, name: roleCode.replaceAll("_", " "), isSystem: true } });
    const usersInRole = users.filter((user) => user.role === roleCode);
    if (usersInRole.length) {
      await prisma.userRole.createMany({ data: usersInRole.map((user) => ({ userId: createdUsers.get(user.email)!, roleId: role.id })) });
    }
  }

  const departmentManagers: Record<string, string> = {
    ZARZAD: "ewa.zarzad@aprobis.local",
    PROD: "anna.kierownik@aprobis.local",
    FIN: "maria.ksiegowosc@aprobis.local",
    LEGAL: "tomasz.prawny@aprobis.local",
    PUR: "olga.zakupy@aprobis.local",
    IT: "adam.it@aprobis.local",
    HR: "karolina.hr@aprobis.local",
    QUALITY: "audytor@aprobis.local",
    SECRETARIAT: "sekretariat@aprobis.local"
  };

  for (const [code, email] of Object.entries(departmentManagers)) {
    await prisma.department.update({
      where: { code },
      data: { managerId: createdUsers.get(email) }
    });
  }

  const costCenter = await prisma.costCenter.create({
    data: { code: "MPK-PROD", name: "Produkcja podstawowa", departmentId: departments.get("PROD") }
  });

  const project = await prisma.project.create({
    data: {
      code: "PRJ-AUTOMATYZACJA",
      name: "Automatyzacja linii produkcyjnej",
      managerId: createdUsers.get("anna.kierownik@aprobis.local"),
      costCenterId: costCenter.id
    }
  });

  await prisma.organizationUnit.createMany({
    data: [
      { name: "Centrala", type: "COMPANY", location: "Warszawa" },
      { name: "Zakład produkcyjny", type: "LOCATION", departmentId: departments.get("PROD"), location: "Radom" }
    ]
  });

  for (const [name, code, category, requiresAmount, requiresContractor] of documentTypes) {
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
        ...(config ? {
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
        } : {})
      }
    });
  }

  const typeByCode = new Map(
    (await prisma.documentType.findMany()).map((type) => [type.code, type])
  );

  const vacationType = typeByCode.get("WNIOSEK_URLOPOWY")!;
  const vacationWorkflow = await prisma.workflowDefinition.create({
    data: {
      name: "Wniosek urlopowy - przełożony i HR",
      documentTypeId: vacationType.id,
      version: 1,
      status: "PUBLISHED",
      publishedAt: new Date(),
      isActive: true,
      steps: {
        create: [
          {
            name: "Akceptacja przełożonego",
            stepType: "MANAGER_APPROVAL",
            order: 1,
            stageNo: 1,
            assigneeType: "MANAGER",
            dueDays: 2,
            canDelegate: true,
            canReturn: true
          },
          {
            name: "Weryfikacja HR",
            stepType: "OPINION",
            order: 2,
            stageNo: 2,
            assigneeType: "ROLE",
            assigneeRole: SystemRole.HR,
            dueDays: 2,
            canDelegate: true,
            canReturn: true
          }
        ]
      }
    }
  });

  await prisma.documentType.update({
    where: { id: vacationType.id },
    data: { defaultWorkflowId: vacationWorkflow.id }
  });

  const rule = async (
    name: string,
    priority: number,
    documentTypeCode: string | null,
    conditions: unknown,
    actions: unknown
  ) => {
    await prisma.approvalRule.create({
      data: {
        name,
        priority,
        documentTypeId: documentTypeCode ? typeByCode.get(documentTypeCode)?.id : null,
        conditionsJson: JSON.stringify(conditions),
        actionsJson: JSON.stringify(actions),
        isActive: true
      }
    });
  };

  await rule("Faktura do 5 000 PLN", 10, null, {
    documentTypeCodes: ["FAKTURA_KOSZTOWA", "FAKTURA_ZAKUPOWA"],
    amountMax: 5000,
    currency: "PLN"
  }, {
    stopProcessing: true,
    steps: [
      { name: "Akceptacja przełożonego", stepType: "MANAGER_APPROVAL", assigneeType: "MANAGER", dueDays: 2 }
    ]
  });

  await rule("Faktura od 5 000 do 50 000 PLN", 20, null, {
    documentTypeCodes: ["FAKTURA_KOSZTOWA", "FAKTURA_ZAKUPOWA"],
    amountMin: 5000,
    amountMax: 50000,
    currency: "PLN"
  }, {
    stopProcessing: true,
    steps: [
      { name: "Akceptacja przełożonego", stepType: "MANAGER_APPROVAL", assigneeType: "MANAGER", dueDays: 2 },
      { name: "Akceptacja dyrektora", stepType: "BUSINESS_APPROVAL", assigneeType: "ROLE", assigneeRole: "DIRECTOR", dueDays: 3 }
    ]
  });

  await rule("Faktura powyżej 50 000 PLN", 30, null, {
    documentTypeCodes: ["FAKTURA_KOSZTOWA", "FAKTURA_ZAKUPOWA"],
    amountMin: 50000,
    currency: "PLN"
  }, {
    stopProcessing: true,
    steps: [
      { name: "Akceptacja przełożonego", stepType: "MANAGER_APPROVAL", assigneeType: "MANAGER", dueDays: 2 },
      { name: "Akceptacja finansowa", stepType: "FINANCIAL_APPROVAL", assigneeType: "ROLE", assigneeRole: "ACCOUNTING", dueDays: 2 },
      { name: "Akceptacja zarządu", stepType: "BOARD_APPROVAL", assigneeType: "ROLE", assigneeRole: "BOARD", dueDays: 4 }
    ]
  });

  await rule("Dokumenty kadrowe: przełożony i HR", 35, null, { categories: ["HR"] }, {
    stopProcessing: true,
    steps: [
      { name: "Akceptacja przełożonego", stepType: "MANAGER_APPROVAL", assigneeType: "MANAGER", dueDays: 2 },
      { name: "Weryfikacja HR", stepType: "OPINION", assigneeType: "ROLE", assigneeRole: "HR", dueDays: 2 }
    ]
  });

  // Progi kwotowe dotyczą PLN. Bez kursów walut faktura w innej walucie idzie pełną ścieżką,
  // zamiast trafić do domyślnej akceptacji samego przełożonego.
  await rule("Faktura w walucie obcej", 32, null, {
    documentTypeCodes: ["FAKTURA_KOSZTOWA", "FAKTURA_ZAKUPOWA"],
    currencies: ["EUR", "USD"]
  }, {
    stopProcessing: true,
    steps: [
      { name: "Akceptacja przełożonego", stepType: "MANAGER_APPROVAL", assigneeType: "MANAGER", dueDays: 2 },
      { name: "Akceptacja finansowa", stepType: "FINANCIAL_APPROVAL", assigneeType: "ROLE", assigneeRole: "ACCOUNTING", dueDays: 2 },
      { name: "Akceptacja zarządu", stepType: "BOARD_APPROVAL", assigneeType: "ROLE", assigneeRole: "BOARD", dueDays: 4 }
    ]
  });

  await rule("Umowy wymagają opinii prawnej", 40, null, {
    categories: ["CONTRACT"]
  }, {
    steps: [
      { name: "Opinia działu prawnego", stepType: "LEGAL_APPROVAL", assigneeType: "ROLE", assigneeRole: "LEGAL", dueDays: 3 },
      { name: "Akceptacja przełożonego", stepType: "MANAGER_APPROVAL", assigneeType: "MANAGER", dueDays: 2 }
    ]
  });

  await rule("CAPEX wymaga finansów i zarządu", 50, "CAPEX", {}, {
    stopProcessing: true,
    steps: [
      { name: "Akceptacja przełożonego", stepType: "MANAGER_APPROVAL", assigneeType: "MANAGER", dueDays: 2 },
      { name: "Akceptacja finansowa", stepType: "FINANCIAL_APPROVAL", assigneeType: "ROLE", assigneeRole: "ACCOUNTING", dueDays: 2 },
      { name: "Akceptacja zarządu", stepType: "BOARD_APPROVAL", assigneeType: "ROLE", assigneeRole: "BOARD", dueDays: 4 }
    ]
  });

  await rule("Zakup IT wymaga opinii IT", 60, null, {
    documentTypeCodes: ["ZAMOWIENIE_ZAKUPU", "ZAPOTRZEBOWANIE"],
    keywords: ["IT", "software", "licencja", "komputer"]
  }, {
    steps: [
      { name: "Opinia działu IT", stepType: "OPINION", assigneeType: "ROLE", assigneeRole: "IT", dueDays: 2 },
      { name: "Akceptacja zakupów", stepType: "BUSINESS_APPROVAL", assigneeType: "ROLE", assigneeRole: "PURCHASING", dueDays: 2 }
    ]
  });

  const invoiceType = typeByCode.get("FAKTURA_KOSZTOWA")!;
  const bigInvoiceType = typeByCode.get("FAKTURA_ZAKUPOWA")!;
  const contractType = typeByCode.get("UMOWA_KONTRAHENT")!;
  const capexType = typeByCode.get("CAPEX")!;

  await prisma.document.createMany({
    data: [
      {
        number: `DMS/${new Date().getFullYear()}/000001`,
        title: "Faktura za materiały produkcyjne",
        typeId: invoiceType.id,
        authorId: createdUsers.get("jan.pracownik@aprobis.local")!,
        departmentId: departments.get("PROD"),
        amount: "3200",
        currency: "PLN",
        contractorName: "Przykładowy Dostawca A Sp. z o.o.",
        dataJson: JSON.stringify({ invoiceNumber: "FV/2026/1042", paymentDueAt: "2026-12-15", invoiceDescription: "Stal na zlecenie 42" }),
        costCenterId: costCenter.id,
        projectId: project.id,
        status: DocumentStatus.DRAFT,
        location: "Radom"
      },
      {
        number: `DMS/${new Date().getFullYear()}/000002`,
        title: "Faktura za modernizację linii",
        typeId: bigInvoiceType.id,
        authorId: createdUsers.get("jan.pracownik@aprobis.local")!,
        departmentId: departments.get("PROD"),
        amount: "82000",
        currency: "PLN",
        contractorName: "Przykładowy Dostawca B S.A.",
        dataJson: JSON.stringify({ invoiceNumber: "AP/11/2026", paymentDueAt: "2026-12-20", invoiceDescription: "Modernizacja linii 3" }),
        costCenterId: costCenter.id,
        projectId: project.id,
        status: DocumentStatus.DRAFT,
        location: "Radom"
      },
      {
        number: `DMS/${new Date().getFullYear()}/000003`,
        title: "Umowa serwisowa z kontrahentem",
        typeId: contractType.id,
        authorId: createdUsers.get("anna.kierownik@aprobis.local")!,
        departmentId: departments.get("PROD"),
        contractorName: "Przykładowy Serwis C Sp. z o.o.",
        status: DocumentStatus.DRAFT,
        location: "Warszawa"
      },
      {
        number: `DMS/${new Date().getFullYear()}/000004`,
        title: "Wniosek CAPEX - nowa stacja kontroli jakości",
        typeId: capexType.id,
        authorId: createdUsers.get("anna.kierownik@aprobis.local")!,
        departmentId: departments.get("PROD"),
        amount: "140000",
        currency: "PLN",
        costCenterId: costCenter.id,
        projectId: project.id,
        status: DocumentStatus.DRAFT,
        location: "Radom"
      }
    ]
  });

  await prisma.documentNumberSequence.create({ data: { scope: "DMS", year: new Date().getFullYear(), nextValue: 5 } });

  await prisma.dictionaryEntry.createMany({
    data: [
      { type: "CURRENCY", key: "PLN", value: "Polski złoty" },
      { type: "CURRENCY", key: "EUR", value: "Euro" },
      { type: "CURRENCY", key: "USD", value: "Dolar amerykański" },
      { type: "DOCUMENT_STATUS", key: "IN_APPROVAL", value: "W akceptacji" },
      { type: "DOCUMENT_STATUS", key: "NEEDS_CORRECTION", value: "Do poprawy" }
    ]
  });

  await prisma.auditLog.create({
    data: {
      userId: createdUsers.get("admin@aprobis.local"),
      entityType: "SEED",
      action: "DATABASE_SEEDED",
      afterJson: JSON.stringify({ users: users.length, documentTypes: documentTypes.length })
    }
  });

  console.log("Seed completed. Demo admin: admin@aprobis.local / Admin#2026");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
