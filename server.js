const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { planMission } = require('./planner');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const STORE_PATH = path.join(ROOT, 'data', 'missions.json');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf' };

async function readStore() {
  try { return JSON.parse(await fs.readFile(STORE_PATH, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { missions: [] }; throw error; }
}
async function writeStore(store) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const temp = `${STORE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(store, null, 2));
  await fs.rename(temp, STORE_PATH);
}
async function body(request) {
  const chunks = [];
  for await (const chunk of request) { chunks.push(chunk); if (Buffer.concat(chunks).length > 1_000_000) throw new Error('Тело запроса превышает 1 МБ.'); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { throw new Error('Некорректный JSON.'); }
}
function json(response, status, data) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); }
function missionRecord(input, previous = {}) {
  const result = planMission(input);
  if (result.errors) return { errors: result.errors };
  const now = new Date().toISOString();
  return { mission: { id: previous.id || crypto.randomUUID(), title: String(input.title || 'Новая миссия').slice(0, 120), mode: input.mode === 'inspection' ? 'inspection' : 'survey', boundary: input.boundary, settings: input.settings, plan: result.plan, createdAt: previous.createdAt || now, updatedAt: now } };
}
function geoJson(mission) {
  return { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { name: 'Контур работ', missionId: mission.id, mission: mission.title }, geometry: { type: 'Polygon', coordinates: [mission.boundary.map(([lat, lng]) => [lng, lat])] } },
    { type: 'Feature', properties: { name: 'Маршрут съёмки', ...mission.settings, orientation: mission.plan.orientation }, geometry: { type: 'MultiLineString', coordinates: mission.plan.segments.map(segment => segment.map(([lat, lng]) => [lng, lat])) } }
  ] };
}
async function api(request, response, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const id = parts[2];
  if (request.method === 'GET' && parts.length === 2) { const store = await readStore(); return json(response, 200, store.missions); }
  if (request.method === 'POST' && parts.length === 2) {
    const saved = missionRecord(await body(request));
    if (saved.errors) return json(response, 422, saved);
    const store = await readStore(); store.missions.push(saved.mission); await writeStore(store); return json(response, 201, saved.mission);
  }
  const store = await readStore(); const index = store.missions.findIndex(mission => mission.id === id);
  if (index < 0) return json(response, 404, { error: 'Миссия не найдена.' });
  if (request.method === 'GET' && parts.length === 3) return json(response, 200, store.missions[index]);
  if (request.method === 'PUT' && parts.length === 3) {
    const saved = missionRecord(await body(request), store.missions[index]);
    if (saved.errors) return json(response, 422, saved);
    store.missions[index] = saved.mission; await writeStore(store); return json(response, 200, saved.mission);
  }
  if (request.method === 'DELETE' && parts.length === 3) { store.missions.splice(index, 1); await writeStore(store); response.writeHead(204); return response.end(); }
  if (request.method === 'GET' && parts[3] === 'export') return json(response, 200, geoJson(store.missions[index]));
  return json(response, 405, { error: 'Метод не поддерживается.' });
}
async function staticFile(request, response, url) {
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const target = path.resolve(ROOT, relative);
  if (!target.startsWith(ROOT) || path.extname(target) === '.pdf') { response.writeHead(404); return response.end(); }
  try { const content = await fs.readFile(target); response.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' }); response.end(content); }
  catch (_) { response.writeHead(404); response.end('Not found'); }
}
const server = http.createServer(async (request, response) => {
  try { const url = new URL(request.url, `http://${request.headers.host}`); if (url.pathname.startsWith('/api/missions')) return await api(request, response, url); return await staticFile(request, response, url); }
  catch (error) { json(response, 400, { error: error.message || 'Ошибка сервера.' }); }
});
if (require.main === module) server.listen(PORT, '127.0.0.1', () => console.log(`Geoscan Planner: http://127.0.0.1:${PORT}`));
module.exports = { server, readStore, writeStore };
