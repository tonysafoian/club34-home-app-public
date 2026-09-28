import { Router } from "express";
import type { Request, Response } from "express";
import { handleChat } from "../handlers/chat.js";
import { handleEmailPoll } from "../handlers/email-poll.js";
import { handleWhatsApp } from "../handlers/whatsapp.js";
import { handleResearchWorker } from "../handlers/research-worker.js";
import { handleMediaWorker } from "../handlers/media-worker.js";
import { handleReminderDispatch } from "../handlers/reminder-dispatch.js";
import { handleHealthCheck } from "../handlers/health-check.js";
import { handleFunctionalTest } from "../handlers/functional-test.js";
import { handleTokenExpirationWarnings } from "../handlers/token-expiration-warnings.js";
import { requireAuth } from "../auth";
import { storage } from "../storage";
import { insertJanusNotificationSchema } from "../../shared/schema";
import { emitToUser } from "../socket";
import { logAudit } from "../lib/auditLog.js";
import { sendGmailRaw, type ServiceAccountKey } from "../lib/helpers.js";

const janusRouter = Router();

janusRouter.all("/chat", handleChat);
janusRouter.all("/chat/ping", handleChat);

janusRouter.post("/email-poll", handleEmailPoll);
janusRouter.get("/email-poll/ping", handleEmailPoll);

janusRouter.post("/whatsapp", handleWhatsApp);
janusRouter.get("/whatsapp/ping", handleWhatsApp);

janusRouter.post("/research-worker", handleResearchWorker);

janusRouter.post("/media-worker", handleMediaWorker);

janusRouter.post("/email", async (req: Request, res: Response) => {
  try {
    const { action, to, subject, body: textBody, html } = req.body as {
      action?: string; to?: string; subject?: string; body?: string; html?: string;
    };

    if (action !== "send") {
      res.status(400).json({ error: 'Unsupported action. Use action: "send".' });
      return;
    }
    if (!to || !subject || (!textBody && !html)) {
      res.status(400).json({ error: "Missing required fields: to, subject, body" });
      return;
    }

    const saKeyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!saKeyRaw) {
      console.error("[janus-email] GOOGLE_SERVICE_ACCOUNT_KEY not configured");
      res.status(503).json({ error: "Email service not configured" });
      return;
    }
    const saKey: ServiceAccountKey = JSON.parse(saKeyRaw);

    const htmlContent = html || `<pre style="font-family:sans-serif;white-space:pre-wrap">${(textBody || "").replace(/&/g,"&amp;").replace(/</g,"&lt;")}</pre>`;
    const textContent = textBody || subject;

    const sent = await sendGmailRaw(saKey, to, subject, htmlContent, textContent);

    if (!sent) {
      console.error(`[janus-email] Failed to send email to ${to}: ${subject}`);
      res.status(502).json({ error: "Gmail API rejected the email" });
      return;
    }

    console.log(`[janus-email] Sent to ${to}: ${subject}`);
    logAudit("janus-email-send", {
      category: "janus", event_type: "email_sent", severity: "info",
      actor_id: "system", actor_name: "System", channel: "email",
      summary: `Email sent to ${to}: ${subject.slice(0, 80)}`,
      status: "success",
    });

    res.json({ ok: true, to, subject });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[janus-email] Error:", msg);
    res.status(500).json({ error: msg });
  }
});

janusRouter.post("/reminder-dispatch", handleReminderDispatch);

janusRouter.post("/health-check", handleHealthCheck);

janusRouter.post("/functional-test", handleFunctionalTest);

janusRouter.post("/token-expiration-warnings", handleTokenExpirationWarnings);

janusRouter.get("/notifications", requireAuth, async (req, res, next) => {
  try {
    const notifications = await storage.getJanusNotifications(req.user!.userId);
    res.json(notifications);
  } catch (err) {
    next(err);
  }
});

janusRouter.post("/notifications", requireAuth, async (req: Request, res, next) => {
  try {
    const parsed = insertJanusNotificationSchema.parse(req.body);
    const notification = await storage.createJanusNotification(parsed);

    emitToUser(notification.userId, "janus:notification", {
      userId: notification.userId,
      message: notification.message,
      type: notification.type,
      mediaUrl: notification.mediaUrl,
    });

    logAudit("janus-notifications", {
      category: "janus", event_type: "notification_created", severity: "info",
      actor_id: req.user?.userId || "UNKNOWN", actor_name: req.user?.displayName || req.user?.email || "UNKNOWN",
      channel: "web", summary: `Janus notification sent: "${notification.message?.slice(0, 80)}"`,
      detail: { type: notification.type, has_media: !!notification.mediaUrl }, status: "success",
    });

    res.status(201).json(notification);
  } catch (err) {
    next(err);
  }
});

janusRouter.patch("/notifications/:id", requireAuth, async (req, res, next) => {
  try {
    const notification = await storage.updateJanusNotification(String(req.params.id), req.body);
    if (!notification) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }
    res.json(notification);
  } catch (err) {
    next(err);
  }
});

janusRouter.delete("/notifications/:id", requireAuth, async (req, res, next) => {
  try {
    await storage.deleteJanusNotification(String(req.params.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default janusRouter;
