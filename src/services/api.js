async function get(path, attempt = 0) {
  try {
    const r = await fetch(path, { cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  } catch (e) {
    // On first failure, wait briefly and retry once. This smooths over the
    // brief window right after `npm run dev` starts locally, where the
    // frontend can load before the backend has finished binding its port.
    if (attempt < 1) {
      await new Promise(res => setTimeout(res, 700));
      return get(path, attempt + 1);
    }
    throw e;
  }
}
export const geocode = q => get(`/api/geocode?q=${encodeURIComponent(q)}`);
export const getWeather = (lat,lon) => get(`/api/weather?lat=${lat}&lon=${lon}`);
export const getAlerts = (lat,lon) => get(`/api/alerts?lat=${lat}&lon=${lon}`);
export const getHistorical = (lat,lon) => get(`/api/historical?lat=${lat}&lon=${lon}`);
export const getMapPoints = (lat,lon) => get(`/api/map-points?lat=${lat}&lon=${lon}`);
export const getHealth = () => get('/api/health');
export const verifyPost = async body => { const r=await fetch('/api/verify-post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const data=await r.json().catch(()=>({})); if(!r.ok) throw new Error(data.error||'Verification failed'); return data; };
