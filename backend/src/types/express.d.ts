import type { SystemRole } from "../shared/domain.js";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: SystemRole;
        departmentId: string | null;
        sessionId?: string;
        /** Osoby, które użytkownik właśnie zastępuje: może działać w ich zadaniach. */
        actingFor?: Array<{ id: string; role: SystemRole }>;
      };
      correlationId: string;
    }
  }
}

export {};
