const crypto = require('crypto');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const ADMIN_KEY = process.env.NATEFLIX_ADMIN_KEY || '';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body); } catch { return {}; }
}
function clean(v, max) {
  return String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}
function configured() { return !!(REDIS_URL && REDIS_TOKEN); }
async function redis(command) {
  if (!configured()) throw new Error('Community storage is not configured yet.');
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || `Redis ${r.status}`);
  return data.result;
}
async function pipeline(commands) {
  if (!configured()) throw new Error('Community storage is not configured yet.');
  const r = await fetch(`${REDIS_URL.replace(/\/$/, '')}/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commands)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Redis ${r.status}`);
  return data;
}
const itemKey = id => `nateflix:item:${id}`;
const titleKey = imdb => `nateflix:title:${imdb}:takes`;
const publicSuggestionsKey = 'nateflix:suggestions:public';
const privateSuggestionsKey = 'nateflix:suggestions:private';

async function readItems(ids) {
  if (!ids?.length) return [];
  const vals = await redis(['MGET', ...ids.map(itemKey)]);
  return (vals || []).map(v => {
    if (!v) return null;
    try { return JSON.parse(v); } catch { return null; }
  }).filter(Boolean);
}
async function rateLimit(req) {
  const raw = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 18);
  const bucket = Math.floor(Date.now() / 3600000);
  const key = `nateflix:rate:${hash}:${bucket}`;
  const result = await pipeline([['INCR', key], ['EXPIRE', key, 3700]]);
  const count = Number(result?.[0]?.result || 0);
  if (count > 15) throw new Error('Too many posts from this connection. Try again later.');
}
function isAdmin(key) {
  if (!ADMIN_KEY || !key) return false;
  const a = Buffer.from(String(key));
  const b = Buffer.from(String(ADMIN_KEY));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sortNewest(items) {
  return items.sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
async function listSuggestions(includePrivate=false) {
  const pubIds = await redis(['ZREVRANGE', publicSuggestionsKey, 0, 99]) || [];
  let items = await readItems(pubIds);
  if (includePrivate) {
    const privIds = await redis(['ZREVRANGE', privateSuggestionsKey, 0, 99]) || [];
    items = items.concat(await readItems(privIds));
  }
  return sortNewest(items);
}
async function listTitle(imdb) {
  const ids = await redis(['ZREVRANGE', titleKey(imdb), 0, 99]) || [];
  return readItems(ids);
}
async function saveRecord(record, indexKey) {
  await pipeline([
    ['SET', itemKey(record.id), JSON.stringify(record)],
    ['ZADD', indexKey, Date.parse(record.createdAt), record.id]
  ]);
}
async function getRecord(id) {
  const v = await redis(['GET', itemKey(id)]);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
async function deleteRecord(record) {
  const cmds = [['DEL', itemKey(record.id)]];
  if (record.kind === 'suggestion') {
    cmds.push(['ZREM', record.visibility === 'private' ? privateSuggestionsKey : publicSuggestionsKey, record.id]);
    if (record.privateToken) cmds.push(['DEL', `nateflix:private-token:${record.privateToken}`]);
  } else if (record.kind === 'titleTake' && record.imdb) {
    cmds.push(['ZREM', titleKey(record.imdb), record.id]);
  }
  await pipeline(cmds);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, {ok:true});
  if (!configured()) return json(res, 503, {error:'Community storage is not configured yet.'});

  try {
    if (req.method === 'GET') {
      const scope = clean(req.query?.scope, 20);
      if (scope === 'suggestions') return json(res, 200, {items: await listSuggestions(false)});
      if (scope === 'title') {
        const imdb = clean(req.query?.imdb, 20);
        if (!/^tt\d{5,12}$/.test(imdb)) return json(res, 400, {error:'Invalid title id.'});
        return json(res, 200, {items: await listTitle(imdb)});
      }
      return json(res, 400, {error:'Unknown request.'});
    }

    if (req.method !== 'POST') return json(res, 405, {error:'Method not allowed.'});
    const body = parseBody(req);
    const action = clean(body.action, 30);

    if (action === 'suggestion') {
      await rateLimit(req);
      const name = clean(body.name, 40) || 'Anonymous';
      const text = clean(body.text, 600);
      const topic = ['site','missing','watch','rating','other'].includes(body.topic) ? body.topic : 'other';
      const visibility = body.visibility === 'private' ? 'private' : 'public';
      if (!text) return json(res, 400, {error:'Suggestion text is required.'});
      const id = crypto.randomUUID();
      const privateToken = visibility === 'private' ? crypto.randomBytes(18).toString('hex') : null;
      const record = {id,kind:'suggestion',name,text,topic,visibility,createdAt:new Date().toISOString(),reply:null};
      if (privateToken) record.privateToken = privateToken;
      await saveRecord(record, visibility === 'private' ? privateSuggestionsKey : publicSuggestionsKey);
      if (privateToken) await redis(['SET', `nateflix:private-token:${privateToken}`, id]);
      return json(res, 200, {ok:true,id,privateToken});
    }

    if (action === 'titleTake') {
      await rateLimit(req);
      const imdb = clean(body.imdb, 20);
      const title = clean(body.title, 180);
      const name = clean(body.name, 40);
      const text = clean(body.text, 240);
      if (!/^tt\d{5,12}$/.test(imdb)) return json(res, 400, {error:'Invalid title id.'});
      if (!name) return json(res, 400, {error:'Name is required.'});
      if (!text) return json(res, 400, {error:'Take text is required.'});
      const id = crypto.randomUUID();
      const record = {id,kind:'titleTake',imdb,title,name,text,createdAt:new Date().toISOString()};
      await saveRecord(record, titleKey(imdb));
      return json(res, 200, {ok:true,id});
    }

    if (action === 'privateStatus') {
      const token = clean(body.token, 80);
      if (!token) return json(res, 400, {error:'Missing private token.'});
      const id = await redis(['GET', `nateflix:private-token:${token}`]);
      if (!id) return json(res, 200, {item:null});
      const item = await getRecord(id);
      if (!item || item.visibility !== 'private') return json(res, 200, {item:null});
      return json(res, 200, {item});
    }

    if (action === 'ownerList') {
      if (!isAdmin(body.adminKey)) return json(res, 401, {error:'Owner key was not accepted.'});
      return json(res, 200, {items: await listSuggestions(true)});
    }

    if (action === 'ownerReply') {
      if (!isAdmin(body.adminKey)) return json(res, 401, {error:'Owner key was not accepted.'});
      const id = clean(body.id, 80), text = clean(body.text, 600);
      if (!text) return json(res, 400, {error:'Reply text is required.'});
      const item = await getRecord(id);
      if (!item || item.kind !== 'suggestion') return json(res, 404, {error:'Suggestion not found.'});
      item.reply = {text,createdAt:new Date().toISOString()};
      await redis(['SET', itemKey(id), JSON.stringify(item)]);
      return json(res, 200, {ok:true});
    }

    if (action === 'ownerDelete') {
      if (!isAdmin(body.adminKey)) return json(res, 401, {error:'Owner key was not accepted.'});
      const id = clean(body.id, 80);
      const item = await getRecord(id);
      if (!item) return json(res, 404, {error:'Post not found.'});
      await deleteRecord(item);
      return json(res, 200, {ok:true});
    }

    return json(res, 400, {error:'Unknown action.'});
  } catch (err) {
    return json(res, 500, {error:String(err?.message || 'Community request failed.')});
  }
};
