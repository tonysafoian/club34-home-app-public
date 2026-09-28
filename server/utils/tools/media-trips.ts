import { getServiceClient } from "../janus-tools.js";
import type { SupabaseClient } from "../supabase.js";

export type RequestContext = {
  svc: SupabaseClient;
  projectId?: string;
  role?: string;
  imageSSECallback?: (base64: string, mime: string) => void;
};

export async function executeGenerateMedia(
  prompt: string,
  type: "image" | "video",
  emailTo: string,
  whatsappNumber?: string,
  userId?: string,
  platform?: string,
  ctx?: RequestContext,
): Promise<string> {
  const BASE_URL = `http://localhost:${process.env.PORT || 5000}`;
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;

  if (type === "image") {
    try {
      let base64: string;
      let mimeType: string;
      const useFal = platform === "fal";

      if (useFal) {
        const FAL_API_KEY = process.env.FAL_API_KEY;
        if (!FAL_API_KEY) return "FAL_API_KEY not configured.";
        console.log("Generating image via FAL FLUX Pro...");
        const falRes = await fetch("https://fal.run/fal-ai/flux-pro/v1.1-ultra", {
          method: "POST",
          headers: { Authorization: `Key ${FAL_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, num_images: 1, enable_safety_checker: false }),
        });
        if (!falRes.ok) { const err = await falRes.text(); return `FAL image generation failed (HTTP ${falRes.status}): ${err.slice(0, 200)}`; }
        const falData = await falRes.json();
        const imageUrl = falData.images?.[0]?.url;
        if (!imageUrl) return "FAL image generation failed: no image URL returned.";
        const imgRes = await fetch(imageUrl);
        if (!imgRes.ok) return "Failed to download FAL image.";
        const imgBuf = Buffer.from(await imgRes.arrayBuffer());
        base64 = imgBuf.toString("base64");
        mimeType = falData.images?.[0]?.content_type || "image/jpeg";
      } else {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-image",
            messages: [{ role: "user", content: prompt }],
            modalities: ["image", "text"],
          }),
        });
        if (!res.ok) { const err = await res.text(); return `Image generation failed (HTTP ${res.status}): ${err.slice(0, 200)}`; }
        const data = await res.json();
        const imageDataUrl =
          data.choices?.[0]?.message?.images?.[0]?.image_url?.url ||
          data.choices?.[0]?.message?.content?.find?.((p: any) => p.type === "image_url")?.image_url?.url;
        if (!imageDataUrl) return `Image generation failed: no image data returned.`;
        base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, "");
        mimeType = imageDataUrl.match(/^data:(image\/\w+);base64,/)?.[1] || "image/png";
      }

      if (ctx?.imageSSECallback) {
        ctx.imageSSECallback(base64, mimeType);
      }

      const bytes = Buffer.from(base64, "base64");
      const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
      const filename = `generated-images/${Date.now()}.${ext}`;
      const sb = ctx?.svc || getServiceClient();
      const { error } = await sb.storage.from("voice-replies").upload(filename, bytes, { contentType: mimeType, upsert: true });
      if (error) {
        console.error("Image upload failed:", error.message);
        return JSON.stringify({ success: true, type: "image", platform: useFal ? "fal" : "gemini", message: `Image generated and displayed inline in chat.` });
      }
      const { data: urlData } = sb.storage.from("voice-replies").getPublicUrl(filename);
      const publicUrl = urlData.publicUrl;

      fetch(`${BASE_URL}/api/media/worker`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "image_deliver", publicUrl, prompt, email_to: emailTo, whatsapp_number: whatsappNumber, user_id: userId }),
      }).catch((e) => console.error("Media delivery error:", e));

      return JSON.stringify({ success: true, type: "image", platform: useFal ? "fal" : "gemini", message: `Image generated and displayed in chat!` });
    } catch (e) {
      return `Image generation error: ${e instanceof Error ? e.message : "unknown"}`;
    }
  } else {
    fetch(`${BASE_URL}/api/media/worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "video", prompt, email_to: emailTo, whatsapp_number: whatsappNumber, user_id: userId }),
    }).catch((e) => console.error("Media worker error:", e));
    return `🎬 Video generation launched using Veo 3.1 Fast. This typically takes 1-2 minutes — I'll send it to you via email${whatsappNumber ? ", WhatsApp," : ""} and also ping you right here in chat when it's ready. Hang tight!`;
  }
}

export async function executeManageTrip(args: any, svc?: SupabaseClient): Promise<string> {
  try {
    const sb = svc || getServiceClient();

    if (args.action === "delete") {
      if (!args.trip_id) return "TOOL_ERROR: trip_id required for delete action.";
      const { error } = await sb.from("trips").delete().eq("id", args.trip_id);
      if (error) return `TOOL_ERROR: ${error.message}`;
      return `✅ Deleted trip "${args.trip_name}".`;
    }

    if (args.action === "update" && args.trip_id) {
      const updates: any = {};
      if (args.trip_name) updates.trip_name = args.trip_name;
      if (args.destination) updates.destination = args.destination;
      if (args.departure_date) updates.departure_date = args.departure_date;
      if (args.return_date) updates.return_date = args.return_date;
      if (args.status) updates.status = args.status;
      if (args.travelers) updates.travelers = args.travelers;
      if (args.flights) updates.flights = args.flights;
      if (args.hotels) updates.hotels = args.hotels;
      if (args.notes) updates.notes = args.notes;
      updates.updated_at = new Date().toISOString();
      const { error } = await sb.from("trips").update(updates).eq("id", args.trip_id);
      if (error) return `TOOL_ERROR: ${error.message}`;
      return `✅ Updated trip "${args.trip_name}".`;
    }

    let existingTrip: any = null;
    if (args.destination && args.departure_date) {
      const { data } = await sb.from("trips")
        .select("*")
        .eq("destination", args.destination)
        .eq("departure_date", args.departure_date)
        .maybeSingle();
      existingTrip = data;
    }

    if (existingTrip) {
      const updates: any = { updated_at: new Date().toISOString() };
      if (args.return_date) updates.return_date = args.return_date;
      if (args.status) updates.status = args.status;
      if (args.travelers?.length) updates.travelers = Array.from(new Set([...(existingTrip.travelers || []), ...args.travelers]));
      if (args.flights?.length) {
        const merged = [...(existingTrip.flights || [])];
        for (const f of args.flights) {
          if (!merged.some((e: any) => e.flight_number === f.flight_number)) merged.push(f);
        }
        updates.flights = merged;
      }
      if (args.hotels?.length) {
        const merged = [...(existingTrip.hotels || [])];
        for (const h of args.hotels) {
          if (!merged.some((e: any) => e.name === h.name && e.check_in === h.check_in)) merged.push(h);
        }
        updates.hotels = merged;
      }
      if (args.notes) updates.notes = [existingTrip.notes, args.notes].filter(Boolean).join("\n\n");
      await sb.from("trips").update(updates).eq("id", existingTrip.id);
      return `✅ Merged new information into existing trip "${existingTrip.trip_name}" (ID: ${existingTrip.id}). The trip card in the Travel section has been updated.`;
    } else {
      const { data, error } = await sb.from("trips").insert({
        trip_name: args.trip_name,
        destination: args.destination || null,
        departure_date: args.departure_date || null,
        return_date: args.return_date || null,
        status: args.status || "draft",
        travelers: args.travelers || [],
        flights: args.flights || [],
        hotels: args.hotels || [],
        itinerary: [],
        transfers: [],
        notes: args.notes || null,
        last_scanned_at: new Date().toISOString(),
      }).select("id").single();
      if (error) return `TOOL_ERROR: ${error.message}`;
      return `✅ Created trip card "${args.trip_name}" (ID: ${data?.id}). It's now visible in the Family → Travel section.`;
    }
  } catch (e) {
    return `TOOL_ERROR: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

export async function executeQueryTrips(args: any, svc?: SupabaseClient): Promise<string> {
  try {
    const sb = svc || getServiceClient();
    let query = sb.from("trips").select("*").is("deleted_at", null).order("departure_date", { ascending: true });
    if (args.status) query = query.eq("status", args.status);
    if (args.upcoming_only) query = query.gte("departure_date", new Date().toISOString().split("T")[0]);
    const { data, error } = await query.limit(20);
    if (error) return `TOOL_ERROR: ${error.message}`;
    if (!data?.length) return "No trips found matching your criteria.";
    return JSON.stringify(data.map((t: any) => ({ id: t.id, trip_name: t.trip_name, destination: t.destination, departure_date: t.departure_date, return_date: t.return_date, status: t.status, travelers: t.travelers, flights_count: (t.flights || []).length, hotels_count: (t.hotels || []).length, flights: t.flights, hotels: t.hotels, notes: t.notes })));
  } catch (e) { return `TOOL_ERROR: ${e instanceof Error ? e.message : "unknown"}`; }
}

export async function executeQueryEntertainment(args: any, svc?: SupabaseClient): Promise<string> {
  try {
    const sb = svc || getServiceClient();
    let query = sb.from("entertainment_events").select("*").order("event_date", { ascending: true });
    if (args.category) query = query.eq("category", args.category);
    if (args.upcoming_only !== false) {
      const todayLA = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      query = query.gte("event_date", todayLA);
    }
    const { data, error } = await query.limit(20);
    if (error) return `TOOL_ERROR: ${error.message}`;
    if (!data?.length) return "No entertainment events found matching your criteria.";
    return JSON.stringify(data.map((e: any) => ({ id: e.id, title: e.title, category: e.category, event_date: e.event_date, venue: e.venue, location: e.location, ticket_url: e.ticket_url, metadata: e.metadata })));
  } catch (e) { return `TOOL_ERROR: ${e instanceof Error ? e.message : "unknown"}`; }
}

export async function executeQueryMedia(args: any, svc?: SupabaseClient): Promise<string> {
  try {
    const sb = svc || getServiceClient();
    let query = sb.from("media_items").select("*").order("rank", { ascending: true });
    if (args.category) query = query.eq("category", args.category);
    const limit = args.limit || 10;
    const { data, error } = await query.limit(limit);
    if (error) return `TOOL_ERROR: ${error.message}`;
    if (!data?.length) return "No media items found matching your criteria.";
    return JSON.stringify(data.map((m: any) => ({ id: m.id, title: m.title, category: m.category, description: m.description, rating: m.rating, score: m.score, streaming_platform: m.streaming_platform, release_date: m.release_date, poster_url: m.poster_url, metadata: m.metadata })));
  } catch (e) { return `TOOL_ERROR: ${e instanceof Error ? e.message : "unknown"}`; }
}

export async function executeSuggestMovie(query: string): Promise<string> {
  try {
    const baseUrl = `http://localhost:${process.env.PORT || 5000}`;
    const res = await fetch(`${baseUrl}/api/movie/recommend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: query }),
    });
    if (!res.ok) return `TOOL_ERROR: Movie recommender returned ${res.status}`;
    const data = await res.json();
    return JSON.stringify(data);
  } catch (e) { return `TOOL_ERROR: ${e instanceof Error ? e.message : "unknown"}`; }
}
