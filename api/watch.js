module.exports = async function handler(req, res) {
  const key = process.env.WATCHMODE_API_KEY;
  const imdb = String(req.query?.imdb || '').trim();
  if (!key) return res.status(503).json({ error: 'WATCHMODE_API_KEY is not configured' });
  if (!/^tt\d{5,12}$/.test(imdb)) return res.status(400).json({ error: 'Invalid IMDb ID' });
  try {
    const url = `https://api.watchmode.com/v1/title/${encodeURIComponent(imdb)}/sources/?regions=US`;
    const r = await fetch(url, { headers: { 'X-API-Key': key, 'Accept': 'application/json' } });
    if (!r.ok) return res.status(r.status).json({ error: `Watchmode returned ${r.status}` });
    const sources = await r.json();
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    return res.status(200).json({ imdb, sources: Array.isArray(sources) ? sources : [] });
  } catch (e) {
    return res.status(500).json({ error: 'Streaming availability lookup failed' });
  }
};
