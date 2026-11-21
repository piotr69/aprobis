BEGIN TRY

BEGIN TRAN;

-- CreateSchema
IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = N'dbo') EXEC sp_executesql N'CREATE SCHEMA [dbo];';

-- CreateTable
CREATE TABLE [dbo].[User] (
    [id] NVARCHAR(32) NOT NULL,
    [email] NVARCHAR(320) NOT NULL,
    [login] NVARCHAR(60),
    [passwordHash] NVARCHAR(255) NOT NULL,
    [firstName] NVARCHAR(120) NOT NULL,
    [lastName] NVARCHAR(120) NOT NULL,
    [role] NVARCHAR(40) NOT NULL CONSTRAINT [User_role_df] DEFAULT 'EMPLOYEE',
    [permissionsJson] NVARCHAR(max),
    [departmentId] NVARCHAR(32),
    [positionId] NVARCHAR(32),
    [managerId] NVARCHAR(32),
    [decisionLevel] INT NOT NULL CONSTRAINT [User_decisionLevel_df] DEFAULT 0,
    [approvalLimitAmount] DECIMAL(18,2),
    [approvalLimitCurrency] NVARCHAR(3) NOT NULL CONSTRAINT [User_approvalLimitCurrency_df] DEFAULT 'PLN',
    [location] NVARCHAR(120),
    [isActive] BIT NOT NULL CONSTRAINT [User_isActive_df] DEFAULT 1,
    [failedLoginAttempts] INT NOT NULL CONSTRAINT [User_failedLoginAttempts_df] DEFAULT 0,
    [lockedAt] DATETIME2,
    [resetTokenHash] NVARCHAR(64),
    [resetTokenExpires] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [User_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [User_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [User_email_key] UNIQUE NONCLUSTERED ([email])
);

-- CreateTable
CREATE TABLE [dbo].[Session] (
    [id] NVARCHAR(32) NOT NULL,
    [userId] NVARCHAR(32) NOT NULL,
    [tokenHash] NVARCHAR(64) NOT NULL,
    [expiresAt] DATETIME2 NOT NULL,
    [lastSeenAt] DATETIME2 NOT NULL CONSTRAINT [Session_lastSeenAt_df] DEFAULT CURRENT_TIMESTAMP,
    [revokedAt] DATETIME2,
    [ipAddress] NVARCHAR(80),
    [userAgent] NVARCHAR(300),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Session_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Session_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Session_tokenHash_key] UNIQUE NONCLUSTERED ([tokenHash])
);

-- CreateTable
CREATE TABLE [dbo].[RateLimitBucket] (
    [key] NVARCHAR(200) NOT NULL,
    [windowStart] DATETIME2 NOT NULL,
    [count] INT NOT NULL CONSTRAINT [RateLimitBucket_count_df] DEFAULT 0,
    [expiresAt] DATETIME2 NOT NULL,
    CONSTRAINT [RateLimitBucket_pkey] PRIMARY KEY CLUSTERED ([key],[windowStart])
);

-- CreateTable
CREATE TABLE [dbo].[Role] (
    [id] NVARCHAR(32) NOT NULL,
    [code] NVARCHAR(80) NOT NULL,
    [name] NVARCHAR(180) NOT NULL,
    [description] NVARCHAR(500),
    [isSystem] BIT NOT NULL CONSTRAINT [Role_isSystem_df] DEFAULT 0,
    [isActive] BIT NOT NULL CONSTRAINT [Role_isActive_df] DEFAULT 1,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Role_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Role_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Role_code_key] UNIQUE NONCLUSTERED ([code])
);

-- CreateTable
CREATE TABLE [dbo].[Permission] (
    [id] NVARCHAR(32) NOT NULL,
    [code] NVARCHAR(100) NOT NULL,
    [name] NVARCHAR(180) NOT NULL,
    [description] NVARCHAR(500),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Permission_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Permission_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Permission_code_key] UNIQUE NONCLUSTERED ([code])
);

-- CreateTable
CREATE TABLE [dbo].[UserRole] (
    [userId] NVARCHAR(32) NOT NULL,
    [roleId] NVARCHAR(32) NOT NULL,
    [validFrom] DATETIME2 NOT NULL CONSTRAINT [UserRole_validFrom_df] DEFAULT CURRENT_TIMESTAMP,
    [validTo] DATETIME2,
    [assignedAt] DATETIME2 NOT NULL CONSTRAINT [UserRole_assignedAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [UserRole_pkey] PRIMARY KEY CLUSTERED ([userId],[roleId])
);

-- CreateTable
CREATE TABLE [dbo].[RolePermission] (
    [roleId] NVARCHAR(32) NOT NULL,
    [permissionId] NVARCHAR(32) NOT NULL,
    CONSTRAINT [RolePermission_pkey] PRIMARY KEY CLUSTERED ([roleId],[permissionId])
);

-- CreateTable
CREATE TABLE [dbo].[Group] (
    [id] NVARCHAR(32) NOT NULL,
    [code] NVARCHAR(80) NOT NULL,
    [name] NVARCHAR(180) NOT NULL,
    [description] NVARCHAR(500),
    [isActive] BIT NOT NULL CONSTRAINT [Group_isActive_df] DEFAULT 1,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Group_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Group_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Group_code_key] UNIQUE NONCLUSTERED ([code])
);

-- CreateTable
CREATE TABLE [dbo].[GroupMember] (
    [groupId] NVARCHAR(32) NOT NULL,
    [userId] NVARCHAR(32) NOT NULL,
    [validFrom] DATETIME2 NOT NULL CONSTRAINT [GroupMember_validFrom_df] DEFAULT CURRENT_TIMESTAMP,
    [validTo] DATETIME2,
    CONSTRAINT [GroupMember_pkey] PRIMARY KEY CLUSTERED ([groupId],[userId])
);

-- CreateTable
CREATE TABLE [dbo].[Department] (
    [id] NVARCHAR(32) NOT NULL,
    [name] NVARCHAR(180) NOT NULL,
    [code] NVARCHAR(40) NOT NULL,
    [parentDepartmentId] NVARCHAR(32),
    [managerId] NVARCHAR(32),
    [isActive] BIT NOT NULL CONSTRAINT [Department_isActive_df] DEFAULT 1,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Department_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Department_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Department_code_key] UNIQUE NONCLUSTERED ([code])
);

-- CreateTable
CREATE TABLE [dbo].[Position] (
    [id] NVARCHAR(32) NOT NULL,
    [name] NVARCHAR(160) NOT NULL,
    [level] INT NOT NULL CONSTRAINT [Position_level_df] DEFAULT 0,
    [isManagerial] BIT NOT NULL CONSTRAINT [Position_isManagerial_df] DEFAULT 0,
    CONSTRAINT [Position_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[OrganizationUnit] (
    [id] NVARCHAR(32) NOT NULL,
    [name] NVARCHAR(180) NOT NULL,
    [type] NVARCHAR(60) NOT NULL,
    [parentId] NVARCHAR(32),
    [departmentId] NVARCHAR(32),
    [location] NVARCHAR(120),
    [isActive] BIT NOT NULL CONSTRAINT [OrganizationUnit_isActive_df] DEFAULT 1,
    CONSTRAINT [OrganizationUnit_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[UserSubstitution] (
    [id] NVARCHAR(32) NOT NULL,
    [userId] NVARCHAR(32) NOT NULL,
    [substituteUserId] NVARCHAR(32) NOT NULL,
    [validFrom] DATETIME2 NOT NULL,
    [validTo] DATETIME2 NOT NULL,
    [scope] NVARCHAR(80) NOT NULL CONSTRAINT [UserSubstitution_scope_df] DEFAULT 'ALL',
    [isActive] BIT NOT NULL CONSTRAINT [UserSubstitution_isActive_df] DEFAULT 1,
    CONSTRAINT [UserSubstitution_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[DocumentType] (
    [id] NVARCHAR(32) NOT NULL,
    [name] NVARCHAR(180) NOT NULL,
    [code] NVARCHAR(60) NOT NULL,
    [category] NVARCHAR(40) NOT NULL,
    [requiresAmount] BIT NOT NULL CONSTRAINT [DocumentType_requiresAmount_df] DEFAULT 0,
    [requiresContractor] BIT NOT NULL CONSTRAINT [DocumentType_requiresContractor_df] DEFAULT 0,
    [fieldsJson] NVARCHAR(max),
    [titleTemplate] NVARCHAR(240),
    [defaultWorkflowId] NVARCHAR(32),
    [isActive] BIT NOT NULL CONSTRAINT [DocumentType_isActive_df] DEFAULT 1,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [DocumentType_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [DocumentType_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [DocumentType_code_key] UNIQUE NONCLUSTERED ([code])
);

-- CreateTable
CREATE TABLE [dbo].[DocumentTypeVersion] (
    [id] NVARCHAR(32) NOT NULL,
    [documentTypeId] NVARCHAR(32) NOT NULL,
    [version] INT NOT NULL,
    [status] NVARCHAR(24) NOT NULL CONSTRAINT [DocumentTypeVersion_status_df] DEFAULT 'DRAFT',
    [titleTemplate] NVARCHAR(240),
    [publishedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [DocumentTypeVersion_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [DocumentTypeVersion_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [DocumentTypeVersion_documentTypeId_version_key] UNIQUE NONCLUSTERED ([documentTypeId],[version])
);

-- CreateTable
CREATE TABLE [dbo].[DocumentFieldDefinition] (
    [id] NVARCHAR(32) NOT NULL,
    [documentTypeVersionId] NVARCHAR(32) NOT NULL,
    [key] NVARCHAR(100) NOT NULL,
    [label] NVARCHAR(180) NOT NULL,
    [fieldType] NVARCHAR(40) NOT NULL,
    [sortOrder] INT NOT NULL,
    [isRequired] BIT NOT NULL CONSTRAINT [DocumentFieldDefinition_isRequired_df] DEFAULT 0,
    [isSearchable] BIT NOT NULL CONSTRAINT [DocumentFieldDefinition_isSearchable_df] DEFAULT 0,
    [uiConfigJson] NVARCHAR(max),
    [defaultValueJson] NVARCHAR(max),
    CONSTRAINT [DocumentFieldDefinition_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [DocumentFieldDefinition_documentTypeVersionId_key_key] UNIQUE NONCLUSTERED ([documentTypeVersionId],[key])
);

-- CreateTable
CREATE TABLE [dbo].[ValidationRule] (
    [id] NVARCHAR(32) NOT NULL,
    [documentTypeVersionId] NVARCHAR(32) NOT NULL,
    [fieldDefinitionId] NVARCHAR(32),
    [status] NVARCHAR(40),
    [ruleType] NVARCHAR(60) NOT NULL,
    [configJson] NVARCHAR(max) NOT NULL,
    [message] NVARCHAR(300),
    [sortOrder] INT NOT NULL CONSTRAINT [ValidationRule_sortOrder_df] DEFAULT 0,
    CONSTRAINT [ValidationRule_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[AttachmentRequirement] (
    [id] NVARCHAR(32) NOT NULL,
    [documentTypeVersionId] NVARCHAR(32) NOT NULL,
    [key] NVARCHAR(100) NOT NULL,
    [label] NVARCHAR(180) NOT NULL,
    [status] NVARCHAR(40),
    [minCount] INT NOT NULL CONSTRAINT [AttachmentRequirement_minCount_df] DEFAULT 1,
    [maxCount] INT,
    [allowedMimeTypesJson] NVARCHAR(max),
    [maxSizeBytes] INT,
    CONSTRAINT [AttachmentRequirement_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [AttachmentRequirement_documentTypeVersionId_key_key] UNIQUE NONCLUSTERED ([documentTypeVersionId],[key])
);

-- CreateTable
CREATE TABLE [dbo].[DocumentStatusDefinition] (
    [id] NVARCHAR(32) NOT NULL,
    [documentTypeVersionId] NVARCHAR(32) NOT NULL,
    [code] NVARCHAR(40) NOT NULL,
    [label] NVARCHAR(120) NOT NULL,
    [sortOrder] INT NOT NULL,
    [isInitial] BIT NOT NULL CONSTRAINT [DocumentStatusDefinition_isInitial_df] DEFAULT 0,
    [isFinal] BIT NOT NULL CONSTRAINT [DocumentStatusDefinition_isFinal_df] DEFAULT 0,
    CONSTRAINT [DocumentStatusDefinition_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [DocumentStatusDefinition_documentTypeVersionId_code_key] UNIQUE NONCLUSTERED ([documentTypeVersionId],[code])
);

-- CreateTable
CREATE TABLE [dbo].[DocumentTransition] (
    [id] NVARCHAR(32) NOT NULL,
    [documentTypeVersionId] NVARCHAR(32) NOT NULL,
    [code] NVARCHAR(80) NOT NULL,
    [fromStatusId] NVARCHAR(32) NOT NULL,
    [toStatusId] NVARCHAR(32) NOT NULL,
    [requiredPermission] NVARCHAR(100),
    [conditionJson] NVARCHAR(max),
    CONSTRAINT [DocumentTransition_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [DocumentTransition_documentTypeVersionId_code_key] UNIQUE NONCLUSTERED ([documentTypeVersionId],[code])
);

-- CreateTable
CREATE TABLE [dbo].[Document] (
    [id] NVARCHAR(32) NOT NULL,
    [number] NVARCHAR(80) NOT NULL,
    [title] NVARCHAR(240) NOT NULL,
    [typeId] NVARCHAR(32) NOT NULL,
    [typeVersionId] NVARCHAR(32),
    [authorId] NVARCHAR(32) NOT NULL,
    [departmentId] NVARCHAR(32),
    [amount] DECIMAL(18,2),
    [currency] NVARCHAR(3) NOT NULL CONSTRAINT [Document_currency_df] DEFAULT 'PLN',
    [contractorName] NVARCHAR(240),
    [costCenterId] NVARCHAR(32),
    [projectId] NVARCHAR(32),
    [location] NVARCHAR(120),
    [metadataJson] NVARCHAR(max),
    [dataJson] NVARCHAR(max) NOT NULL CONSTRAINT [Document_dataJson_df] DEFAULT '{}',
    [status] NVARCHAR(40) NOT NULL CONSTRAINT [Document_status_df] DEFAULT 'DRAFT',
    [currentStepName] NVARCHAR(180),
    [version] INT NOT NULL CONSTRAINT [Document_version_df] DEFAULT 1,
    -- Ręcznie: ROWVERSION zamiast VARBINARY(8), które generuje Prisma (wykrywanie równoczesnych zmian).
    [row_version] ROWVERSION NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Document_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [submittedAt] DATETIME2,
    [archivedAt] DATETIME2,
    CONSTRAINT [Document_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Document_number_key] UNIQUE NONCLUSTERED ([number])
);

-- CreateTable
CREATE TABLE [dbo].[DocumentFieldProjection] (
    [id] NVARCHAR(32) NOT NULL,
    [documentId] NVARCHAR(32) NOT NULL,
    [fieldKey] NVARCHAR(100) NOT NULL,
    [stringValue] NVARCHAR(500),
    [numberValue] DECIMAL(28,8),
    [dateValue] DATETIME2,
    [boolValue] BIT,
    CONSTRAINT [DocumentFieldProjection_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [DocumentFieldProjection_documentId_fieldKey_key] UNIQUE NONCLUSTERED ([documentId],[fieldKey])
);

-- CreateTable
CREATE TABLE [dbo].[DocumentAccessPolicy] (
    [id] NVARCHAR(32) NOT NULL,
    [documentTypeId] NVARCHAR(32),
    [documentId] NVARCHAR(32),
    [permission] NVARCHAR(40) NOT NULL,
    [subjectType] NVARCHAR(40) NOT NULL,
    [subjectId] NVARCHAR(100),
    [conditionJson] NVARCHAR(max),
    [isActive] BIT NOT NULL CONSTRAINT [DocumentAccessPolicy_isActive_df] DEFAULT 1,
    [priority] INT NOT NULL CONSTRAINT [DocumentAccessPolicy_priority_df] DEFAULT 100,
    CONSTRAINT [DocumentAccessPolicy_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[DocumentFile] (
    [id] NVARCHAR(32) NOT NULL,
    [documentId] NVARCHAR(32) NOT NULL,
    [version] INT NOT NULL CONSTRAINT [DocumentFile_version_df] DEFAULT 1,
    [originalName] NVARCHAR(260) NOT NULL,
    [storagePath] NVARCHAR(600) NOT NULL,
    [mimeType] NVARCHAR(120) NOT NULL,
    [detectedMimeType] NVARCHAR(120),
    [sha256] NVARCHAR(64),
    [scanStatus] NVARCHAR(24) NOT NULL CONSTRAINT [DocumentFile_scanStatus_df] DEFAULT 'PENDING',
    [scanMessage] NVARCHAR(500),
    [scannedAt] DATETIME2,
    [size] INT NOT NULL,
    [uploadedById] NVARCHAR(32) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [DocumentFile_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [DocumentFile_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [DocumentFile_documentId_version_key] UNIQUE NONCLUSTERED ([documentId],[version])
);

-- CreateTable
CREATE TABLE [dbo].[WorkflowDefinition] (
    [id] NVARCHAR(32) NOT NULL,
    [name] NVARCHAR(180) NOT NULL,
    [documentTypeId] NVARCHAR(32),
    [version] INT NOT NULL CONSTRAINT [WorkflowDefinition_version_df] DEFAULT 1,
    [status] NVARCHAR(24) NOT NULL CONSTRAINT [WorkflowDefinition_status_df] DEFAULT 'DRAFT',
    [isActive] BIT NOT NULL CONSTRAINT [WorkflowDefinition_isActive_df] DEFAULT 1,
    [publishedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [WorkflowDefinition_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [WorkflowDefinition_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [WorkflowDefinition_documentTypeId_version_key] UNIQUE NONCLUSTERED ([documentTypeId],[version])
);

-- CreateTable
CREATE TABLE [dbo].[WorkflowStep] (
    [id] NVARCHAR(32) NOT NULL,
    [workflowDefinitionId] NVARCHAR(32) NOT NULL,
    [name] NVARCHAR(180) NOT NULL,
    [stepType] NVARCHAR(60) NOT NULL,
    [stageKind] NVARCHAR(20) NOT NULL CONSTRAINT [WorkflowStep_stageKind_df] DEFAULT 'DECISION',
    [order] INT NOT NULL,
    [stageNo] INT NOT NULL CONSTRAINT [WorkflowStep_stageNo_df] DEFAULT 1,
    [parallelGroup] INT NOT NULL CONSTRAINT [WorkflowStep_parallelGroup_df] DEFAULT 1,
    [completionMode] NVARCHAR(20) NOT NULL CONSTRAINT [WorkflowStep_completionMode_df] DEFAULT 'ALL',
    [requiredApprovals] INT NOT NULL CONSTRAINT [WorkflowStep_requiredApprovals_df] DEFAULT 1,
    [rejectMode] NVARCHAR(30) NOT NULL CONSTRAINT [WorkflowStep_rejectMode_df] DEFAULT 'STOP',
    [assigneeType] NVARCHAR(60) NOT NULL,
    [assigneeRole] NVARCHAR(40),
    [assigneeUserId] NVARCHAR(32),
    [assigneeDepartmentId] NVARCHAR(32),
    [dueDays] INT NOT NULL CONSTRAINT [WorkflowStep_dueDays_df] DEFAULT 2,
    [requiredPermission] NVARCHAR(80),
    [requiresComment] BIT NOT NULL CONSTRAINT [WorkflowStep_requiresComment_df] DEFAULT 0,
    [requiresAttachment] BIT NOT NULL CONSTRAINT [WorkflowStep_requiresAttachment_df] DEFAULT 0,
    [canDelegate] BIT NOT NULL CONSTRAINT [WorkflowStep_canDelegate_df] DEFAULT 1,
    [canReturn] BIT NOT NULL CONSTRAINT [WorkflowStep_canReturn_df] DEFAULT 1,
    [allowSelfApproval] BIT NOT NULL CONSTRAINT [WorkflowStep_allowSelfApproval_df] DEFAULT 0,
    [entryConditionJson] NVARCHAR(max),
    [exitConditionJson] NVARCHAR(max),
    CONSTRAINT [WorkflowStep_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[WorkflowStageAssignee] (
    [id] NVARCHAR(32) NOT NULL,
    [stepId] NVARCHAR(32) NOT NULL,
    [assigneeType] NVARCHAR(40) NOT NULL,
    [userId] NVARCHAR(32),
    [roleId] NVARCHAR(32),
    [groupId] NVARCHAR(32),
    [departmentId] NVARCHAR(32),
    [sortOrder] INT NOT NULL CONSTRAINT [WorkflowStageAssignee_sortOrder_df] DEFAULT 0,
    CONSTRAINT [WorkflowStageAssignee_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[WorkflowInstance] (
    [id] NVARCHAR(32) NOT NULL,
    [documentId] NVARCHAR(32) NOT NULL,
    [workflowDefinitionId] NVARCHAR(32),
    [status] NVARCHAR(40) NOT NULL CONSTRAINT [WorkflowInstance_status_df] DEFAULT 'ACTIVE',
    [startedById] NVARCHAR(32) NOT NULL,
    [startedAt] DATETIME2 NOT NULL CONSTRAINT [WorkflowInstance_startedAt_df] DEFAULT CURRENT_TIMESTAMP,
    [completedAt] DATETIME2,
    CONSTRAINT [WorkflowInstance_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[WorkflowInstanceStage] (
    [id] NVARCHAR(32) NOT NULL,
    [instanceId] NVARCHAR(32) NOT NULL,
    [sourceStepId] NVARCHAR(32),
    [stageNo] INT NOT NULL,
    [parallelGroup] INT NOT NULL,
    [name] NVARCHAR(180) NOT NULL,
    [stageKind] NVARCHAR(20) NOT NULL CONSTRAINT [WorkflowInstanceStage_stageKind_df] DEFAULT 'DECISION',
    [completionMode] NVARCHAR(20) NOT NULL,
    [requiredApprovals] INT NOT NULL,
    [rejectMode] NVARCHAR(30) NOT NULL,
    [requiredPermission] NVARCHAR(80),
    [requiresComment] BIT NOT NULL CONSTRAINT [WorkflowInstanceStage_requiresComment_df] DEFAULT 0,
    [requiresAttachment] BIT NOT NULL CONSTRAINT [WorkflowInstanceStage_requiresAttachment_df] DEFAULT 0,
    [canDelegate] BIT NOT NULL CONSTRAINT [WorkflowInstanceStage_canDelegate_df] DEFAULT 1,
    [canReturn] BIT NOT NULL CONSTRAINT [WorkflowInstanceStage_canReturn_df] DEFAULT 1,
    [configSnapshotJson] NVARCHAR(max),
    [status] NVARCHAR(30) NOT NULL CONSTRAINT [WorkflowInstanceStage_status_df] DEFAULT 'PENDING',
    [openedAt] DATETIME2,
    [completedAt] DATETIME2,
    CONSTRAINT [WorkflowInstanceStage_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [WorkflowInstanceStage_instanceId_stageNo_parallelGroup_key] UNIQUE NONCLUSTERED ([instanceId],[stageNo],[parallelGroup])
);

-- CreateTable
CREATE TABLE [dbo].[WorkflowStageRecipient] (
    [id] NVARCHAR(32) NOT NULL,
    [instanceStageId] NVARCHAR(32) NOT NULL,
    [documentId] NVARCHAR(32) NOT NULL,
    [userId] NVARCHAR(32) NOT NULL,
    [status] NVARCHAR(20) NOT NULL CONSTRAINT [WorkflowStageRecipient_status_df] DEFAULT 'GRANTED',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [WorkflowStageRecipient_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [revokedAt] DATETIME2,
    CONSTRAINT [WorkflowStageRecipient_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [WorkflowStageRecipient_instanceStageId_userId_key] UNIQUE NONCLUSTERED ([instanceStageId],[userId])
);

-- CreateTable
CREATE TABLE [dbo].[WorkflowTask] (
    [id] NVARCHAR(32) NOT NULL,
    [instanceId] NVARCHAR(32) NOT NULL,
    [instanceStageId] NVARCHAR(32),
    [stepId] NVARCHAR(32),
    [documentId] NVARCHAR(32) NOT NULL,
    [assignedToId] NVARCHAR(32),
    [assignedRole] NVARCHAR(40),
    [status] NVARCHAR(40) NOT NULL CONSTRAINT [WorkflowTask_status_df] DEFAULT 'PENDING',
    [name] NVARCHAR(180) NOT NULL,
    [order] INT NOT NULL,
    [version] INT NOT NULL CONSTRAINT [WorkflowTask_version_df] DEFAULT 1,
    [dueAt] DATETIME2,
    [completedAt] DATETIME2,
    [delegatedFromId] NVARCHAR(32),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [WorkflowTask_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [WorkflowTask_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[WorkflowTaskCandidate] (
    [id] NVARCHAR(32) NOT NULL,
    [taskId] NVARCHAR(32) NOT NULL,
    [userId] NVARCHAR(32),
    [roleId] NVARCHAR(32),
    [groupId] NVARCHAR(32),
    [source] NVARCHAR(40) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [WorkflowTaskCandidate_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [WorkflowTaskCandidate_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[WorkflowAction] (
    [id] NVARCHAR(32) NOT NULL,
    [taskId] NVARCHAR(32),
    [documentId] NVARCHAR(32) NOT NULL,
    [userId] NVARCHAR(32) NOT NULL,
    [actionType] NVARCHAR(60) NOT NULL,
    [comment] NVARCHAR(max),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [WorkflowAction_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [WorkflowAction_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ApprovalRule] (
    [id] NVARCHAR(32) NOT NULL,
    [name] NVARCHAR(180) NOT NULL,
    [priority] INT NOT NULL CONSTRAINT [ApprovalRule_priority_df] DEFAULT 100,
    [documentTypeId] NVARCHAR(32),
    [conditionsJson] NVARCHAR(max) NOT NULL,
    [actionsJson] NVARCHAR(max) NOT NULL,
    [validFrom] DATETIME2,
    [validTo] DATETIME2,
    [isActive] BIT NOT NULL CONSTRAINT [ApprovalRule_isActive_df] DEFAULT 1,
    CONSTRAINT [ApprovalRule_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Comment] (
    [id] NVARCHAR(32) NOT NULL,
    [documentId] NVARCHAR(32) NOT NULL,
    [userId] NVARCHAR(32) NOT NULL,
    [taskId] NVARCHAR(32),
    [body] NVARCHAR(max) NOT NULL,
    [visibility] NVARCHAR(60) NOT NULL CONSTRAINT [Comment_visibility_df] DEFAULT 'INTERNAL',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Comment_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Comment_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Notification] (
    [id] NVARCHAR(32) NOT NULL,
    [userId] NVARCHAR(32) NOT NULL,
    [documentId] NVARCHAR(32),
    [taskId] NVARCHAR(32),
    [type] NVARCHAR(60) NOT NULL,
    [title] NVARCHAR(180) NOT NULL,
    [body] NVARCHAR(500) NOT NULL,
    [readAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Notification_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Notification_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[AuditLog] (
    [id] NVARCHAR(32) NOT NULL,
    [userId] NVARCHAR(32),
    [entityType] NVARCHAR(120) NOT NULL,
    [entityId] NVARCHAR(120),
    [action] NVARCHAR(120) NOT NULL,
    [beforeJson] NVARCHAR(max),
    [afterJson] NVARCHAR(max),
    [ipAddress] NVARCHAR(80),
    [userAgent] NVARCHAR(300),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AuditLog_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [AuditLog_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[AuditEvent] (
    [id] NVARCHAR(32) NOT NULL,
    [actorUserId] NVARCHAR(32),
    [substitutedForUserId] NVARCHAR(32),
    [entityType] NVARCHAR(120) NOT NULL,
    [entityId] NVARCHAR(120),
    [eventType] NVARCHAR(120) NOT NULL,
    [correlationId] NVARCHAR(64) NOT NULL,
    [recordVersion] INT,
    [statusBefore] NVARCHAR(40),
    [statusAfter] NVARCHAR(40),
    [payloadJson] NVARCHAR(max),
    [ipAddress] NVARCHAR(80),
    [userAgent] NVARCHAR(300),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AuditEvent_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [AuditEvent_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[SystemLog] (
    [id] NVARCHAR(32) NOT NULL,
    [createdAt] DATETIME2 NOT NULL,
    [level] NVARCHAR(10) NOT NULL,
    [source] NVARCHAR(20) NOT NULL,
    [message] NVARCHAR(500) NOT NULL,
    [contextJson] NVARCHAR(max),
    CONSTRAINT [SystemLog_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[AppConfig] (
    [id] NVARCHAR(32) NOT NULL,
    [key] NVARCHAR(100) NOT NULL,
    [value] NVARCHAR(500),
    [type] NVARCHAR(20) NOT NULL CONSTRAINT [AppConfig_type_df] DEFAULT 'string',
    [category] NVARCHAR(50),
    [description] NVARCHAR(300),
    [isSystem] BIT NOT NULL CONSTRAINT [AppConfig_isSystem_df] DEFAULT 0,
    [updatedAt] DATETIME2 NOT NULL,
    [updatedById] NVARCHAR(32),
    CONSTRAINT [AppConfig_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [AppConfig_key_key] UNIQUE NONCLUSTERED ([key])
);

-- CreateTable
CREATE TABLE [dbo].[OutboxMessage] (
    [id] NVARCHAR(32) NOT NULL,
    [topic] NVARCHAR(120) NOT NULL,
    [aggregateType] NVARCHAR(120) NOT NULL,
    [aggregateId] NVARCHAR(120) NOT NULL,
    [payloadJson] NVARCHAR(max) NOT NULL,
    [availableAt] DATETIME2 NOT NULL CONSTRAINT [OutboxMessage_availableAt_df] DEFAULT CURRENT_TIMESTAMP,
    [processedAt] DATETIME2,
    [lockedAt] DATETIME2,
    [lockedBy] NVARCHAR(120),
    [attempts] INT NOT NULL CONSTRAINT [OutboxMessage_attempts_df] DEFAULT 0,
    [lastError] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [OutboxMessage_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [OutboxMessage_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[DocumentNumberSequence] (
    [id] NVARCHAR(32) NOT NULL,
    [scope] NVARCHAR(80) NOT NULL,
    [year] INT NOT NULL,
    [nextValue] INT NOT NULL CONSTRAINT [DocumentNumberSequence_nextValue_df] DEFAULT 1,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [DocumentNumberSequence_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [DocumentNumberSequence_scope_year_key] UNIQUE NONCLUSTERED ([scope],[year])
);

-- CreateTable
CREATE TABLE [dbo].[dictionaries] (
    [id] NVARCHAR(32) NOT NULL,
    [type] NVARCHAR(80) NOT NULL,
    [key] NVARCHAR(120) NOT NULL,
    [value] NVARCHAR(240) NOT NULL,
    [isActive] BIT NOT NULL CONSTRAINT [dictionaries_isActive_df] DEFAULT 1,
    CONSTRAINT [dictionaries_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [dictionaries_type_key_key] UNIQUE NONCLUSTERED ([type],[key])
);

-- CreateTable
CREATE TABLE [dbo].[CostCenter] (
    [id] NVARCHAR(32) NOT NULL,
    [code] NVARCHAR(60) NOT NULL,
    [name] NVARCHAR(180) NOT NULL,
    [departmentId] NVARCHAR(32),
    [isActive] BIT NOT NULL CONSTRAINT [CostCenter_isActive_df] DEFAULT 1,
    CONSTRAINT [CostCenter_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [CostCenter_code_key] UNIQUE NONCLUSTERED ([code])
);

-- CreateTable
CREATE TABLE [dbo].[Project] (
    [id] NVARCHAR(32) NOT NULL,
    [code] NVARCHAR(60) NOT NULL,
    [name] NVARCHAR(180) NOT NULL,
    [managerId] NVARCHAR(32),
    [costCenterId] NVARCHAR(32),
    [isActive] BIT NOT NULL CONSTRAINT [Project_isActive_df] DEFAULT 1,
    CONSTRAINT [Project_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Project_code_key] UNIQUE NONCLUSTERED ([code])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [User_departmentId_idx] ON [dbo].[User]([departmentId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [User_managerId_idx] ON [dbo].[User]([managerId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [User_isActive_role_idx] ON [dbo].[User]([isActive], [role]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Session_userId_revokedAt_expiresAt_idx] ON [dbo].[Session]([userId], [revokedAt], [expiresAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Session_expiresAt_idx] ON [dbo].[Session]([expiresAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [RateLimitBucket_expiresAt_idx] ON [dbo].[RateLimitBucket]([expiresAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [UserRole_roleId_validTo_idx] ON [dbo].[UserRole]([roleId], [validTo]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [GroupMember_userId_validTo_idx] ON [dbo].[GroupMember]([userId], [validTo]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Department_parentDepartmentId_idx] ON [dbo].[Department]([parentDepartmentId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Department_managerId_idx] ON [dbo].[Department]([managerId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OrganizationUnit_parentId_idx] ON [dbo].[OrganizationUnit]([parentId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OrganizationUnit_departmentId_idx] ON [dbo].[OrganizationUnit]([departmentId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [UserSubstitution_userId_validFrom_validTo_idx] ON [dbo].[UserSubstitution]([userId], [validFrom], [validTo]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DocumentType_defaultWorkflowId_idx] ON [dbo].[DocumentType]([defaultWorkflowId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DocumentType_isActive_category_idx] ON [dbo].[DocumentType]([isActive], [category]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DocumentTypeVersion_documentTypeId_status_version_idx] ON [dbo].[DocumentTypeVersion]([documentTypeId], [status], [version]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DocumentFieldDefinition_documentTypeVersionId_sortOrder_idx] ON [dbo].[DocumentFieldDefinition]([documentTypeVersionId], [sortOrder]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ValidationRule_documentTypeVersionId_status_sortOrder_idx] ON [dbo].[ValidationRule]([documentTypeVersionId], [status], [sortOrder]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ValidationRule_fieldDefinitionId_idx] ON [dbo].[ValidationRule]([fieldDefinitionId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AttachmentRequirement_documentTypeVersionId_status_idx] ON [dbo].[AttachmentRequirement]([documentTypeVersionId], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DocumentStatusDefinition_documentTypeVersionId_sortOrder_idx] ON [dbo].[DocumentStatusDefinition]([documentTypeVersionId], [sortOrder]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DocumentTransition_fromStatusId_toStatusId_idx] ON [dbo].[DocumentTransition]([fromStatusId], [toStatusId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Document_status_updatedAt_idx] ON [dbo].[Document]([status], [updatedAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Document_typeId_status_updatedAt_idx] ON [dbo].[Document]([typeId], [status], [updatedAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Document_typeVersionId_idx] ON [dbo].[Document]([typeVersionId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Document_authorId_status_updatedAt_idx] ON [dbo].[Document]([authorId], [status], [updatedAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Document_departmentId_status_idx] ON [dbo].[Document]([departmentId], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DocumentFieldProjection_fieldKey_stringValue_idx] ON [dbo].[DocumentFieldProjection]([fieldKey], [stringValue]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DocumentFieldProjection_fieldKey_numberValue_idx] ON [dbo].[DocumentFieldProjection]([fieldKey], [numberValue]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DocumentFieldProjection_fieldKey_dateValue_idx] ON [dbo].[DocumentFieldProjection]([fieldKey], [dateValue]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DocumentAccessPolicy_documentId_permission_isActive_idx] ON [dbo].[DocumentAccessPolicy]([documentId], [permission], [isActive]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DocumentAccessPolicy_documentTypeId_permission_isActive_priority_idx] ON [dbo].[DocumentAccessPolicy]([documentTypeId], [permission], [isActive], [priority]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DocumentFile_documentId_createdAt_idx] ON [dbo].[DocumentFile]([documentId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DocumentFile_scanStatus_createdAt_idx] ON [dbo].[DocumentFile]([scanStatus], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowDefinition_documentTypeId_isActive_version_idx] ON [dbo].[WorkflowDefinition]([documentTypeId], [isActive], [version]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowStep_workflowDefinitionId_stageNo_parallelGroup_order_idx] ON [dbo].[WorkflowStep]([workflowDefinitionId], [stageNo], [parallelGroup], [order]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowStep_assigneeUserId_idx] ON [dbo].[WorkflowStep]([assigneeUserId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowStep_assigneeDepartmentId_idx] ON [dbo].[WorkflowStep]([assigneeDepartmentId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowStageAssignee_stepId_sortOrder_idx] ON [dbo].[WorkflowStageAssignee]([stepId], [sortOrder]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowInstance_documentId_status_startedAt_idx] ON [dbo].[WorkflowInstance]([documentId], [status], [startedAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowInstance_status_startedAt_idx] ON [dbo].[WorkflowInstance]([status], [startedAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowInstanceStage_instanceId_status_stageNo_idx] ON [dbo].[WorkflowInstanceStage]([instanceId], [status], [stageNo]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowStageRecipient_userId_status_documentId_idx] ON [dbo].[WorkflowStageRecipient]([userId], [status], [documentId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowStageRecipient_documentId_status_idx] ON [dbo].[WorkflowStageRecipient]([documentId], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowTask_assignedToId_status_dueAt_idx] ON [dbo].[WorkflowTask]([assignedToId], [status], [dueAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowTask_assignedRole_status_dueAt_idx] ON [dbo].[WorkflowTask]([assignedRole], [status], [dueAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowTask_documentId_status_idx] ON [dbo].[WorkflowTask]([documentId], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowTask_instanceId_status_order_idx] ON [dbo].[WorkflowTask]([instanceId], [status], [order]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowTask_instanceStageId_status_idx] ON [dbo].[WorkflowTask]([instanceStageId], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowTaskCandidate_taskId_idx] ON [dbo].[WorkflowTaskCandidate]([taskId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowTaskCandidate_userId_taskId_idx] ON [dbo].[WorkflowTaskCandidate]([userId], [taskId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowTaskCandidate_roleId_taskId_idx] ON [dbo].[WorkflowTaskCandidate]([roleId], [taskId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowTaskCandidate_groupId_taskId_idx] ON [dbo].[WorkflowTaskCandidate]([groupId], [taskId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowAction_documentId_createdAt_idx] ON [dbo].[WorkflowAction]([documentId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowAction_taskId_createdAt_idx] ON [dbo].[WorkflowAction]([taskId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WorkflowAction_userId_createdAt_idx] ON [dbo].[WorkflowAction]([userId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ApprovalRule_documentTypeId_isActive_priority_idx] ON [dbo].[ApprovalRule]([documentTypeId], [isActive], [priority]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ApprovalRule_isActive_validFrom_validTo_idx] ON [dbo].[ApprovalRule]([isActive], [validFrom], [validTo]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Comment_documentId_createdAt_idx] ON [dbo].[Comment]([documentId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Comment_taskId_createdAt_idx] ON [dbo].[Comment]([taskId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Notification_userId_readAt_createdAt_idx] ON [dbo].[Notification]([userId], [readAt], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Notification_documentId_createdAt_idx] ON [dbo].[Notification]([documentId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Notification_taskId_idx] ON [dbo].[Notification]([taskId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AuditLog_entityType_entityId_createdAt_idx] ON [dbo].[AuditLog]([entityType], [entityId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AuditLog_createdAt_idx] ON [dbo].[AuditLog]([createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AuditEvent_entityType_entityId_createdAt_idx] ON [dbo].[AuditEvent]([entityType], [entityId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AuditEvent_correlationId_idx] ON [dbo].[AuditEvent]([correlationId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AuditEvent_actorUserId_createdAt_idx] ON [dbo].[AuditEvent]([actorUserId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [SystemLog_createdAt_idx] ON [dbo].[SystemLog]([createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [SystemLog_level_createdAt_idx] ON [dbo].[SystemLog]([level], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OutboxMessage_processedAt_availableAt_lockedAt_idx] ON [dbo].[OutboxMessage]([processedAt], [availableAt], [lockedAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OutboxMessage_aggregateType_aggregateId_createdAt_idx] ON [dbo].[OutboxMessage]([aggregateType], [aggregateId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CostCenter_departmentId_idx] ON [dbo].[CostCenter]([departmentId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Project_managerId_idx] ON [dbo].[Project]([managerId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Project_costCenterId_idx] ON [dbo].[Project]([costCenterId]);

-- AddForeignKey
ALTER TABLE [dbo].[User] ADD CONSTRAINT [User_departmentId_fkey] FOREIGN KEY ([departmentId]) REFERENCES [dbo].[Department]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[User] ADD CONSTRAINT [User_positionId_fkey] FOREIGN KEY ([positionId]) REFERENCES [dbo].[Position]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[User] ADD CONSTRAINT [User_managerId_fkey] FOREIGN KEY ([managerId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Session] ADD CONSTRAINT [Session_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[UserRole] ADD CONSTRAINT [UserRole_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[UserRole] ADD CONSTRAINT [UserRole_roleId_fkey] FOREIGN KEY ([roleId]) REFERENCES [dbo].[Role]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[RolePermission] ADD CONSTRAINT [RolePermission_roleId_fkey] FOREIGN KEY ([roleId]) REFERENCES [dbo].[Role]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[RolePermission] ADD CONSTRAINT [RolePermission_permissionId_fkey] FOREIGN KEY ([permissionId]) REFERENCES [dbo].[Permission]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[GroupMember] ADD CONSTRAINT [GroupMember_groupId_fkey] FOREIGN KEY ([groupId]) REFERENCES [dbo].[Group]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[GroupMember] ADD CONSTRAINT [GroupMember_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Department] ADD CONSTRAINT [Department_parentDepartmentId_fkey] FOREIGN KEY ([parentDepartmentId]) REFERENCES [dbo].[Department]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Department] ADD CONSTRAINT [Department_managerId_fkey] FOREIGN KEY ([managerId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OrganizationUnit] ADD CONSTRAINT [OrganizationUnit_parentId_fkey] FOREIGN KEY ([parentId]) REFERENCES [dbo].[OrganizationUnit]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OrganizationUnit] ADD CONSTRAINT [OrganizationUnit_departmentId_fkey] FOREIGN KEY ([departmentId]) REFERENCES [dbo].[Department]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[UserSubstitution] ADD CONSTRAINT [UserSubstitution_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[UserSubstitution] ADD CONSTRAINT [UserSubstitution_substituteUserId_fkey] FOREIGN KEY ([substituteUserId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DocumentType] ADD CONSTRAINT [DocumentType_defaultWorkflowId_fkey] FOREIGN KEY ([defaultWorkflowId]) REFERENCES [dbo].[WorkflowDefinition]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DocumentTypeVersion] ADD CONSTRAINT [DocumentTypeVersion_documentTypeId_fkey] FOREIGN KEY ([documentTypeId]) REFERENCES [dbo].[DocumentType]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DocumentFieldDefinition] ADD CONSTRAINT [DocumentFieldDefinition_documentTypeVersionId_fkey] FOREIGN KEY ([documentTypeVersionId]) REFERENCES [dbo].[DocumentTypeVersion]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ValidationRule] ADD CONSTRAINT [ValidationRule_documentTypeVersionId_fkey] FOREIGN KEY ([documentTypeVersionId]) REFERENCES [dbo].[DocumentTypeVersion]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ValidationRule] ADD CONSTRAINT [ValidationRule_fieldDefinitionId_fkey] FOREIGN KEY ([fieldDefinitionId]) REFERENCES [dbo].[DocumentFieldDefinition]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[AttachmentRequirement] ADD CONSTRAINT [AttachmentRequirement_documentTypeVersionId_fkey] FOREIGN KEY ([documentTypeVersionId]) REFERENCES [dbo].[DocumentTypeVersion]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DocumentStatusDefinition] ADD CONSTRAINT [DocumentStatusDefinition_documentTypeVersionId_fkey] FOREIGN KEY ([documentTypeVersionId]) REFERENCES [dbo].[DocumentTypeVersion]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DocumentTransition] ADD CONSTRAINT [DocumentTransition_documentTypeVersionId_fkey] FOREIGN KEY ([documentTypeVersionId]) REFERENCES [dbo].[DocumentTypeVersion]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DocumentTransition] ADD CONSTRAINT [DocumentTransition_fromStatusId_fkey] FOREIGN KEY ([fromStatusId]) REFERENCES [dbo].[DocumentStatusDefinition]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DocumentTransition] ADD CONSTRAINT [DocumentTransition_toStatusId_fkey] FOREIGN KEY ([toStatusId]) REFERENCES [dbo].[DocumentStatusDefinition]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Document] ADD CONSTRAINT [Document_typeId_fkey] FOREIGN KEY ([typeId]) REFERENCES [dbo].[DocumentType]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Document] ADD CONSTRAINT [Document_typeVersionId_fkey] FOREIGN KEY ([typeVersionId]) REFERENCES [dbo].[DocumentTypeVersion]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Document] ADD CONSTRAINT [Document_authorId_fkey] FOREIGN KEY ([authorId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Document] ADD CONSTRAINT [Document_departmentId_fkey] FOREIGN KEY ([departmentId]) REFERENCES [dbo].[Department]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Document] ADD CONSTRAINT [Document_costCenterId_fkey] FOREIGN KEY ([costCenterId]) REFERENCES [dbo].[CostCenter]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Document] ADD CONSTRAINT [Document_projectId_fkey] FOREIGN KEY ([projectId]) REFERENCES [dbo].[Project]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DocumentFieldProjection] ADD CONSTRAINT [DocumentFieldProjection_documentId_fkey] FOREIGN KEY ([documentId]) REFERENCES [dbo].[Document]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DocumentAccessPolicy] ADD CONSTRAINT [DocumentAccessPolicy_documentTypeId_fkey] FOREIGN KEY ([documentTypeId]) REFERENCES [dbo].[DocumentType]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DocumentAccessPolicy] ADD CONSTRAINT [DocumentAccessPolicy_documentId_fkey] FOREIGN KEY ([documentId]) REFERENCES [dbo].[Document]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DocumentFile] ADD CONSTRAINT [DocumentFile_documentId_fkey] FOREIGN KEY ([documentId]) REFERENCES [dbo].[Document]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DocumentFile] ADD CONSTRAINT [DocumentFile_uploadedById_fkey] FOREIGN KEY ([uploadedById]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowDefinition] ADD CONSTRAINT [WorkflowDefinition_documentTypeId_fkey] FOREIGN KEY ([documentTypeId]) REFERENCES [dbo].[DocumentType]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowStep] ADD CONSTRAINT [WorkflowStep_workflowDefinitionId_fkey] FOREIGN KEY ([workflowDefinitionId]) REFERENCES [dbo].[WorkflowDefinition]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowStep] ADD CONSTRAINT [WorkflowStep_assigneeUserId_fkey] FOREIGN KEY ([assigneeUserId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowStep] ADD CONSTRAINT [WorkflowStep_assigneeDepartmentId_fkey] FOREIGN KEY ([assigneeDepartmentId]) REFERENCES [dbo].[Department]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowStageAssignee] ADD CONSTRAINT [WorkflowStageAssignee_stepId_fkey] FOREIGN KEY ([stepId]) REFERENCES [dbo].[WorkflowStep]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowStageAssignee] ADD CONSTRAINT [WorkflowStageAssignee_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowStageAssignee] ADD CONSTRAINT [WorkflowStageAssignee_roleId_fkey] FOREIGN KEY ([roleId]) REFERENCES [dbo].[Role]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowStageAssignee] ADD CONSTRAINT [WorkflowStageAssignee_groupId_fkey] FOREIGN KEY ([groupId]) REFERENCES [dbo].[Group]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowStageAssignee] ADD CONSTRAINT [WorkflowStageAssignee_departmentId_fkey] FOREIGN KEY ([departmentId]) REFERENCES [dbo].[Department]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowInstance] ADD CONSTRAINT [WorkflowInstance_documentId_fkey] FOREIGN KEY ([documentId]) REFERENCES [dbo].[Document]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowInstance] ADD CONSTRAINT [WorkflowInstance_workflowDefinitionId_fkey] FOREIGN KEY ([workflowDefinitionId]) REFERENCES [dbo].[WorkflowDefinition]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowInstance] ADD CONSTRAINT [WorkflowInstance_startedById_fkey] FOREIGN KEY ([startedById]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowInstanceStage] ADD CONSTRAINT [WorkflowInstanceStage_instanceId_fkey] FOREIGN KEY ([instanceId]) REFERENCES [dbo].[WorkflowInstance]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowInstanceStage] ADD CONSTRAINT [WorkflowInstanceStage_sourceStepId_fkey] FOREIGN KEY ([sourceStepId]) REFERENCES [dbo].[WorkflowStep]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowStageRecipient] ADD CONSTRAINT [WorkflowStageRecipient_instanceStageId_fkey] FOREIGN KEY ([instanceStageId]) REFERENCES [dbo].[WorkflowInstanceStage]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowStageRecipient] ADD CONSTRAINT [WorkflowStageRecipient_documentId_fkey] FOREIGN KEY ([documentId]) REFERENCES [dbo].[Document]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowStageRecipient] ADD CONSTRAINT [WorkflowStageRecipient_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowTask] ADD CONSTRAINT [WorkflowTask_instanceId_fkey] FOREIGN KEY ([instanceId]) REFERENCES [dbo].[WorkflowInstance]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowTask] ADD CONSTRAINT [WorkflowTask_instanceStageId_fkey] FOREIGN KEY ([instanceStageId]) REFERENCES [dbo].[WorkflowInstanceStage]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowTask] ADD CONSTRAINT [WorkflowTask_stepId_fkey] FOREIGN KEY ([stepId]) REFERENCES [dbo].[WorkflowStep]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowTask] ADD CONSTRAINT [WorkflowTask_documentId_fkey] FOREIGN KEY ([documentId]) REFERENCES [dbo].[Document]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowTask] ADD CONSTRAINT [WorkflowTask_assignedToId_fkey] FOREIGN KEY ([assignedToId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowTask] ADD CONSTRAINT [WorkflowTask_delegatedFromId_fkey] FOREIGN KEY ([delegatedFromId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowTaskCandidate] ADD CONSTRAINT [WorkflowTaskCandidate_taskId_fkey] FOREIGN KEY ([taskId]) REFERENCES [dbo].[WorkflowTask]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowTaskCandidate] ADD CONSTRAINT [WorkflowTaskCandidate_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowTaskCandidate] ADD CONSTRAINT [WorkflowTaskCandidate_roleId_fkey] FOREIGN KEY ([roleId]) REFERENCES [dbo].[Role]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowTaskCandidate] ADD CONSTRAINT [WorkflowTaskCandidate_groupId_fkey] FOREIGN KEY ([groupId]) REFERENCES [dbo].[Group]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowAction] ADD CONSTRAINT [WorkflowAction_taskId_fkey] FOREIGN KEY ([taskId]) REFERENCES [dbo].[WorkflowTask]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowAction] ADD CONSTRAINT [WorkflowAction_documentId_fkey] FOREIGN KEY ([documentId]) REFERENCES [dbo].[Document]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[WorkflowAction] ADD CONSTRAINT [WorkflowAction_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ApprovalRule] ADD CONSTRAINT [ApprovalRule_documentTypeId_fkey] FOREIGN KEY ([documentTypeId]) REFERENCES [dbo].[DocumentType]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Comment] ADD CONSTRAINT [Comment_documentId_fkey] FOREIGN KEY ([documentId]) REFERENCES [dbo].[Document]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Comment] ADD CONSTRAINT [Comment_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Comment] ADD CONSTRAINT [Comment_taskId_fkey] FOREIGN KEY ([taskId]) REFERENCES [dbo].[WorkflowTask]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Notification] ADD CONSTRAINT [Notification_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Notification] ADD CONSTRAINT [Notification_documentId_fkey] FOREIGN KEY ([documentId]) REFERENCES [dbo].[Document]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Notification] ADD CONSTRAINT [Notification_taskId_fkey] FOREIGN KEY ([taskId]) REFERENCES [dbo].[WorkflowTask]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[AuditLog] ADD CONSTRAINT [AuditLog_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[AuditEvent] ADD CONSTRAINT [AuditEvent_actorUserId_fkey] FOREIGN KEY ([actorUserId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[AuditEvent] ADD CONSTRAINT [AuditEvent_substitutedForUserId_fkey] FOREIGN KEY ([substitutedForUserId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[AppConfig] ADD CONSTRAINT [AppConfig_updatedById_fkey] FOREIGN KEY ([updatedById]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CostCenter] ADD CONSTRAINT [CostCenter_departmentId_fkey] FOREIGN KEY ([departmentId]) REFERENCES [dbo].[Department]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Project] ADD CONSTRAINT [Project_managerId_fkey] FOREIGN KEY ([managerId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Project] ADD CONSTRAINT [Project_costCenterId_fkey] FOREIGN KEY ([costCenterId]) REFERENCES [dbo].[CostCenter]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Ograniczenia i indeksy, których schemat Prismy dla SQL Server nie potrafi zadeklarować.
-- Nie usuwaj ich, żeby wyrównać `prisma migrate diff` (zob. prisma/MIGRATIONS.md).
ALTER TABLE [dbo].[Document]
ADD CONSTRAINT [CK_Document_DataJson_IsJson] CHECK (ISJSON([dataJson]) = 1);

ALTER TABLE [dbo].[Document]
ADD CONSTRAINT [CK_Document_MetadataJson_IsJson] CHECK ([metadataJson] IS NULL OR ISJSON([metadataJson]) = 1);

-- Najwyżej jeden aktywny obieg dokumentu.
CREATE UNIQUE INDEX [UX_WorkflowInstance_ActiveDocument]
ON [dbo].[WorkflowInstance]([documentId])
WHERE [status] = N'ACTIVE';

CREATE INDEX [IX_WorkflowTask_RoleStatusDue]
ON [dbo].[WorkflowTask]([assignedRole], [status], [dueAt])
INCLUDE ([documentId], [instanceId]);

-- Indeksy filtrowane: wiele kont może nie mieć loginu ani aktywnego linku resetu.
CREATE UNIQUE NONCLUSTERED INDEX [User_login_key] ON [dbo].[User]([login]) WHERE [login] IS NOT NULL;
CREATE NONCLUSTERED INDEX [User_resetTokenHash_idx] ON [dbo].[User]([resetTokenHash]) WHERE [resetTokenHash] IS NOT NULL;

-- Klucze systemowe konfiguracji. Puste wartości SMTP oznaczają ustawienia z pliku .env.
INSERT INTO [dbo].[AppConfig] ([id], [key], [value], [type], [category], [description], [isSystem], [updatedAt]) VALUES
    (N'cfg_smtp_host', N'SMTP_HOST', NULL, N'string', N'Email', N'Serwer poczty wychodzącej. Wpisany: cały zestaw SMTP z tej tabeli. Pusty: cały zestaw z pliku .env.', 1, SYSUTCDATETIME()),
    (N'cfg_smtp_port', N'SMTP_PORT', NULL, N'number', N'Email', N'Port serwera poczty (465 = SSL, 587 = STARTTLS).', 1, SYSUTCDATETIME()),
    (N'cfg_smtp_secure', N'SMTP_SECURE', NULL, N'boolean', N'Email', N'Połączenie szyfrowane od początku (SSL). Port 465 włącza je zawsze.', 1, SYSUTCDATETIME()),
    (N'cfg_smtp_user', N'SMTP_USER', NULL, N'string', N'Email', N'Login do serwera poczty.', 1, SYSUTCDATETIME()),
    (N'cfg_smtp_password', N'SMTP_PASSWORD', NULL, N'string', N'Email', N'Hasło do serwera poczty.', 1, SYSUTCDATETIME()),
    (N'cfg_smtp_from', N'SMTP_FROM', NULL, N'string', N'Email', N'Nadawca maili, np. Aprobis <adres@example.com>.', 1, SYSUTCDATETIME()),
    (N'cfg_app_version', N'APP_VERSION', NULL, N'string', N'System', N'Numer wersji pokazywany w menu, ustawiany przy starcie z package.json. Po zmianie numeru przez 2 dni widać „Nowa wersja”.', 1, SYSUTCDATETIME()),
    (N'cfg_easter_egg', N'EASTER_EGG_ENABLED', N'false', N'boolean', N'System', N'Ukryta gra pod numerem wersji w menu (7 kliknięć). Domyślnie wyłączona. Wyłączenie blokuje kolejne uruchomienia, trwającej partii nie przerywa.', 1, SYSUTCDATETIME());

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
