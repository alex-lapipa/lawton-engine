// Serverless function: POST /api/retrieve
// Body: { query: string, filters?: { topic?, cefr?, skill?, format? }, limit?: number }
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { query, filters = {}, limit = 8 } = req.body || {};
    if (!query) return res.status(400).json({ error: "Missing 'query'" });

    // 1) Get query embedding from OpenAI (text-embedding-3-small → 1536 dims)
    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: query
      })
    });
    if (!embRes.ok) {
      const t = await embRes.text();
      throw new Error(`OpenAI error: ${t}`);
    }
    const embJson = await embRes.json();
    const qvec = embJson.data[0].embedding;

    // 2) Filter first; then vector similarity sort in SQL
    const { topic, cefr, skill, format } = filters;

    // Build dynamic filter fragments
    const conds = [];
    const params = [];
    if (topic) { params.push(topic); conds.push(`topic = $${params.length}`); }
    if (cefr)  { params.push(cefr);  conds.push(`cefr = $${params.length}`); }
    if (skill) { params.push(skill); conds.push(`skill = $${params.length}`); }
    if (format){ params.push(format);conds.push(`format = $${params.length}`); }
    const where = conds.length ? `where ${conds.join(" and ")}` : "";

    // IMPORTANT: Supabase SQL over RPC helper (we’ll emulate using PostgREST RPC via a prepared function).
    // Simpler path: use a standard 'select' and let pgvector operator run server-side via RPC function.
    // To avoid custom SQL right now, we’ll fetch a filtered set and let Postgres do similarity via `order`.
    // Here we use a Supabase Edge function-like query with `select` limited by filters, then client rerank as fallback.

    const { data, error } = await supabase
      .from("chunks")
      .select("chunk_id, doc_id, topic, cefr, skill, format, difficulty, section, order_in_doc, sharepoint_url, text, embedding")
      .match({
        ...(topic ? { topic } : {}),
        ...(cefr ? { cefr } : {}),
        ...(skill ? { skill } : {}),
        ...(format ? { format } : {}),
      })
      .limit(200); // small candidate set

    if (error) throw error;
    if (!data) return res.json({ results: [] });

    // 3) Rerank in memory by cosine similarity
    function cosine(a, b) {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        dot += x * y; na += x * x; nb += y * y;
      }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    const scored = data
      .filter(r => Array.isArray(r.embedding))
      .map(r => ({ ...r, score: cosine(qvec, r.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(50, limit)));

    // Strip embeddings from response
    const results = scored.map(({ embedding, ...rest }) => rest);

    return res.json({ results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
