export type DocumentStatus =
  | "DRAFT"
  | "REGISTERED"
  | "IN_APPROVAL"
  | "IN_REVIEW"
  | "NEEDS_CORRECTION"
  | "REJECTED"
  | "PARTIALLY_APPROVED"
  | "APPROVED"
  | "WAITING_FOR_SIGNATURE"
  | "SIGNED"
  | "CANCELLED"
  | "ARCHIVED"
  | "OVERDUE";

export type Capabilities = {
  createDocuments: boolean;
  decideTasks: boolean;
  archiveDocuments: boolean;
  manageUsers: boolean;
  configureDocumentTypes: boolean;
  configureWorkflows: boolean;
  viewReports: boolean;
  viewDocumentReports: boolean;
  viewAudit: boolean;
  viewSystemLogs: boolean;
  manageConfig: boolean;
  viewDirectory: boolean;
  reassignTasks: boolean;
};

export type Person = { id: string; firstName: string; lastName: string; role?: string };

export type Profile = {
  id: string;
  email: string;
  login?: string | null;
  firstName: string;
  lastName: string;
  role: string;
  roleLabel: string;
  capabilities: Capabilities;
  approvalLimitAmount?: string | number | null;
  approvalLimitCurrency?: string;
  department?: { id: string; name: string; code: string } | null;
  position?: { id: string; name: string } | null;
  manager?: Person | null;
  actingFor: Array<Person & { validTo: string }>;
};

export type RoleInfo = { role: string; label: string; description: string; decideTasks: boolean };

export type DirectoryUser = Person & {
  role: string;
  email?: string;
  login?: string | null;
  location?: string | null;
  isActive: boolean;
  lockedAt?: string | null;
  failedLoginAttempts?: number;
  approvalLimitAmount?: string | number | null;
  approvalLimitCurrency?: string;
  departmentId?: string | null;
  positionId?: string | null;
  managerId?: string | null;
  department?: { id: string; name: string; code: string } | null;
  position?: { id: string; name: string } | null;
  manager?: Person | null;
};

export type Department = {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  managerId?: string | null;
  parentDepartmentId?: string | null;
  manager?: Person | null;
  parent?: { id: string; name: string } | null;
  _count?: { users: number };
};

export type Position = { id: string; name: string };

export type FieldType = "text" | "number" | "date" | "select" | "textarea" | "boolean";

export type FormField = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  searchable?: boolean;
  options?: string[];
  placeholder?: string;
};

export type DocumentType = {
  id: string;
  name: string;
  code: string;
  category: string;
  requiresAmount: boolean;
  requiresContractor: boolean;
  fields: FormField[];
  titleTemplate?: string | null;
  isActive: boolean;
  publishedVersion?: { id: string; version: number } | null;
  draftVersion?: { id: string; version: number } | null;
};

export type OpenTaskSummary = {
  id: string;
  name: string;
  status: string;
  dueAt?: string | null;
  assignedRole?: string | null;
  assignedTo?: Person | null;
};

export type DocumentListItem = {
  id: string;
  number: string;
  title: string;
  status: DocumentStatus;
  currentStepName?: string | null;
  amount?: string | number | null;
  currency: string;
  contractorName?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string | null;
  type: { id: string; code: string; name: string; category: string };
  author: Person;
  department?: { id: string; code: string; name: string } | null;
  _count: { files: number };
  tasks: OpenTaskSummary[];
};

export type Page<T> = { items: T[]; pageInfo: { hasNextPage: boolean; nextCursor: string | null; total?: number } };

export type StageRules = { requiresComment: boolean; requiresAttachment: boolean; canDelegate: boolean; canReturn: boolean };

export type MyTask = {
  id: string;
  documentId: string;
  name: string;
  status: string;
  version: number;
  dueAt?: string | null;
  assignedRole?: string | null;
  assignedTo?: Person | null;
  instanceStage?: StageRules | null;
  approvalLimitExceeded?: boolean;
  document: {
    id: string;
    number: string;
    title: string;
    amount?: string | number | null;
    currency: string;
    contractorName?: string | null;
    status: DocumentStatus;
    type: { id: string; name: string; category: string };
    author: Person;
    department?: { id: string; name: string; code: string } | null;
  };
};

export type DocumentFile = {
  id: string;
  documentId: string;
  version: number;
  originalName: string;
  mimeType: string;
  scanStatus: "PENDING" | "CLEAN" | "REJECTED" | "NOT_SCANNED";
  scanMessage?: string | null;
  size: number;
  uploadedById: string;
  createdAt: string;
};

export type StageTask = {
  id: string;
  name: string;
  status: string;
  version: number;
  dueAt?: string | null;
  completedAt?: string | null;
  assignedRole?: string | null;
  assignedTo?: Person | null;
  candidates: Array<{ user?: Person | null }>;
};

export type WorkflowStage = {
  id: string;
  stageNo: number;
  parallelGroup: number;
  name: string;
  status: string;
  completionMode: "ALL" | "ANY" | "QUORUM";
  requiredApprovals: number;
  completedAt?: string | null;
  configSnapshotJson?: string | null;
  stageKind?: string;
  recipients?: Array<{ status: string; user: Person }>;
  tasks: StageTask[];
};

export type WorkflowInstance = {
  id: string;
  status: string;
  startedAt: string;
  completedAt?: string | null;
  stages: WorkflowStage[];
};

export type WorkflowAction = {
  id: string;
  actionType: string;
  comment?: string | null;
  createdAt: string;
  user?: Person | null;
};

export type CommentItem = {
  id: string;
  body: string;
  visibility: "INTERNAL" | "AUTHOR";
  createdAt: string;
  user: Person;
};

export type ActionsAllowed = {
  canEdit: boolean;
  canSubmit: boolean;
  canUpload: boolean;
  canComment: boolean;
  canCancel: boolean;
  canDelete: boolean;
  canArchive: boolean;
  canReassign: boolean;
};

export type DocumentTask = { id: string; name: string; version: number; dueAt?: string | null; instanceStage?: StageRules | null; approvalLimitExceeded?: boolean };

export type DocumentDetail = {
  id: string;
  number: string;
  title: string;
  status: DocumentStatus;
  version: number;
  typeId: string;
  amount?: string | number | null;
  currency: string;
  contractorName?: string | null;
  dataJson?: string | null;
  metadataJson?: string | null;
  createdAt: string;
  submittedAt?: string | null;
  archivedAt?: string | null;
  type: { id: string; code: string; name: string; category: string; requiresAmount: boolean; requiresContractor: boolean; titleTemplate?: string | null };
  author: Person;
  department?: { id: string; code: string; name: string } | null;
  files: DocumentFile[];
  comments: CommentItem[];
  workflowInstances: WorkflowInstance[];
  actions: WorkflowAction[];
  formFields: FormField[];
  formTitleTemplate?: string | null;
  actionsAllowed: ActionsAllowed;
  myTask?: DocumentTask | null;
};

export type PreviewStage = { stageNo: number; name: string; dueDays: number; completionMode: string; approvers: string[]; authorReplaced?: boolean; stageKind?: string };

export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string;
  documentId?: string | null;
  readAt?: string | null;
  createdAt: string;
};

export type Substitution = {
  id: string;
  userId: string;
  substituteUserId: string;
  validFrom: string;
  validTo: string;
  user: Person;
  substituteUser: Person;
};

export type WorkflowStepConfig = {
  id?: string;
  name: string;
  stepType: string;
  assigneeType: string;
  assigneeRole?: string | null;
  assigneeUserId?: string | null;
  assigneeDepartmentId?: string | null;
  dueDays: number;
  requiresComment: boolean;
  requiresAttachment: boolean;
  canDelegate: boolean;
  canReturn: boolean;
  /** Tylko w edytorze stałego schematu: wybrane osoby etapu i czy wystarczy decyzja jednej z nich. */
  userIds?: string[];
  completionMode?: string;
  /** DECISION albo INFO („do wiadomości”: obieg nie czeka). */
  stageKind?: string;
};

export type WorkflowStageAssigneeConfig = { assigneeType: string; userId?: string | null; roleId?: string | null; groupId?: string | null; departmentId?: string | null };

export type WorkflowDefinition = {
  id: string;
  name: string;
  documentTypeId?: string | null;
  version: number;
  status: string;
  isActive: boolean;
  isAdvanced: boolean;
  steps: Array<WorkflowStepConfig & { id: string; order: number; stageNo: number; parallelGroup: number; completionMode: string; assignees?: WorkflowStageAssigneeConfig[] }>;
};

export type PotentialRule = {
  id: string;
  name: string;
  priority: number;
  conditions: Record<string, unknown>;
  steps: string[];
  stopProcessing: boolean;
  broken: boolean;
};

export type WorkflowOverviewItem = {
  type: { id: string; name: string; code: string; category: string };
  source: "SCHEMA" | "RULES" | "DEFAULT";
  definition?: {
    id: string;
    name: string;
    version: number;
    isAdvanced: boolean;
    steps: Array<{ name: string; stageNo: number; stageKind?: string; assigneeType: string; assigneeRole?: string | null; completionMode: string; conditional: boolean; people: string[] }>;
  };
  rules?: PotentialRule[];
};

export type ApprovalRule = {
  id: string;
  name: string;
  priority: number;
  documentTypeId?: string | null;
  conditionsJson: string;
  actionsJson: string;
  validFrom?: string | null;
  validTo?: string | null;
  isActive: boolean;
  documentType?: { id: string; name: string; code: string } | null;
};

export type AuditEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  createdAt: string;
  ipAddress?: string | null;
  user?: Person | null;
};

export type SystemLogEntry = {
  id: string;
  createdAt: string;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  message: string;
  contextJson: string | null;
};

export type SystemLogPage = { items: SystemLogEntry[]; hasMore: boolean };

export type DocumentsReport = {
  byStatus: Array<{ status: string; count: number }>;
  byType: Array<{ typeId: string; type?: string; count: number }>;
};

export type OverdueTask = {
  id: string;
  name: string;
  dueAt: string;
  version: number;
  assignedRole?: string | null;
  assignedTo?: Person | null;
  document: { id: string; number: string; title: string; type: { name: string }; author: Person };
};

export type CycleTime = {
  documentId: string;
  documentNumber: string;
  documentTitle: string;
  documentType: string;
  startedAt: string;
  completedAt: string;
  hours: number | null;
};

export type MyAction = {
  id: string;
  actionType: string;
  comment?: string | null;
  createdAt: string;
  task?: { name: string } | null;
  document: {
    id: string;
    number: string;
    title: string;
    status: DocumentStatus;
    type: { name: string };
    tasks: Array<{ id: string; name: string; assignedRole?: string | null; assignedTo?: Person | null }>;
  };
};

export type ConfigType = "string" | "number" | "boolean";

export type ConfigEntry = {
  id: string;
  key: string;
  /** Hasła przychodzą jako maska; odesłana bez zmian zostawia dotychczasowe. */
  value: string | null;
  type: ConfigType;
  category: string | null;
  description: string | null;
  isSystem: boolean;
  isSecret: boolean;
  isReadOnly: boolean;
  updatedAt: string;
  updatedBy: { firstName: string; lastName: string } | null;
};

export type VersionInfo = {
  version: string | null;
  commit: string | null;
  installedAt: string | null;
  changedAt: string | null;
  isNew: boolean;
  newRemainingMs: number;
};
