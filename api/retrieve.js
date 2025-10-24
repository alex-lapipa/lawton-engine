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
    if (!embRes.ok) throw new Error("OpenAI error");
    const embJson = await embRes.json();
    const qvec = embJson.data[0].embedding;

    const { topic, cefr, skill, format } = filters;
    const { data, error } = await supabase
      .from("chunks")
      .select("text, topic, cefr, skill, format, sharepoint_url, embedding")
      .match({
        ...(topic ? { topic } : {}),
        ...(cefr ? { cefr } : {}),
        ...(skill ? { skill } : {}),
        ...(format ? { format } : {}),
      })
      .limit(200);

    if (error) throw error;
    const cosine = (a, b) => {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        dot += x * y; na += x * x; nb += y * y;
      }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    };

    const scored = data
      .filter(r => Array.isArray(r.embedding))
      .map(r => ({ ...r, score: cosine(qvec, r.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const results = scored.map(({ embedding, ...rest }) => rest);
    return res.json({ results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
