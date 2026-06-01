const axios = require('axios');

const SUBDOMAIN = process.env.KOMMO_SUBDOMAIN || 'ventasserviclimascom';
const ACCESS_TOKEN = process.env.KOMMO_TOKEN || '';
const BASE_URL = `https://${SUBDOMAIN}.kommo.com/api/v4`;

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  },
});

// Rate limiter: máximo 6 req/s (margen seguro bajo el límite de 7 de Kommo)
const MIN_INTERVAL_MS = Math.ceil(1000 / 6);
let apiQueue = Promise.resolve();
let lastRequestTime = 0;

function rateLimitedGet(endpoint, config) {
  const result = apiQueue.then(async () => {
    const elapsed = Date.now() - lastRequestTime;
    if (elapsed < MIN_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - elapsed));
    }
    lastRequestTime = Date.now();
    return api.get(endpoint, config);
  });
  apiQueue = result.catch(() => {});
  return result;
}

async function fetchAll(endpoint, params = {}) {
  let page = 1;
  const results = [];
  while (true) {
    const res = await rateLimitedGet(endpoint, { params: { ...params, limit: 250, page } });
    if (res.status === 204) break;
    const embedded = res.data?._embedded;
    const key = Object.keys(embedded || {})[0];
    if (!key || !embedded[key]?.length) break;
    results.push(...embedded[key]);
    if (embedded[key].length < 250) break;
    page++;
  }
  return results;
}

async function fetchUsers() {
  const res = await rateLimitedGet('/users');
  const users = res.data?._embedded?.users || [];
  const map = {};
  for (const u of users) map[u.id] = u.name || `Usuario ${u.id}`;
  return map;
}

async function fetchPipelines() {
  const res = await rateLimitedGet('/leads/pipelines', { params: { limit: 250 } });
  const pipelines = res.data?._embedded?.pipelines || [];
  const stageMap = {};
  for (const pipeline of pipelines) {
    for (const status of (pipeline._embedded?.statuses || [])) {
      stageMap[status.id] = {
        name: status.name,
        pipelineName: pipeline.name,
        sort: status.sort ?? 999,
        pipelineId: pipeline.id,
      };
    }
  }
  return stageMap;
}

function getLossReasonName(lead) {
  const lr = lead._embedded?.loss_reason;
  if (!lr) return 'Sin razón especificada';
  if (Array.isArray(lr)) return lr[0]?.name || 'Sin razón especificada';
  return lr.name || 'Sin razón especificada';
}

function getServiceType(lead) {
  const fields = lead.custom_fields_values || [];
  const field = fields.find(f => {
    const name = (f.field_name || '').toLowerCase().replace(/\s+/g, '');
    return name === 'serviciodeinterés' || name === 'serviciodeinteres' || name.includes('serviciodeinter');
  });
  return field?.values?.[0]?.value || null;
}

// Descarga todos los datos crudos de Kommo (se llama cada hora)
async function fetchRawData() {
  if (!ACCESS_TOKEN) {
    throw new Error('KOMMO_TOKEN no configurado. Por favor agrega tu token en las variables de entorno.');
  }

  const [usersMap, leads, stageMap] = await Promise.all([
    fetchUsers(),
    fetchAll('/leads', { with: 'loss_reason' }),
    fetchPipelines(),
  ]);

  return { usersMap, leads, stageMap };
}

// Agrega los datos crudos en el reporte, aplicando filtros de fecha opcionales.
// dateFrom / dateTo: timestamps en milisegundos (o null)
// dateField: 'created_at' | 'closed_at'
//   - created_at → filtra todos los leads por fecha de creación
//   - closed_at  → filtra solo leads ganados/perdidos por fecha de cierre
function buildReport(rawData, { dateFrom = null, dateTo = null, dateField = 'created_at' } = {}) {
  const { usersMap, stageMap } = rawData;
  let leads = rawData.leads;

  if (dateFrom || dateTo) {
    // Kommo devuelve las fechas como Unix timestamp en segundos.
    // Multiplicamos × 1000 para comparar en milisegundos.
    const filterByClosed = dateField === 'closed_at';
    leads = leads.filter(lead => {
      const isWon  = lead.status_id === 142;
      const isLost = lead.status_id === 143;

      if (filterByClosed) {
        // Solo leads cerrados tienen fecha de cierre
        if (!isWon && !isLost) return false;
        const raw = lead.closed_at || lead.updated_at;
        if (!raw) return false;
        const ts = raw * 1000;
        if (dateFrom && ts < dateFrom) return false;
        if (dateTo  && ts > dateTo)   return false;
        return true;
      } else {
        if (!lead.created_at) return false;
        const ts = lead.created_at * 1000;
        if (dateFrom && ts < dateFrom) return false;
        if (dateTo  && ts > dateTo)   return false;
        return true;
      }
    });
  }

  const byAdvisor = {};

  for (const lead of leads) {
    const userId     = lead.responsible_user_id;
    const advisorName = usersMap[userId] || `Asesor ${userId}`;

    if (!byAdvisor[userId]) {
      byAdvisor[userId] = {
        advisorId: userId,
        advisorName,
        active: { count: 0, value: 0, byStage: {} },
        won:    { count: 0, value: 0 },
        lost:   { count: 0, value: 0, byReason: {} },
        byServiceType: {},
      };
    }

    const adv   = byAdvisor[userId];
    const value = lead.price || 0;
    const isWon  = lead.status_id === 142;
    const isLost = lead.status_id === 143;

    const serviceType = getServiceType(lead) || 'Sin clasificar';
    if (!adv.byServiceType[serviceType]) adv.byServiceType[serviceType] = { count: 0, value: 0 };
    adv.byServiceType[serviceType].count++;
    adv.byServiceType[serviceType].value += value;

    if (isWon) {
      adv.won.count++;
      adv.won.value += value;
    } else if (isLost) {
      adv.lost.count++;
      adv.lost.value += value;
      const reason = getLossReasonName(lead);
      if (!adv.lost.byReason[reason]) adv.lost.byReason[reason] = { count: 0, value: 0 };
      adv.lost.byReason[reason].count++;
      adv.lost.byReason[reason].value += value;
    } else {
      adv.active.count++;
      adv.active.value += value;
      const stage    = stageMap[lead.status_id];
      const stageKey = lead.status_id;
      if (!adv.active.byStage[stageKey]) {
        adv.active.byStage[stageKey] = {
          name:  stage?.name || `Etapa ${stageKey}`,
          count: 0,
          value: 0,
          sort:  stage?.sort ?? 999,
        };
      }
      adv.active.byStage[stageKey].count++;
      adv.active.byStage[stageKey].value += value;
    }
  }

  const advisors = Object.values(byAdvisor).map(adv => ({
    ...adv,
    active: {
      ...adv.active,
      byStage: Object.values(adv.active.byStage).sort((a, b) => a.sort - b.sort),
    },
    lost: {
      ...adv.lost,
      byReason: Object.entries(adv.lost.byReason)
        .map(([reason, data]) => ({ reason, ...data }))
        .sort((a, b) => b.count - a.count),
    },
    byServiceType: Object.entries(adv.byServiceType)
      .map(([type, data]) => ({ type, ...data }))
      .sort((a, b) => b.count - a.count),
  })).sort((a, b) => a.advisorName.localeCompare(b.advisorName));

  return {
    advisors,
    totals: {
      totalLeads:       leads.length,
      totalActive:      advisors.reduce((s, a) => s + a.active.count, 0),
      totalWon:         advisors.reduce((s, a) => s + a.won.count, 0),
      totalLost:        advisors.reduce((s, a) => s + a.lost.count, 0),
      totalActiveValue: advisors.reduce((s, a) => s + a.active.value, 0),
      totalWonValue:    advisors.reduce((s, a) => s + a.won.value, 0),
      totalLostValue:   advisors.reduce((s, a) => s + a.lost.value, 0),
    },
  };
}

module.exports = { fetchRawData, buildReport };
