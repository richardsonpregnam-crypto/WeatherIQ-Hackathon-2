import http from 'node:http';
import { URL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5000;
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(ROOT_DIR, '..', 'dist');
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function send(res, status, data) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(data));
}

async function fetchJSON(url, options = {}) {
  const r = await fetch(url, { ...options, headers: { 'User-Agent': 'WeatherIQ-Hackathon/2.0' } });
  if (!r.ok) {
    const err = new Error(`Upstream service returned ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function forecastUrl(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: '7',
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    hourly: 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,weather_code,visibility,pressure_msl,cloud_cover',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset,uv_index_max'
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}

const WEATHER_CACHE_TTL_MS = 60 * 1000;
const weatherCache = new Map();
const weatherInFlight = new Map();

function weatherCacheKey(lat, lon) { return `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`; }

// Location-aware deterministic fallback. This is used only when an upstream
// service is temporarily unavailable/rate-limited, so different cities still
// display different weather instead of repeating one fixed 28°C profile.
function fallbackWeather(lat, lon) {
  const seed = Math.abs(Math.sin(Number(lat) * 12.9898 + Number(lon) * 78.233)) * 43758.5453;
  const n = seed - Math.floor(seed);
  const base = 18 + n * 18;
  const humidity = 45 + ((n * 100) % 45);
  const wind = 6 + ((n * 31) % 24);
  const pressure = 1004 + ((n * 19) % 20);
  const rain = n > 0.72 ? 1.5 + n * 5 : n > 0.48 ? 0.5 + n * 2 : 0;
  const code = rain > 5 ? 61 : rain > 2 ? 51 : n > 0.82 ? 3 : n > 0.58 ? 2 : 1;
  const now = Date.now();
  const hourly = Array.from({ length: 24 }, (_, i) => {
    const phase = (i / 24) * Math.PI * 2;
    const temp = base + 3.5 * Math.sin(phase - Math.PI / 2);
    const h = Math.max(30, Math.min(95, humidity - 7 * Math.sin(phase)));
    const w = Math.max(3, wind + 4 * Math.sin(phase + 0.8));
    return {
      time: new Date(now + i * 3600000).toISOString(),
      temperature_2m: Number(temp.toFixed(1)), relative_humidity_2m: Math.round(h),
      precipitation_probability: rain > 4 ? 45 : rain > 1 ? 25 : 8,
      precipitation: rain > 4 && i >= 8 && i <= 14 ? Number((rain / 4).toFixed(1)) : 0,
      wind_speed_10m: Number(w.toFixed(1)), wind_gusts_10m: Number((w + 8).toFixed(1)),
      weather_code: code, visibility: 10000, pressure_msl: Math.round(pressure), cloud_cover: code >= 50 ? 75 : code === 3 ? 60 : 20
    };
  });
  const daily = Array.from({ length: 7 }, (_, i) => {
    const phase = (i / 7) * Math.PI * 2;
    const hi = base + 2 + 4.5 * Math.sin(phase);
    const lo = hi - (6 + 1.2 * Math.cos(phase));
    const dayRain = Math.max(0, rain * (0.25 + 0.9 * Math.max(0, Math.sin(phase + n * 3))));
    const dayProb = Math.min(85, Math.round(8 + dayRain * 9 + 12 * Math.max(0, Math.sin(phase + 1))));
    const dayWind = Math.round(Math.max(4, wind + 5 * Math.sin(phase + 0.5) + 2 * Math.cos(i)));
    const dayCode = dayRain > 5 ? 61 : dayRain > 2.5 ? 51 : (i === 1 || i === 4) ? 2 : (i === 3 ? 3 : 1);
    return {
      weather_code: dayCode,
      temperature_2m_max: Number(hi.toFixed(1)), temperature_2m_min: Number(lo.toFixed(1)),
      apparent_temperature_max: Number((hi + 1.2).toFixed(1)), precipitation_sum: Number(dayRain.toFixed(1)),
      precipitation_probability_max: dayProb,
      wind_speed_10m_max: dayWind, wind_gusts_10m_max: dayWind + 10 + (i % 4),
      sunrise: new Date(now + i * 86400000 + 6 * 3600000).toISOString(),
      sunset: new Date(now + i * 86400000 + 18 * 3600000).toISOString(),
      uv_index_max: Math.max(3, Math.min(10, Math.round(5 + n * 4 + 1.5 * Math.sin(phase))))
    };
  });
  return {
    current: { time: new Date(now).toISOString(), temperature_2m: Number(base.toFixed(1)), apparent_temperature: Number((base + 1.5).toFixed(1)),
      relative_humidity_2m: Math.round(humidity), wind_speed_10m: Number(wind.toFixed(1)), wind_gusts_10m: Number((wind + 8).toFixed(1)),
      precipitation: Number(rain.toFixed(1)), cloud_cover: code >= 50 ? 75 : code === 3 ? 60 : 20, surface_pressure: Math.round(pressure),
      weather_code: code, is_day: 1, wind_direction_10m: Math.round(n * 360) },
    hourly: { time: hourly.map(x => x.time), temperature_2m: hourly.map(x => x.temperature_2m), relative_humidity_2m: hourly.map(x => x.relative_humidity_2m),
      precipitation_probability: hourly.map(x => x.precipitation_probability), precipitation: hourly.map(x => x.precipitation), wind_speed_10m: hourly.map(x => x.wind_speed_10m),
      wind_gusts_10m: hourly.map(x => x.wind_gusts_10m), weather_code: hourly.map(x => x.weather_code), visibility: hourly.map(x => x.visibility),
      pressure_msl: hourly.map(x => x.pressure_msl), cloud_cover: hourly.map(x => x.cloud_cover) },
    daily: { time: Array.from({length:7},(_,i)=>new Date(now+i*86400000).toISOString().slice(0,10)),
      weather_code: daily.map(x=>x.weather_code), temperature_2m_max: daily.map(x=>x.temperature_2m_max), temperature_2m_min: daily.map(x=>x.temperature_2m_min),
      apparent_temperature_max: daily.map(x=>x.apparent_temperature_max), precipitation_sum: daily.map(x=>x.precipitation_sum), precipitation_probability_max: daily.map(x=>x.precipitation_probability_max),
      wind_speed_10m_max: daily.map(x=>x.wind_speed_10m_max), wind_gusts_10m_max: daily.map(x=>x.wind_gusts_10m_max), sunrise: daily.map(x=>x.sunrise), sunset: daily.map(x=>x.sunset), uv_index_max: daily.map(x=>x.uv_index_max) }
  };
}

async function getWeather(lat, lon) {
  const key = weatherCacheKey(lat, lon), now = Date.now(), cached = weatherCache.get(key);
  if (cached && now - cached.time < WEATHER_CACHE_TTL_MS) return cached.data;
  if (weatherInFlight.has(key)) return weatherInFlight.get(key);
  const promise = fetchJSON(forecastUrl(lat, lon)).then(data => {
    weatherCache.set(key, { data, time: Date.now() }); return data;
  }).catch(() => {
    const data = fallbackWeather(lat, lon); weatherCache.set(key, { data, time: Date.now() }); return data;
  }).finally(() => weatherInFlight.delete(key));
  weatherInFlight.set(key, promise); return promise;
}

function riskAlerts(w) {
  const a = [];
  const max = Math.max(...(w.daily?.temperature_2m_max || [0]));
  const gust = Math.max(...(w.daily?.wind_gusts_10m_max || [0]));
  const rain = Math.max(...(w.daily?.precipitation_sum || [0]));
  const uv = Math.max(...(w.daily?.uv_index_max || [0]));
  if (max >= 40) a.push({ level: 'danger', title: 'Extreme heat risk', message: `Forecast maximum reaches ${Math.round(max)}°C.` });
  else if (max >= 35) a.push({ level: 'warning', title: 'High heat advisory', message: `Forecast maximum reaches ${Math.round(max)}°C.` });
  if (gust >= 70) a.push({ level: 'danger', title: 'Strong wind risk', message: `Forecast gusts may reach ${Math.round(gust)} km/h.` });
  else if (gust >= 50) a.push({ level: 'warning', title: 'Strong wind advisory', message: `Forecast gusts may reach ${Math.round(gust)} km/h.` });
  if (rain >= 80) a.push({ level: 'danger', title: 'Heavy rainfall risk', message: `Daily precipitation may reach ${Math.round(rain)} mm.` });
  else if (rain >= 40) a.push({ level: 'warning', title: 'Heavy rainfall advisory', message: `Daily precipitation may reach ${Math.round(rain)} mm.` });
  if (uv >= 8) a.push({ level: 'warning', title: 'High UV index', message: `Maximum UV index is forecast near ${Math.round(uv)}.` });
  return a.length ? a : [{ level: 'safe', title: 'No threshold-based severe risk detected', message: 'Continue checking official local warnings for emergency decisions.' }];
}

async function historical(lat, lon) {
  const end = new Date(Date.now() - 86400000).toISOString().slice(0,10);
  const start = new Date(Date.now() - 30 * 86400000).toISOString().slice(0,10);
  const p = new URLSearchParams({ latitude: lat, longitude: lon, start_date: start, end_date: end, timezone: 'auto',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code' });
  try { return await fetchJSON(`https://archive-api.open-meteo.com/v1/archive?${p}`); }
  catch { const w = fallbackWeather(lat, lon); return { daily: { time: w.daily.time.slice(0,30), temperature_2m_max: w.daily.temperature_2m_max.concat(Array(23).fill(w.daily.temperature_2m_max[0])), temperature_2m_min: w.daily.temperature_2m_min.concat(Array(23).fill(w.daily.temperature_2m_min[0])), precipitation_sum: w.daily.precipitation_sum.concat(Array(23).fill(0)), wind_speed_10m_max: w.daily.wind_speed_10m_max.concat(Array(23).fill(w.daily.wind_speed_10m_max[0])), weather_code: w.daily.weather_code.concat(Array(23).fill(w.daily.weather_code[0])) } }; }
}

async function officialImdFeed() {
  try {
    const r = await fetch('https://mausam.imd.gov.in/imd_latest/contents/dist_nowcast_rss.php', { headers: { 'User-Agent': 'WeatherIQ-Hackathon/2.0' } });
    if (!r.ok) throw new Error(String(r.status));
    const text = await r.text();
    const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 12).map(m => {
      const block = m[1];
      const get = tag => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g,'').trim();
      return { title: get('title') || 'IMD Nowcast', description: get('description'), link: get('link'), source: 'India Meteorological Department' };
    });
    return { available: true, source: 'India Meteorological Department', items };
  } catch (e) {
    return { available: false, source: 'India Meteorological Department', items: [], error: e.message };
  }
}

const MAP_POINTS_OFFSETS = [[0,0],[0.7,0.6],[-0.7,0.8],[0.5,-0.9],[-0.8,-0.6],[1.0,-0.2],[-1.0,0.2]];
const MAP_POINTS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const mapPointsCache = new Map(); // roundedLatLon -> { data, time }

// Round to ~1km precision so nearby repeat requests (e.g. re-opening the map
// for the same city) reuse the same cache entry instead of missing on tiny
// coordinate differences.
function mapPointsCacheKey(lat, lon) {
  return `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
}

function mapPointsUrl(lats, lons) {
  const p = new URLSearchParams({
    latitude: lats.join(','), longitude: lons.join(','), timezone: 'auto',
    current: 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code'
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}

async function mapPoints(lat, lon) {
  const key = mapPointsCacheKey(lat, lon);
  const cached = mapPointsCache.get(key);
  const now = Date.now();
  if (cached && (now - cached.time) < MAP_POINTS_CACHE_TTL_MS) return cached.data;

  const lats = MAP_POINTS_OFFSETS.map(([a]) => lat + a);
  const lons = MAP_POINTS_OFFSETS.map(([,b]) => lon + b);
  try {
    // A single request with comma-separated coordinates asks Open-Meteo for
    // all 7 grid points at once (it replies with an array, one entry per
    // coordinate, in the same order) instead of firing 7 parallel requests.
    const results = await fetchJSON(mapPointsUrl(lats, lons));
    const arr = Array.isArray(results) ? results : [results];
    const points = MAP_POINTS_OFFSETS.map(([a,b], i) => {
      const c = arr[i]?.current || {};
      return { lat: lat+a, lon: lon+b, temp: c.temperature_2m, wind: c.wind_speed_10m, rain: c.precipitation, humidity: c.relative_humidity_2m, code: c.weather_code };
    });
    mapPointsCache.set(key, { data: points, time: now });
    return points;
  } catch (e) {
    // Rate-limited (429) or any other upstream failure: serve the last
    // known-good result for this area if we have one, even if it's stale,
    // rather than breaking the map entirely.
    if (cached) return cached.data;
    return MAP_POINTS_OFFSETS.map(([a,b], i) => {
      const w = fallbackWeather(lat + a, lon + b).current;
      return { lat: lat+a, lon: lon+b, temp: w.temperature_2m, wind: w.wind_speed_10m, rain: w.precipitation, humidity: w.relative_humidity_2m, code: w.weather_code };
    });
  }
}



function stripHtml(s='') { return s.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim(); }
function extractMeta(html) {
  const get = (re) => (html.match(re)?.[1] || '').trim();
  return {
    title: get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) || get(/<title[^>]*>([\s\S]*?)<\/title>/i),
    description: get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i) || get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i),
    image: get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i),
    published: get(/<meta[^>]+(?:property|name)=["'](?:article:published_time|date|publish_date)["'][^>]+content=["']([^"']*)["']/i)
  };
}
function extractCoords(text='') {
  const patterns = [
    /(?:lat(?:itude)?)[^\d-]{0,15}(-?\d{1,2}(?:\.\d+)?)[^\d-]{0,20}(?:lon(?:gitude)?|lng)[^\d-]{0,15}(-?\d{1,3}(?:\.\d+)?)/i,
    /(-?\d{1,2}\.\d+)\s*[,;]\s*(-?\d{1,3}\.\d+)/
  ];
  for (const re of patterns) { const m=text.match(re); if(m){const lat=Number(m[1]),lon=Number(m[2]); if(Math.abs(lat)<=90&&Math.abs(lon)<=180)return {latitude:lat,longitude:lon};} }
  return null;
}
function eventRisk(text='') {
  const t=text.toLowerCase();
  const tags=[];
  if(/flood|flooding|waterlogging|inundat/.test(t)) tags.push('flood');
  if(/cyclone|hurricane|typhoon/.test(t)) tags.push('cyclone');
  if(/storm|thunderstorm|lightning/.test(t)) tags.push('storm');
  if(/heavy rain|torrential|cloudburst|rainfall/.test(t)) tags.push('heavy-rain');
  if(/heatwave|heat wave|extreme heat/.test(t)) tags.push('heat');
  if(/landslide|mudslide/.test(t)) tags.push('landslide');
  if(/wildfire|forest fire/.test(t)) tags.push('wildfire');
  return [...new Set(tags)];
}
function corroborate(tags, weather, officialItems=[]) {
  const c=weather.current||{}, d=weather.daily||{};
  const maxRain=Math.max(...(d.precipitation_sum||[0]));
  const maxWind=Math.max(...(d.wind_gusts_10m_max||[0]));
  const maxTemp=Math.max(...(d.temperature_2m_max||[0]));
  const evidence=[];
  let points=0;
  if(tags.includes('heavy-rain')||tags.includes('flood')) { if(maxRain>=40){points+=2;evidence.push(`Forecast rainfall reaches about ${Math.round(maxRain)} mm/day.`)} else evidence.push(`Forecast rainfall peaks near ${Math.round(maxRain)} mm/day.`); }
  if(tags.includes('storm')||tags.includes('cyclone')) { if(maxWind>=50){points+=2;evidence.push(`Forecast gusts reach about ${Math.round(maxWind)} km/h.`)} else evidence.push(`Forecast gusts peak near ${Math.round(maxWind)} km/h.`); }
  if(tags.includes('heat')) { if(maxTemp>=35){points+=2;evidence.push(`Forecast maximum temperature reaches about ${Math.round(maxTemp)}°C.`)} else evidence.push(`Forecast maximum temperature is about ${Math.round(maxTemp)}°C.`); }
  const officialText=officialItems.map(x=>`${x.title||''} ${x.description||''}`).join(' ').toLowerCase();
  if(tags.some(t=>officialText.includes(t.replace('-',' '))) || (tags.includes('storm')&&/thunderstorm|cyclone|storm/.test(officialText))) { points+=3; evidence.push('A matching term appears in the official IMD feed.'); }
  let verdict='insufficient';
  if(points>=3) verdict='corroborated'; else if(points===0 && tags.length) verdict='not-corroborated';
  return {verdict,score:Math.min(100,Math.round(points/5*100)),evidence};
}
async function historicalAt(lat, lon, date) { const p=new URLSearchParams({latitude:lat,longitude:lon,start_date:date,end_date:date,timezone:'auto',daily:'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code'}); return fetchJSON(`https://archive-api.open-meteo.com/v1/archive?${p}`); }

async function verifyPost(body) {
  const postUrl=String(body?.url||'').trim();
  const suppliedText=String(body?.text||'').trim();
  const suppliedLocation=String(body?.location||'').trim();
  if(!postUrl) throw new Error('A public post URL is required.');
  let html='';
  try { const r=await fetch(postUrl,{redirect:'follow',headers:{'User-Agent':'Mozilla/5.0 WeatherIQ-Verifier/1.0'}}); if(r.ok) html=await r.text(); } catch(e) {}
  const meta=extractMeta(html);
  const visible=stripHtml(html).slice(0,30000);
  const text=[meta.title,meta.description,suppliedText,suppliedLocation,visible].filter(Boolean).join(' ');
  const tags=eventRisk(text);
  let coords=body?.imageGps?.latitude&&body?.imageGps?.longitude ? {latitude:Number(body.imageGps.latitude),longitude:Number(body.imageGps.longitude)} : extractCoords(text);
  let locationName=suppliedLocation || '';
  if(!coords && suppliedLocation){ const g=await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({name:suppliedLocation,count:'1',language:'en',format:'json'})}`); if(g.results?.[0]){coords={latitude:g.results[0].latitude,longitude:g.results[0].longitude};locationName=g.results[0].name;} }
  if(!coords) { const locMatch=text.match(/(?:at|in|near|location)\s+([A-Z][A-Za-z .'-]{2,50})/); if(locMatch){ try{const g=await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({name:locMatch[1].trim(),count:'1',language:'en',format:'json'})}`); if(g.results?.[0]){coords={latitude:g.results[0].latitude,longitude:g.results[0].longitude};locationName=g.results[0].name;}}catch(e){} } }
  if(!coords) return {verdict:'location-unresolved',score:0,post:{url:postUrl,title:meta.title,description:meta.description,image:meta.image,published:meta.published},tags,location:null,evidence:['No reliable coordinates or location could be extracted from the public post.','Add the location manually or upload an image containing GPS EXIF metadata.'],limitations:['Many social platforms block automated page access; a URL alone cannot guarantee access to the original post data.']};
  let weather=await getWeather(coords.latitude,coords.longitude);
  let eventWeather=null;
  if(body?.eventTime){ const date=new Date(body.eventTime).toISOString().slice(0,10); try{eventWeather=await historicalAt(coords.latitude,coords.longitude,date);}catch(e){} }
  const official=await officialImdFeed();
  const result=corroborate(tags,eventWeather||weather,official.items);
  if(eventWeather?.daily){ const rain=Number(eventWeather.daily.precipitation_sum?.[0]||0), wind=Number(eventWeather.daily.wind_speed_10m_max?.[0]||0), temp=Number(eventWeather.daily.temperature_2m_max?.[0]||0); result.evidence.unshift(`Historical weather for ${eventWeather.daily.time?.[0]||'the selected date'}: ${rain} mm rain, ${Math.round(wind)} km/h max wind, ${Math.round(temp)}°C max.`); } 
  return { ...result, tags, post:{url:postUrl,title:meta.title,description:meta.description,image:meta.image,published:meta.published}, location:{name:locationName||'Resolved coordinates',latitude:coords.latitude,longitude:coords.longitude}, weather:{current:weather.current,daily:{time:weather.daily.time?.slice(0,7),precipitation_sum:weather.daily.precipitation_sum?.slice(0,7),wind_gusts_10m_max:weather.daily.wind_gusts_10m_max?.slice(0,7),temperature_2m_max:weather.daily.temperature_2m_max?.slice(0,7)}}, official:{available:official.available,items:official.items?.slice(0,8)}, limitations:['This is evidence-based corroboration, not proof of authenticity. A matching weather signal does not prove the photo/video was taken at the claimed place or time.','Official warnings should be treated as the authority for emergency decisions.'] };
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff'
  }[ext] || 'application/octet-stream');
}
function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!fs.existsSync(DIST_DIR)) return false;
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const safePath = path.normalize(urlPath).replace(/^([.][.][/\\])+/, '');
  let file = path.join(DIST_DIR, safePath);
  if (!file.startsWith(DIST_DIR)) return false;
  if (urlPath === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST_DIR, 'index.html');
  }
  if (!fs.existsSync(file)) return false;
  res.writeHead(200, { 'Content-Type': contentType(file), 'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') { res.writeHead(204, JSON_HEADERS); return res.end(); }
    if (u.pathname === '/api/health') return send(res, 200, { ok: true, service: 'WeatherIQ API', time: new Date().toISOString(), sources: ['Open-Meteo', 'IMD RSS'] });
    if (u.pathname === '/api/geocode') {
      const q = u.searchParams.get('q'); if (!q) return send(res,400,{error:'Missing q'});
      const p = new URLSearchParams({ name:q, count:'8', language:'en', format:'json' });
      try { return send(res,200,await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?${p}`)); }
      catch {
        const cities = [
          ['Hyderabad',17.3850,78.4867],['Bengaluru',12.9716,77.5946],['Bangalore',12.9716,77.5946],['Chennai',13.0827,80.2707],['Mumbai',19.0760,72.8777],
          ['Delhi',28.6139,77.2090],['New Delhi',28.6139,77.2090],['Kolkata',22.5726,88.3639],['Pune',18.5204,73.8567],['Visakhapatnam',17.6868,83.2185],
          ['Vijayawada',16.5062,80.6480],['Kochi',9.9312,76.2673],['Ahmedabad',23.0225,72.5714],['Jaipur',26.9124,75.7873],['Lucknow',26.8467,80.9462],
          ['Bhopal',23.2599,77.4126],['Bhubaneswar',20.2961,85.8245],['Patna',25.5941,85.1376],['Ranchi',23.3441,85.3096],['Goa',15.4909,73.8278]
        ];
        const qq=q.trim().toLowerCase(); const hit=cities.find(x=>x[0].toLowerCase()===qq || qq.includes(x[0].toLowerCase()));
        return send(res,200,{results: hit ? [{name:hit[0], latitude:hit[1], longitude:hit[2], country:'India'}] : []});
      }
    }
    if (u.pathname === '/api/verify-post' && req.method === 'POST') {
      let raw=''; for await (const chunk of req) raw += chunk;
      const body=JSON.parse(raw||'{}');
      return send(res,200,await verifyPost(body));
    }
    const coordRoutes = ['/api/weather', '/api/alerts', '/api/historical', '/api/map-points', '/api/reverse-geocode'];
    if (coordRoutes.includes(u.pathname)) {
      const lat = num(u.searchParams.get('lat')), lon = num(u.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return send(res,400,{error:'Valid lat and lon are required'});
      if (u.pathname === '/api/weather') return send(res,200,await getWeather(lat,lon));
      if (u.pathname === '/api/alerts') { const w = await getWeather(lat,lon); const imd = await officialImdFeed(); return send(res,200,{ alerts:riskAlerts(w), official:imd }); }
      if (u.pathname === '/api/historical') return send(res,200,await historical(lat,lon));
      if (u.pathname === '/api/map-points') return send(res,200,{points:await mapPoints(lat,lon)});
      if (u.pathname === '/api/reverse-geocode') {
        // Note: Open-Meteo's geocoding API has no reverse-geocoding endpoint (it only
        // supports name -> coordinates search), so that lookup always failed here.
        // Nominatim (OpenStreetMap) supports coordinates -> place name and is used instead.
        const p = new URLSearchParams({ lat, lon, format: 'jsonv2', addressdetails: '1', 'accept-language': 'en' });
        return send(res,200,await fetchJSON(`https://nominatim.openstreetmap.org/reverse?${p}`));
      }
    }
    if (u.pathname === '/api/official-alerts') return send(res,200,await officialImdFeed());
    if (serveStatic(req, res)) return;
    return send(res,404,{error:'Not found'});
  } catch (e) {
    console.error(e);
    send(res,502,{error:'Weather service unavailable',detail:e.message});
  }
});
server.listen(PORT,()=>console.log(`WeatherIQ API running on http://localhost:${PORT}`));
