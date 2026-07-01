export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY)
    return res.status(500).json({ error: 'Supabase env vars missing' });

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
  };

  const uid = req.method === 'GET' ? req.query.uid : req.body?.uid;
  if (!uid) return res.status(400).json({ error: 'uid required' });

  try {
    if (req.method === 'GET') {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/nutri_data?uid=eq.${encodeURIComponent(uid)}&select=data`,
        { headers }
      );
      const text = await r.text();
      if (!r.ok) return res.status(200).json(null);
      const rows = JSON.parse(text);
      return res.status(200).json(rows?.[0]?.data || null);
    }

    if (req.method === 'POST') {
      const { data } = req.body;
      if (!data) return res.status(400).json({ error: 'no data' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/nutri_data`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ uid, data, updated_at: new Date().toISOString() }),
      });
      const text = await r.text();
      if (!r.ok) return res.status(200).json({ ok: false, status: r.status, detail: text.slice(0, 200) });
      return res.status(200).json({ ok: true });
    }

    res.status(405).end();
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}