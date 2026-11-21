import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { asyncHandler, AppError, requireParam } from "../../shared/http.js";
import { prisma } from "../../shared/prisma.js";

export const notificationRouter = Router();

notificationRouter.use(authenticate);

notificationRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const [items, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.user!.id, ...(req.query.unread === "true" ? { readAt: null } : {}) },
        orderBy: { createdAt: "desc" },
        take: 50
      }),
      prisma.notification.count({ where: { userId: req.user!.id, readAt: null } })
    ]);
    res.json({ items, unreadCount });
  })
);

notificationRouter.patch(
  "/read-all",
  asyncHandler(async (req, res) => {
    const result = await prisma.notification.updateMany({
      where: { userId: req.user!.id, readAt: null },
      data: { readAt: new Date() }
    });
    res.json({ updated: result.count });
  })
);

notificationRouter.patch(
  "/:id/read",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    // Zakres po userId gwarantuje, że można oznaczyć tylko własne powiadomienie.
    const result = await prisma.notification.updateMany({
      where: { id, userId: req.user!.id },
      data: { readAt: new Date() }
    });
    if (!result.count) throw new AppError(404, "Nie znaleziono powiadomienia");
    res.json({ id, readAt: new Date() });
  })
);
