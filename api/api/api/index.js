// Serverless function: POST /api/index
// Header required: x-lawton-service-key: <SUPABASE_SERVICE_ROLE_KEY>
// Body expects: { sharepoint_url, path, title, mime_type, topic, cefr, skill, format, difficulty, tags, error_patterns, text }
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function authorized(req) {
  const token = req.headers["x-lawton-service-key"] || req.headers["X-Lawton-Service-Key"];
  return token && token === SUPABASE_SERVICE_ROLE_KEY;
}

function chunk(text, max = 1000) {
  const chunks = [];
  let order = 0;
  const parts = text.split(/\n(?=Rule|Examples|Drill|Exercise|Assessment|Dialogue|Audio)/gi);
  for (const p of parts) {
    for (let i = 0; i < p.length; i += max) {
      chunks.push({ text: p.slice(i, i + max), section: "auto", order_in_doc: order++ });
    }
  }
  return chunks.length ? chunks : [{ text, section: "auto", order_in_doc: 0 }];
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const {
      sharepoint_url, path, title, mime_type,
      topic, cefr, skill, format, difficulty, tags, error_patterns,
      text
    } = req.body || {};

    if (!text || !sharepoint_url || !path) {
      return res.status(400).json({ error: "Missing required fields: text, sharepoint_url, path" });
    }

    // 1) Upsert document (by path)
    const { data: up, error: upErr } = await supabase
      .from("documents")
      .upsert({ sharepoint_url, path, title, mime_type }, { onConflict: "path" })
      .select("doc_id")
      .single();
    if (upErr) throw upErr;
    const doc_id = up.doc_id;

    // 2) Chunk + embed + insert
    const chunks = chunk(text);
    let inserted = 0;

    for (const c of chunks) {
      // Create embedding for each chunk
      const embRes = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: c.text
        })
      });
      if (!embRes.ok) {
        const t = await embRes.text();
        throw new Error(`OpenAI error: ${t}`);
      }
      const embJson = await embRes.json();
      const embedding = embJson.data[0].embedding;

      const { error: insErr } = await supabase.from("chunks").insert({
        doc_id,
        text: c.text,
        embedding,
        bm25_terms: null,
        topic, cefr, skill, format, difficulty,
        tags, error_patterns,
        section: c.section,
        order_in_doc: c.order_in_doc,
        sharepoint_url
      });
      if (insErr) throw insErr;
      inserted++;
    }

    return res.json({ ok: true, doc_id, chunks_inserted: inserted });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
