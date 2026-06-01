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

// Rate limiter: máximo 3 req/s — la mitad del límite de Kommo (7 req/s).
// Más lento que antes (era 6 req/s) pero evita picos de CPU en servidores
// con recursos limitados: cada request tiene ~330ms de margen de reposo.
const MIN_INTERVAL_MS = Math.ceil(1000 / 3);
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

async function fetchTasks() {
  return fetchAll('/tasks', { 'filter[is_completed]': 0, 'filter[entity_type]': 'leads' });
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

// Descarga todos los datos crudos de Kommo.
// Las solicitudes van en serie a través del rate limiter (3 req/s),
// así el CPU tiene ~330ms de reposo entre cada respuesta.
async function fetchRawData() {
  if (!ACCESS_TOKEN) {
    throw new Error('KOMMO_TOKEN no configurado. Por favor agrega tu token en las variables de entorno.');
  }

  // Secuencial para no encolar varias cadenas en paralelo al arrancar
  const usersMap = await fetchUsers();
  const leads    = await fetchAll('/leads', { with: 'loss_reason' });
  const stageMap = await fetchPipelines();
  const tasks    = await fetchTasks();

  return { usersMap, leads, stageMap, tasks };
}

const STAGNANT_MS = 72 * 60 * 60 * 1000; // 72 horas en ms

// dateFrom / dateTo: timestamps en milisegundos (o null)
// dateField: 'created_at' | 'closed_at'
// serviceType: string exacto del campo "Servicio de interés" (o null = todos)
function buildReport(rawData, { dateFrom = null, dateTo = null, dateField = 'created_at', serviceType = null } = {}) {
  const { usersMap, stageMap } = rawData;
  let leads = rawData.leads;

  // Índice de tareas pendientes por lead_id
  const nowMs = Date.now();
  const tasksByLead = {};
  for (const task of (rawData.tasks || [])) {
    const lid = task.entity_id;
    if (!tasksByLead[lid]) tasksByLead[lid] = [];
    tasksByLead[lid].push(task);
  }

  // Filtro por servicio de interés
  if (serviceType === '__none__') {
    leads = leads.filter(lead => !getServiceType(lead));
  } else if (serviceType) {
    leads = leads.filter(lead => getServiceType(lead) === serviceType);
  }

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
        active:        { count: 0, value: 0, byStage: {} },
        won:           { count: 0, value: 0 },
        lost:          { count: 0, value: 0, byReason: {} },
        stagnant:      [],
        tasks:         { noTask: 0, overdue: 0, upToDate: 0 },
        byServiceType: {},
      };
    }

    const adv   = byAdvisor[userId];
    const value = lead.price || 0;
    const isWon  = lead.status_id === 142;
    const isLost = lead.status_id === 143;

    const svcType = getServiceType(lead) || 'Sin clasificar';
    if (!adv.byServiceType[svcType]) adv.byServiceType[svcType] = { count: 0, value: 0 };
    adv.byServiceType[svcType].count++;
    adv.byServiceType[svcType].value += value;

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
      const stage     = stageMap[lead.status_id];
      const stageName = stage?.name || `Etapa ${lead.status_id}`;
      const stageKey  = lead.status_id;
      if (!adv.active.byStage[stageKey]) {
        adv.active.byStage[stageKey] = {
          name:         stageName,
          pipelineName: stage?.pipelineName || 'Sin embudo',
          pipelineId:   stage?.pipelineId ?? null,
          count:        0,
          value:        0,
          sort:         stage?.sort ?? 999,
        };
      }
      adv.active.byStage[stageKey].count++;
      adv.active.byStage[stageKey].value += value;

      // Lead estancado: activo con más de 72h sin modificación
      if (lead.updated_at) {
        const hoursSince = (nowMs - lead.updated_at * 1000) / (60 * 60 * 1000);
        if (hoursSince >= 72) {
          adv.stagnant.push({
            id:         lead.id,
            name:       lead.name || `Lead #${lead.id}`,
            value,
            updatedAt:  lead.updated_at,
            hoursSince: Math.floor(hoursSince),
            stage:      stageName,
          });
        }
      }

      // Tareas del lead
      const leadTasks   = tasksByLead[lead.id] || [];
      const hasUpcoming = leadTasks.some(t => !t.complete_till || t.complete_till * 1000 >= nowMs);
      const allOverdue  = leadTasks.length > 0 && leadTasks.every(t => t.complete_till && t.complete_till * 1000 < nowMs);

      if (leadTasks.length === 0) adv.tasks.noTask++;
      else if (allOverdue)        adv.tasks.overdue++;
      else if (hasUpcoming)       adv.tasks.upToDate++;
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
    // Más estancados primero
    stagnant: adv.stagnant.sort((a, b) => b.hoursSince - a.hoursSince),
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
      totalStagnant:    advisors.reduce((s, a) => s + a.stagnant.length, 0),
      totalActiveValue: advisors.reduce((s, a) => s + a.active.value, 0),
      totalWonValue:    advisors.reduce((s, a) => s + a.won.value, 0),
      totalLostValue:   advisors.reduce((s, a) => s + a.lost.value, 0),
      tasksNoTask:      advisors.reduce((s, a) => s + a.tasks.noTask, 0),
      tasksOverdue:     advisors.reduce((s, a) => s + a.tasks.overdue, 0),
      tasksUpToDate:    advisors.reduce((s, a) => s + a.tasks.upToDate, 0),
    },
  };
}

module.exports = { fetchRawData, buildReport };
