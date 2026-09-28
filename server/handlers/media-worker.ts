import type { Request, Response } from "express";
import { createClient } from "../utils/supabase.js";
import { getGoogleServiceToken } from "../utils/google-jwt.js";
import { logEmail } from "../lib/helpers.js";

const JANUS_EMAIL = "assistant@example.com";

const VEO_MODELS = [
  "veo-3.1-fast-generate-001",
  "veo-2.0-generate-001",
];

async function sendWhatsAppMedia(
  to: string,
  mediaUrl: string,
  caption: string,
): Promise<void> {
  const rawEndpoint = process.env.WATI_API_ENDPOINT;
  let token = process.env.WATI_ACCESS_TOKEN;
  if (!rawEndpoint || !token) {
    console.error("WATI not configured");
    return;
  }
  token = token.replace(/^Bearer\s+/i, "");
  const serverRoot = rawEndpoint
    .replace(/\/$/, "")
    .replace(/\/api\/ext\/v3\/?$/, "")
    .replace(/\/api\/ext\/?$/, "");
  const normalized = to.replace(/[^\d]/g, "");

  try {
    const imageRes = await fetch(
      `${serverRoot}/api/ext/v3/conversations/messages/imageMessage`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          target: normalized,
          imageUrl: mediaUrl,
          caption,
        }),
      },
    );
    if (imageRes.ok) {
      console.log(`WhatsApp image sent inline to ${normalized}`);
      return;
    }
    const errText = await imageRes.text();
    console.warn(
      "WATI imageMessage failed, falling back to text:",
      imageRes.status,
      errText,
    );
  } catch (e) {
    console.warn("WATI imageMessage error, falling back to text:", e);
  }

  try {
    const res = await fetch(
      `${serverRoot}/api/ext/v3/conversations/messages/text`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          target: normalized,
          text: `${caption}\n\n${mediaUrl}`,
        }),
      },
    );
    if (!res.ok)
      console.error(
        "WATI text fallback failed:",
        res.status,
        await res.text(),
      );
    else console.log(`WhatsApp media URL sent as text to ${normalized}`);
  } catch (e) {
    console.error("WATI error:", e);
  }
}

async function sendEmailWithMedia(
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  try {
    const token = await getGoogleServiceToken(
      ["https://mail.google.com/"],
      JANUS_EMAIL,
    );
    const boundary = `boundary_${Date.now()}`;
    const subjectEncoded = Buffer.from(subject).toString("base64");
    const mime = [
      `MIME-Version: 1.0`,
      `From: Janus <assistant@example.com>`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${subjectEncoded}?=`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      ``,
      html,
      `--${boundary}--`,
    ].join("\r\n");
    const encoded = Buffer.from(mime)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw: encoded }),
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      console.error("Email send failed:", res.status, errText);
      await logEmail("janus_media", subject, [to], html, "error", `Gmail ${res.status}: ${errText}`);
    } else {
      console.log(`Email sent to ${to}`);
      await logEmail("janus_media", subject, [to], html, "sent");
    }
  } catch (e) {
    console.error("Email error:", e);
    await logEmail("janus_media", subject, [to], html, "error", e instanceof Error ? e.message : "unknown");
  }
}

async function generateImage(
  prompt: string,
): Promise<{ base64: string; mimeType: string } | null> {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not configured");
  const res = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-image",
        messages: [{ role: "user", content: prompt }],
        modalities: ["image", "text"],
      }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Image generation API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  const imageDataUrl =
    data.choices?.[0]?.message?.images?.[0]?.image_url?.url ||
    data.choices?.[0]?.message?.content?.find?.(
      (p: { type?: string }) => p.type === "image_url",
    )?.image_url?.url;
  if (!imageDataUrl) {
    console.error(
      "Image generation response:",
      JSON.stringify(data).slice(0, 500),
    );
    return null;
  }
  const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, "");
  const mimeType =
    imageDataUrl.match(/^data:(image\/\w+);base64,/)?.[1] || "image/png";
  return { base64, mimeType };
}

async function generateImageFal(
  prompt: string,
): Promise<{ base64: string; mimeType: string } | null> {
  const FAL_API_KEY = process.env.FAL_API_KEY;
  if (!FAL_API_KEY) throw new Error("FAL_API_KEY not configured");
  const falRes = await fetch("https://fal.run/fal-ai/flux-pro/v1.1-ultra", {
    method: "POST",
    headers: {
      Authorization: `Key ${FAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      num_images: 1,
      enable_safety_checker: false,
    }),
  });
  if (!falRes.ok) {
    const err = await falRes.text();
    throw new Error(`FAL API error ${falRes.status}: ${err.slice(0, 300)}`);
  }
  const falData = await falRes.json();
  const imageUrl = falData.images?.[0]?.url;
  if (!imageUrl) return null;
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error("Failed to download FAL image");
  const imgBytes = Buffer.from(await imgRes.arrayBuffer());
  const base64 = imgBytes.toString("base64");
  const mimeType = falData.images?.[0]?.content_type || "image/jpeg";
  return { base64, mimeType };
}

async function generateVideo(
  prompt: string,
): Promise<{ videoUrl: string } | null> {
  const token = await getGoogleServiceToken([
    "https://www.googleapis.com/auth/cloud-platform",
  ]);
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY!);
  const projectId = sa.project_id;
  const location = "us-central1";

  let submitRes: globalThis.Response | null = null;
  let usedModel = "";

  for (const modelId of VEO_MODELS) {
    const endpoint = `projects/${projectId}/locations/${location}/publishers/google/models/${modelId}`;
    const submitUrl = `https://${location}-aiplatform.googleapis.com/v1/${endpoint}:predictLongRunning`;
    console.log(`Submitting Veo job using model: ${modelId}`);

    submitRes = await fetch(submitUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          durationSeconds: 8,
          aspectRatio: "16:9",
        },
      }),
    });

    if (submitRes.ok) {
      usedModel = modelId;
      console.log(`Veo model ${modelId} accepted the request`);
      break;
    }

    if (submitRes.status === 403) {
      const errText = await submitRes.text();
      console.warn(
        `Veo model ${modelId} returned 403, trying fallback. Error: ${errText.slice(0, 200)}`,
      );
      continue;
    }

    const err = await submitRes.text();
    console.error(
      `Veo submit error for ${modelId}:`,
      submitRes.status,
      err.slice(0, 500),
    );
    throw new Error(
      `Veo API error ${submitRes.status}: ${err.slice(0, 300)}`,
    );
  }

  if (!submitRes || !submitRes.ok) {
    throw new Error(
      "All Veo models are unavailable (access restricted).",
    );
  }

  const submitData = await submitRes.json();
  const operationName = submitData.name;
  if (!operationName) {
    console.error(
      "Veo submit response:",
      JSON.stringify(submitData).slice(0, 500),
    );
    throw new Error("Veo did not return an operation name");
  }
  console.log("Veo operation started:", operationName);

  const usedEndpoint = `projects/${projectId}/locations/${location}/publishers/google/models/${usedModel}`;
  const fetchOpUrl = `https://${location}-aiplatform.googleapis.com/v1/${usedEndpoint}:fetchPredictOperation`;
  const maxPolls = 60;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const pollRes = await fetch(fetchOpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operationName }),
    });
    if (!pollRes.ok) {
      console.error("Poll error:", pollRes.status, await pollRes.text());
      continue;
    }
    const pollData = await pollRes.json();
    console.log(`Veo poll ${i + 1}/${maxPolls}: done=${pollData.done}`);
    if (pollData.done) {
      if (pollData.error)
        throw new Error(
          `Veo generation failed: ${JSON.stringify(pollData.error)}`,
        );

      const base64Video =
        pollData.response?.predictions?.[0]?.bytesBase64Encoded;
      if (base64Video) {
        return { videoUrl: `data:video/mp4;base64,${base64Video}` };
      }

      const videoUri =
        pollData.response?.predictions?.[0]?.gcsUri ||
        pollData.response?.generatedSamples?.[0]?.video?.uri ||
        pollData.response?.videos?.[0]?.uri;
      if (videoUri) {
        return { videoUrl: videoUri };
      }

      console.error(
        "Veo done response:",
        JSON.stringify(pollData).slice(0, 800),
      );
      throw new Error("Veo completed but no video found in response");
    }
  }
  throw new Error("Veo video generation timed out after 5 minutes");
}

async function uploadToStorage(
  base64: string,
  filename: string,
  mimeType: string,
): Promise<string> {
  const sb = createClient();
  const bytes = Buffer.from(base64, "base64");
  const { error } = await sb.storage
    .from("voice-replies")
    .upload(filename, bytes, { contentType: mimeType, upsert: true });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  const { data: urlData } = sb.storage
    .from("voice-replies")
    .getPublicUrl(filename);
  return urlData.publicUrl;
}

async function downloadAndUploadVideo(
  videoUrl: string,
  filename: string,
  token: string,
): Promise<string> {
  const sb = createClient();

  if (videoUrl.startsWith("gs://")) {
    const withoutGs = videoUrl.slice(5);
    const slashIdx = withoutGs.indexOf("/");
    const bucket = withoutGs.slice(0, slashIdx);
    const object = withoutGs.slice(slashIdx + 1);
    videoUrl = `https://storage.googleapis.com/download/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`;
    console.log("Converted gs:// URI to GCS JSON API URL:", videoUrl);
  }

  console.log("Downloading video from:", videoUrl.slice(0, 120));
  const downloadRes = await fetch(videoUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!downloadRes.ok) {
    const errBody = await downloadRes.text();
    console.error(
      "Video download failed:",
      downloadRes.status,
      errBody.slice(0, 300),
    );
    throw new Error(
      `Video download failed: ${downloadRes.status} — ${errBody.slice(0, 200)}`,
    );
  }
  const videoBytes = Buffer.from(await downloadRes.arrayBuffer());
  console.log(
    `Downloaded ${videoBytes.length} bytes, uploading to storage...`,
  );

  const { error } = await sb.storage
    .from("voice-replies")
    .upload(filename, videoBytes, {
      contentType: "video/mp4",
      upsert: true,
    });
  if (error)
    throw new Error(`Video storage upload failed: ${error.message}`);
  const { data: urlData } = sb.storage
    .from("voice-replies")
    .getPublicUrl(filename);
  return urlData.publicUrl;
}

function buildImageEmailHtml(prompt: string, publicUrl: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e5e5e5; margin: 0; padding: 0; }
  .container { max-width: 640px; margin: 0 auto; padding: 32px 24px; }
  .header { display: flex; align-items: center; margin-bottom: 28px; }
  .logo { width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(135deg, #c8a96e, #e8c97e); display: inline-flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; color: #0f0f0f; margin-right: 12px; }
  h1 { font-size: 20px; margin: 0; color: #c8a96e; }
  .prompt-box { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 16px; margin-bottom: 24px; font-size: 14px; color: #aaa; }
  .image-container { border-radius: 12px; overflow: hidden; margin-bottom: 24px; }
  .image-container img { width: 100%; display: block; }
  .download-btn { display: inline-block; background: #c8a96e; color: #0f0f0f; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; }
  .footer { margin-top: 32px; font-size: 12px; color: #555; }
</style></head><body>
<div class="container">
  <div class="header"><div class="logo">J</div><h1>🎨 Your generated image is ready</h1></div>
  <div class="prompt-box"><strong>Prompt:</strong> ${prompt}</div>
  <div class="image-container"><img src="${publicUrl}" alt="Generated image" /></div>
  <p><a href="${publicUrl}" class="download-btn">Download Image →</a></p>
  <div class="footer">Generated by Janus using Gemini NanoBanana · Club 34</div>
</div></body></html>`;
}

function buildVideoEmailHtml(prompt: string, publicUrl: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e5e5e5; margin: 0; padding: 0; }
  .container { max-width: 640px; margin: 0 auto; padding: 32px 24px; }
  .header { display: flex; align-items: center; margin-bottom: 28px; }
  .logo { width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(135deg, #c8a96e, #e8c97e); display: inline-flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; color: #0f0f0f; margin-right: 12px; }
  h1 { font-size: 20px; margin: 0; color: #c8a96e; }
  .prompt-box { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 16px; margin-bottom: 24px; font-size: 14px; color: #aaa; }
  .video-container { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px; }
  .download-btn { display: inline-block; background: #c8a96e; color: #0f0f0f; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; }
  .footer { margin-top: 32px; font-size: 12px; color: #555; }
</style></head><body>
<div class="container">
  <div class="header"><div class="logo">J</div><h1>🎬 Your generated video is ready</h1></div>
  <div class="prompt-box"><strong>Prompt:</strong> ${prompt}</div>
  <div class="video-container">
    <div style="font-size:48px;margin-bottom:12px;">🎬</div>
    <p>Your video has been rendered by Veo 3.1 Fast.</p>
    <a href="${publicUrl}" class="download-btn">Watch / Download Video →</a>
  </div>
  <div class="footer">Generated by Janus using Google Veo 3.1 Fast · Club 34</div>
</div></body></html>`;
}

async function insertNotification(
  userId: string,
  type: string,
  message: string,
  mediaUrl: string,
): Promise<void> {
  try {
    if (!userId) return;
    const sb = createClient();
    const { error } = await sb
      .from("janus_notifications")
      .insert({ user_id: userId, type, message, media_url: mediaUrl });
    if (error) console.error("insertNotification failed:", error.message);
    else console.log("Notification inserted for user:", userId);
  } catch (e) {
    console.error("insertNotification error:", e);
  }
}

async function handleImageDeliver(
  publicUrl: string,
  prompt: string,
  emailTo: string,
  whatsappNumber?: string,
  userId?: string,
): Promise<void> {
  const subject = "🎨 Janus: Your generated image is ready";
  const html = buildImageEmailHtml(prompt, publicUrl);
  await Promise.all([
    sendEmailWithMedia(emailTo, subject, html),
    whatsappNumber
      ? sendWhatsAppMedia(
          whatsappNumber,
          publicUrl,
          `🎨 Your generated image is ready!\n\nPrompt: "${prompt}"`,
        )
      : Promise.resolve(),
  ]);
  if (userId) {
    const notifMessage = `🎨 Your image is ready!\n\n**Prompt:** "${prompt}"\n\n[View / Download Image →](${publicUrl})\n\nAlso sent to your email.`;
    await insertNotification(userId, "image_ready", notifMessage, publicUrl);
  }
}

async function handleVideoGenerate(
  prompt: string,
  emailTo: string,
  whatsappNumber?: string,
  userId?: string,
): Promise<void> {
  console.log(
    "Starting Veo video generation for prompt:",
    prompt.slice(0, 100),
  );

  let publicUrl: string;
  try {
    const result = await generateVideo(prompt);
    if (!result) throw new Error("Video generation returned no result");

    const filename = `generated-videos/${Date.now()}.mp4`;
    if (result.videoUrl.startsWith("data:video/")) {
      console.log(
        "Video delivered as base64 — uploading directly to storage",
      );
      const base64 = result.videoUrl.split(",")[1];
      publicUrl = await uploadToStorage(base64, filename, "video/mp4");
    } else {
      console.log(
        "Video delivered as URI:",
        result.videoUrl.slice(0, 80),
      );
      const token = await getGoogleServiceToken([
        "https://www.googleapis.com/auth/cloud-platform",
      ]);
      publicUrl = await downloadAndUploadVideo(
        result.videoUrl,
        filename,
        token,
      );
    }
    console.log("Video uploaded to storage:", publicUrl);
  } catch (e) {
    console.error("Video generation/download failed:", e);
    const isAccessError =
      e instanceof Error &&
      (e.message.includes("403") ||
        e.message.includes("access restricted") ||
        e.message.includes("IAM_PERMISSION_DENIED"));
    const userMessage = isAccessError
      ? "Video generation is temporarily unavailable. We're working on enabling Google's Veo model for this account."
      : "We ran into an unexpected issue while generating your video. Please try again in a few minutes.";
    const failHtml = `<div style="font-family:sans-serif;padding:24px;background:#0f0f0f;color:#e5e5e5;"><h2 style="color:#c8a96e;">🎬 Video Generation Update</h2><p><strong>Prompt:</strong> ${prompt}</p><p style="margin-top:16px;">${userMessage}</p><p style="color:#aaa;font-size:12px;margin-top:24px;">Janus · Club 34</p></div>`;
    await sendEmailWithMedia(
      emailTo,
      "🎬 Janus: Video generation update",
      failHtml,
    );
    return;
  }

  const subject = "🎬 Janus: Your generated video is ready";
  const html = buildVideoEmailHtml(prompt, publicUrl);
  await Promise.all([
    sendEmailWithMedia(emailTo, subject, html),
    whatsappNumber
      ? sendWhatsAppMedia(
          whatsappNumber,
          publicUrl,
          `🎬 Your Veo video is ready!\n\nPrompt: "${prompt}"`,
        )
      : Promise.resolve(),
  ]);
  if (userId) {
    const notifMessage = `🎬 Your video is ready!\n\n**Prompt:** "${prompt}"\n\n[▶ Watch / Download →](${publicUrl})\n\nAlso sent to your email${whatsappNumber ? " and WhatsApp" : ""}.`;
    await insertNotification(userId, "video_ready", notifMessage, publicUrl);
  }
}

async function handleFullImageGenerate(
  prompt: string,
  emailTo: string,
  whatsappNumber?: string,
  userId?: string,
  platform?: string,
): Promise<void> {
  const useFal = platform === "fal";
  console.log(
    `Generating image via ${useFal ? "FAL FLUX Pro" : "NanoBanana"} for prompt:`,
    prompt.slice(0, 100),
  );
  let publicUrl: string;
  try {
    const result = useFal
      ? await generateImageFal(prompt)
      : await generateImage(prompt);
    if (!result)
      throw new Error("Image generation returned no image data");
    const ext =
      result.mimeType.includes("jpeg") || result.mimeType.includes("jpg")
        ? "jpg"
        : "png";
    const filename = `generated-images/${Date.now()}.${ext}`;
    publicUrl = await uploadToStorage(
      result.base64,
      filename,
      result.mimeType,
    );
    console.log("Image uploaded to storage:", publicUrl);
  } catch (e) {
    console.error("Image generation failed:", e);
    const errMsg = e instanceof Error ? e.message : "Unknown error";
    const failHtml = `<div style="font-family:sans-serif;padding:24px;background:#0f0f0f;color:#e5e5e5;"><h2 style="color:#c8a96e;">🎨 Image Generation Failed</h2><p><strong>Prompt:</strong> ${prompt}</p><p><strong>Error:</strong> ${errMsg}</p><p style="color:#aaa;font-size:12px;">Generated by Janus · Club 34</p></div>`;
    await sendEmailWithMedia(
      emailTo,
      "🎨 Janus: Image generation encountered an error",
      failHtml,
    );
    return;
  }
  await handleImageDeliver(publicUrl, prompt, emailTo, whatsappNumber, userId);
}

export async function handleMediaWorker(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body;
    const {
      type,
      prompt,
      publicUrl,
      email_to,
      whatsapp_number,
      user_id,
      platform,
    } = body;

    if (!email_to) {
      res.status(400).json({ error: "email_to is required" });
      return;
    }

    if (type === "image_deliver" && publicUrl) {
      handleImageDeliver(
        publicUrl,
        prompt || "",
        email_to,
        whatsapp_number,
        user_id,
      ).catch((e) => console.error("Image deliver error:", e));
    } else if (type === "image") {
      handleFullImageGenerate(
        prompt,
        email_to,
        whatsapp_number,
        user_id,
        platform,
      ).catch((e) => console.error("Image generate error:", e));
    } else if (type === "video") {
      handleVideoGenerate(
        prompt,
        email_to,
        whatsapp_number,
        user_id,
      ).catch((e) => console.error("Video generate error:", e));
    } else {
      res.status(400).json({ error: `Unknown type: ${type}` });
      return;
    }

    res.status(202).json({ success: true, status: "processing" });
  } catch (e) {
    console.error("janus-media-worker error:", e);
    res.status(500).json({
      error: e instanceof Error ? e.message : "Unknown error",
    });
  }
}
