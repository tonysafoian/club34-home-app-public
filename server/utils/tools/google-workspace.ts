import { getGoogleServiceToken, getServiceClient } from "../janus-tools.js";
import type { SupabaseClient } from "../supabase.js";

async function shareFileWithUser(fileId: string, email: string, token: string): Promise<void> {
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "user", role: "writer", emailAddress: email }),
    });
    if (!res.ok) console.error(`Share with ${email} failed: ${await res.text()}`);
  } catch (e) { console.error(`Share error for ${email}:`, e); }
}

const SLIDE_THEME = {
  accent: { red: 0.11, green: 0.29, blue: 0.53 },
  accentLight: { red: 0.85, green: 0.91, blue: 0.97 },
  titleColor: { red: 0.12, green: 0.14, blue: 0.22 },
  bodyColor: { red: 0.24, green: 0.26, blue: 0.32 },
  subtitleColor: { red: 0.42, green: 0.44, blue: 0.50 },
  white: { red: 1, green: 1, blue: 1 },
  titleFont: "Montserrat",
  bodyFont: "Open Sans",
};

interface ParsedSlide {
  title: string;
  body: string;
  hasBullets: boolean;
  boldRanges: { start: number; end: number }[];
  cleanBody: string;
}

function parseSlideContent(raw: string): ParsedSlide {
  const lines = raw.split("\n");
  const title = lines[0].replace(/^#+\s*/, "").trim();
  const bodyLines = lines.slice(1);
  const rawBody = bodyLines.join("\n").trim();

  const hasBullets = bodyLines.some(l => /^\s*[-*•]\s/.test(l));

  let cleanBody = rawBody.replace(/^\s*[-*•]\s+/gm, "");

  const boldRanges: { start: number; end: number }[] = [];
  let processed = "";
  const boldRegex = /\*\*(.+?)\*\*/g;
  let match;
  let lastEnd = 0;
  while ((match = boldRegex.exec(cleanBody)) !== null) {
    processed += cleanBody.slice(lastEnd, match.index);
    const boldStart = processed.length;
    processed += match[1];
    boldRanges.push({ start: boldStart, end: processed.length });
    lastEnd = match.index + match[0].length;
  }
  processed += cleanBody.slice(lastEnd);
  cleanBody = processed || cleanBody;

  return { title, body: rawBody, hasBullets, boldRanges, cleanBody };
}

async function slidesBatchUpdate(fileId: string, requests: any[], token: string): Promise<{ ok: boolean; error?: string }> {
  if (requests.length === 0) return { ok: true };
  const res = await fetch(`https://slides.googleapis.com/v1/presentations/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`Slides batchUpdate failed: ${errText}`);
    return { ok: false, error: errText.slice(0, 300) };
  }
  return { ok: true };
}

export async function buildBeautifulSlides(fileId: string, content: string, token: string): Promise<string | null> {
  const slideTexts = content.split("---").map(s => s.trim()).filter(Boolean);
  if (slideTexts.length === 0) return null;

  const parsed = slideTexts.map(parseSlideContent);

  const createReqs: any[] = [];
  for (let i = 0; i < parsed.length; i++) {
    let layout: string;
    if (i === 0) {
      layout = parsed[i].body ? "TITLE" : "TITLE_ONLY";
    } else if (!parsed[i].cleanBody) {
      layout = "SECTION_HEADER";
    } else {
      layout = "TITLE_AND_BODY";
    }
    createReqs.push({
      createSlide: {
        objectId: `cslide_${i}`,
        insertionIndex: i + 1,
        slideLayoutReference: { predefinedLayout: layout },
      },
    });
  }
  const createResult = await slidesBatchUpdate(fileId, createReqs, token);
  if (!createResult.ok) return `TOOL_ERROR: Presentation created but slides failed: ${createResult.error}`;

  const presResp = await fetch(`https://slides.googleapis.com/v1/presentations/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!presResp.ok) return `TOOL_ERROR: Could not read presentation after creating slides`;
  const presData = await presResp.json();
  const allSlides: any[] = presData.slides || [];

  const slideMap = new Map<string, any>();
  for (const s of allSlides) slideMap.set(s.objectId, s);
  const defaultSlideId = allSlides.length > 0 ? allSlides[0].objectId : null;

  const contentReqs: any[] = [];
  const formatReqs: any[] = [];
  const bulletReqs: any[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const slideId = `cslide_${i}`;
    const slide = slideMap.get(slideId);
    if (!slide) continue;

    const { title, cleanBody, hasBullets, boldRanges } = parsed[i];
    const placeholders = (slide.pageElements || []).filter((el: any) => el.shape?.placeholder);
    const titlePh = placeholders.find((p: any) =>
      p.shape.placeholder.type === "TITLE" || p.shape.placeholder.type === "CENTERED_TITLE"
    );
    const bodyPh = placeholders.find((p: any) =>
      p.shape.placeholder.type === "BODY" || p.shape.placeholder.type === "SUBTITLE"
    );

    if (titlePh && title) {
      contentReqs.push({ insertText: { objectId: titlePh.objectId, text: title } });
      const titleSize = i === 0 ? 36 : (cleanBody ? 28 : 32);
      formatReqs.push({
        updateTextStyle: {
          objectId: titlePh.objectId,
          textRange: { type: "ALL" },
          style: {
            fontFamily: SLIDE_THEME.titleFont,
            fontSize: { magnitude: titleSize, unit: "PT" },
            bold: true,
            foregroundColor: { opaqueColor: { rgbColor: i === 0 ? SLIDE_THEME.white : SLIDE_THEME.titleColor } },
          },
          fields: "fontFamily,fontSize,bold,foregroundColor",
        },
      });
    }

    const bodyTarget = bodyPh?.objectId || null;
    let bodyFallbackId: string | null = null;

    if (cleanBody && !bodyPh) {
      bodyFallbackId = `bfb_${i}`;
      contentReqs.push(
        { createShape: { objectId: bodyFallbackId, shapeType: "TEXT_BOX", elementProperties: { pageObjectId: slide.objectId, size: { width: { magnitude: 600, unit: "PT" }, height: { magnitude: 340, unit: "PT" } }, transform: { scaleX: 1, scaleY: 1, translateX: 60, translateY: 160, unit: "PT" } } } },
      );
    }

    const bodyObjId = bodyTarget || bodyFallbackId;
    if (bodyObjId && cleanBody) {
      contentReqs.push({ insertText: { objectId: bodyObjId, text: cleanBody } });
      const bodySize = i === 0 ? 18 : 14;
      formatReqs.push({
        updateTextStyle: {
          objectId: bodyObjId,
          textRange: { type: "ALL" },
          style: {
            fontFamily: SLIDE_THEME.bodyFont,
            fontSize: { magnitude: bodySize, unit: "PT" },
            foregroundColor: { opaqueColor: { rgbColor: i === 0 ? SLIDE_THEME.subtitleColor : SLIDE_THEME.bodyColor } },
          },
          fields: "fontFamily,fontSize,foregroundColor",
        },
      });
      formatReqs.push({
        updateParagraphStyle: {
          objectId: bodyObjId,
          textRange: { type: "ALL" },
          style: { lineSpacing: 150, spaceAbove: { magnitude: 4, unit: "PT" } },
          fields: "lineSpacing,spaceAbove",
        },
      });
      for (const br of boldRanges) {
        formatReqs.push({
          updateTextStyle: {
            objectId: bodyObjId,
            textRange: { type: "FIXED_RANGE", startIndex: br.start, endIndex: br.end },
            style: { bold: true },
            fields: "bold",
          },
        });
      }
      if (hasBullets && i !== 0) {
        bulletReqs.push({
          createParagraphBullets: {
            objectId: bodyObjId,
            textRange: { type: "ALL" },
            bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
          },
        });
      }
    }

    if (!titlePh && !bodyPh && !cleanBody && title) {
      const tbId = `fb_${i}`;
      contentReqs.push(
        { createShape: { objectId: tbId, shapeType: "TEXT_BOX", elementProperties: { pageObjectId: slide.objectId, size: { width: { magnitude: 600, unit: "PT" }, height: { magnitude: 400, unit: "PT" } }, transform: { scaleX: 1, scaleY: 1, translateX: 50, translateY: 50, unit: "PT" } } } },
        { insertText: { objectId: tbId, text: title } },
      );
    }
  }

  const contentResult = await slidesBatchUpdate(fileId, contentReqs, token);
  if (!contentResult.ok) return `TOOL_ERROR: Slides content population failed: ${contentResult.error}`;

  const bgReqs: any[] = [];
  const firstSlide = slideMap.get("cslide_0");
  if (firstSlide) {
    bgReqs.push({
      updatePageProperties: {
        objectId: firstSlide.objectId,
        pageProperties: {
          pageBackgroundFill: {
            solidFill: { color: { rgbColor: SLIDE_THEME.accent } },
          },
        },
        fields: "pageBackgroundFill.solidFill.color",
      },
    });
  }
  for (let i = 1; i < parsed.length; i++) {
    const slide = slideMap.get(`cslide_${i}`);
    if (!slide) continue;
    if (!parsed[i].cleanBody) {
      bgReqs.push({
        updatePageProperties: {
          objectId: slide.objectId,
          pageProperties: {
            pageBackgroundFill: {
              solidFill: { color: { rgbColor: SLIDE_THEME.accentLight } },
            },
          },
          fields: "pageBackgroundFill.solidFill.color",
        },
      });
      const sectionPhs = (slide.pageElements || []).filter((el: any) => el.shape?.placeholder);
      const sectionTitle = sectionPhs.find((p: any) =>
        p.shape.placeholder.type === "TITLE" || p.shape.placeholder.type === "CENTERED_TITLE"
      );
      if (sectionTitle) {
        formatReqs.push({
          updateTextStyle: {
            objectId: sectionTitle.objectId,
            textRange: { type: "ALL" },
            style: {
              foregroundColor: { opaqueColor: { rgbColor: SLIDE_THEME.accent } },
            },
            fields: "foregroundColor",
          },
        });
      }
    } else {
      const barId = `bar_${i}`;
      bgReqs.push({
        createShape: {
          objectId: barId,
          shapeType: "RECTANGLE",
          elementProperties: {
            pageObjectId: slide.objectId,
            size: { width: { magnitude: 720, unit: "PT" }, height: { magnitude: 4, unit: "PT" } },
            transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: "PT" },
          },
        },
      });
      formatReqs.push({
        updateShapeProperties: {
          objectId: barId,
          shapeProperties: {
            shapeBackgroundFill: { solidFill: { color: { rgbColor: SLIDE_THEME.accent } } },
            outline: { outlineFill: { solidFill: { color: { rgbColor: SLIDE_THEME.accent } } }, weight: { magnitude: 0, unit: "PT" } },
          },
          fields: "shapeBackgroundFill.solidFill.color,outline",
        },
      });
    }
  }

  if (bgReqs.length > 0) {
    const bgResult = await slidesBatchUpdate(fileId, bgReqs, token);
    if (!bgResult.ok) console.error(`Slides background styling failed (non-fatal): ${bgResult.error}`);
  }
  if (formatReqs.length > 0) {
    const fmtResult = await slidesBatchUpdate(fileId, formatReqs, token);
    if (!fmtResult.ok) console.error(`Slides text formatting failed (non-fatal): ${fmtResult.error}`);
  }
  if (bulletReqs.length > 0) {
    const bulResult = await slidesBatchUpdate(fileId, bulletReqs, token);
    if (!bulResult.ok) console.error(`Slides bullet formatting failed (non-fatal): ${bulResult.error}`);
  }

  if (defaultSlideId) {
    await slidesBatchUpdate(fileId, [{ deleteObject: { objectId: defaultSlideId } }], token);
  }

  return null;
}

export async function executeCreateGoogleFile(
  fileType: string,
  title: string,
  content: string,
  shareWith?: string[],
  userId?: string,
  svc?: SupabaseClient,
): Promise<string> {
  try {
    const scopes = [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/presentations",
    ];
    const token = await getGoogleServiceToken(scopes);
    let fileUrl = "";
    let fileId = "";

    if (fileType === "doc") {
      const createRes = await fetch("https://docs.googleapis.com/v1/documents", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!createRes.ok) return `TOOL_ERROR: Doc creation failed: ${await createRes.text()}`;
      const doc = await createRes.json();
      fileId = doc.documentId;
      fileUrl = `https://docs.google.com/document/d/${fileId}`;
      await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content } }] }),
      });
    } else if (fileType === "sheet") {
      const rows = content.split("\n").map(line => line.split("|").map(cell => cell.trim()));
      const createRes = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { title }, sheets: [{ properties: { title: "Sheet1" } }] }),
      });
      if (!createRes.ok) return `TOOL_ERROR: Sheet creation failed: ${await createRes.text()}`;
      const sheet = await createRes.json();
      fileId = sheet.spreadsheetId;
      fileUrl = `https://docs.google.com/spreadsheets/d/${fileId}`;
      if (rows.length > 0) {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ values: rows }),
        });
      }
    } else if (fileType === "slides") {
      const createRes = await fetch("https://slides.googleapis.com/v1/presentations", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!createRes.ok) return `TOOL_ERROR: Slides creation failed: ${await createRes.text()}`;
      const pres = await createRes.json();
      fileId = pres.presentationId;
      fileUrl = `https://docs.google.com/presentation/d/${fileId}`;
      const buildErr = await buildBeautifulSlides(fileId, content, token);
      if (buildErr) return buildErr;
    } else if (fileType === "form") {
      const createRes = await fetch("https://forms.googleapis.com/v1/forms", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ info: { title } }),
      });
      if (!createRes.ok) return `TOOL_ERROR: Form creation failed: ${await createRes.text()}`;
      const form = await createRes.json();
      fileId = form.formId;
      fileUrl = form.responderUri || `https://docs.google.com/forms/d/${fileId}`;
      const questions = content.split("\n").map(q => q.trim()).filter(Boolean);
      if (questions.length > 0) {
        const requests = questions.map((q, i) => ({
          createItem: {
            item: { title: q, questionItem: { question: { required: false, textQuestion: { paragraph: false } } } },
            location: { index: i },
          },
        }));
        await fetch(`https://forms.googleapis.com/v1/forms/${fileId}:batchUpdate`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ requests }),
        });
      }
    } else {
      return `TOOL_ERROR: Unknown file type "${fileType}". Supported: doc, sheet, slides, form.`;
    }

    if (userId) {
      const sb = svc || getServiceClient();
      const { data: member } = await sb.from("household_members").select("email").eq("supabase_uuid", userId).single();
      if (member?.email) await shareFileWithUser(fileId, member.email, token);
    }
    if (shareWith?.length) {
      for (const email of shareWith) {
        await shareFileWithUser(fileId, email, token);
      }
    }

    const typeLabel = fileType === "doc" ? "Google Doc" : fileType === "sheet" ? "Google Sheet" : fileType === "slides" ? "Google Slides" : "Google Form";
    return `✅ Created ${typeLabel}: "${title}" — ${fileUrl}`;
  } catch (e) {
    return `TOOL_ERROR: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

export async function executeAttachFileToNotion(pageId: string, base64Data: string, filename: string, mimeType: string): Promise<string> {
  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_API_KEY) return "Notion API key not configured.";
  const UPLOAD_VERSION = "2025-09-03";
  const NOTION_BASE = "https://api.notion.com/v1";
  try {
    const createRes = await fetch(`${NOTION_BASE}/file_uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${NOTION_API_KEY}`, "Notion-Version": UPLOAD_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const createData = await createRes.json();
    if (!createRes.ok) return `TOOL_ERROR: Failed to create upload slot: ${createData.message || createRes.status}`;
    const fileUploadId = createData.id;

    const bytes = Buffer.from(base64Data, "base64");
    const blob = new Blob([bytes], { type: mimeType || "application/octet-stream" });
    const formData = new FormData();
    formData.append("file", blob, filename || "attachment");
    const sendRes = await fetch(`${NOTION_BASE}/file_uploads/${fileUploadId}/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${NOTION_API_KEY}`, "Notion-Version": UPLOAD_VERSION },
      body: formData,
    });
    const sendData = await sendRes.json();
    if (!sendRes.ok) return `TOOL_ERROR: Failed to upload file: ${sendData.message || sendRes.status}`;

    const isImage = mimeType.startsWith("image/");
    const blockType = isImage ? "image" : "file";
    const blockContent = { type: "uploaded", uploaded: { file_id: fileUploadId } };
    const children = [{ type: blockType, [blockType]: blockContent }];
    const appendRes = await fetch(`${NOTION_BASE}/blocks/${pageId}/children`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${NOTION_API_KEY}`, "Notion-Version": UPLOAD_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({ children }),
    });
    const appendData = await appendRes.json();
    if (!appendRes.ok) return `TOOL_ERROR: Failed to append block: ${appendData.message || appendRes.status}`;

    return `✅ ${isImage ? "Image" : "File"} "${filename}" attached to Notion page successfully.`;
  } catch (e) {
    return `TOOL_ERROR: ${e instanceof Error ? e.message : "unknown error"}`;
  }
}
