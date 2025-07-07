import type { NextApiRequest, NextApiResponse } from "next";

import { getCalendar } from "@calcom/app-store/_utils/getCalendar";
import { CalendarCache } from "@calcom/features/calendar-cache/calendar-cache";
import { getCredentialForCalendarCache } from "@calcom/lib/delegationCredential/server";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import prisma from "@calcom/prisma";

const log = logger.getSubLogger({ prefix: ["office365calendar/webhook"] });

interface MicrosoftGraphNotification {
  subscriptionId: string;
  subscriptionExpirationDateTime: string;
  changeType: "created" | "updated" | "deleted";
  resource: string;
  resourceData: {
    "@odata.type": string;
    "@odata.id": string;
    "@odata.etag": string;
    id: string;
  };
  clientState?: string;
  tenantId: string;
}

interface MicrosoftGraphWebhookPayload {
  value: MicrosoftGraphNotification[];
  validationTokens?: string[];
}

const handleWebhookValidation = (req: NextApiRequest, res: NextApiResponse) => {
  const validationToken = req.query.validationToken as string;

  if (validationToken) {
    log.info("Webhook validation request received");
    // Microsoft Graph validation - respond with the validation token
    res.status(200).send(validationToken);
    return true;
  }

  return false;
};

const processNotification = async (notification: MicrosoftGraphNotification) => {
  log.debug("Processing notification", safeStringify(notification));

  try {
    // Extract credential ID from clientState
    const clientState = notification.clientState;
    if (!clientState) {
      log.warn("No clientState in notification");
      return;
    }

    const credentialId = parseInt(clientState.split("-")[0], 10);
    if (isNaN(credentialId)) {
      log.warn("Invalid credential ID in clientState", { clientState });
      return;
    }

    // Get the credential
    const credential = await prisma.credential.findFirst({
      where: {
        id: credentialId,
        type: "office365_calendar",
      },
      include: {
        selectedCalendars: true,
      },
    });

    if (!credential) {
      log.warn("Credential not found", { credentialId });
      return;
    }

    // Initialize calendar service
    const credentialForCalendarCache = await getCredentialForCalendarCache({ credentialId });
    const calendarService = await getCalendar(credentialForCalendarCache);

    if (!calendarService) {
      log.warn("Calendar service not found", { credentialId });
      return;
    }

    // Invalidate cache and refresh availability
    const calendarCache = await CalendarCache.init(calendarService);

    // For Outlook, we'll clear existing cache and fetch fresh data
    // This is a simple approach - in production you might want to be more selective
    const { selectedCalendars } = credential;

    if (selectedCalendars.length > 0) {
      await calendarService.fetchAvailabilityAndSetCache?.(selectedCalendars);
      log.info("Successfully refreshed calendar cache", {
        credentialId,
        calendarCount: selectedCalendars.length,
      });
    }
  } catch (error) {
    log.error("Error processing notification", safeStringify({ error, notification }));
  }
};

async function postHandler(req: NextApiRequest, res: NextApiResponse) {
  // Handle webhook validation
  if (handleWebhookValidation(req, res)) {
    return;
  }

  try {
    const payload: MicrosoftGraphWebhookPayload = req.body;

    if (!payload.value || !Array.isArray(payload.value)) {
      log.warn("Invalid webhook payload", safeStringify(payload));
      return res.status(400).json({ error: "Invalid payload" });
    }

    log.info(`Received ${payload.value.length} notification(s) from Microsoft Graph`);

    // Process all notifications
    const processingPromises = payload.value.map(processNotification);
    await Promise.allSettled(processingPromises);

    res.status(200).json({ message: "ok" });
  } catch (error) {
    log.error("Error handling webhook", safeStringify(error));
    res.status(500).json({ error: "Internal server error" });
  }
}

async function getHandler(req: NextApiRequest, res: NextApiResponse) {
  // Handle webhook validation for GET requests
  if (handleWebhookValidation(req, res)) {
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === "POST") {
      await postHandler(req, res);
    } else if (req.method === "GET") {
      await getHandler(req, res);
    } else {
      res.status(405).json({ error: "Method not allowed" });
    }
  } catch (error) {
    log.error("Unhandled error in webhook handler", safeStringify(error));
    res.status(500).json({ error: "Internal server error" });
  }
}
