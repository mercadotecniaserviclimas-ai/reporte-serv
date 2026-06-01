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
const MIN_INTERVAL_MS = Math.ceil(1000 / 6); // ~167ms entre solicitudes
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

// Paginación genérica
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

// Obtener usuarios (asesores)
async function fetchUsers() {
  const res = await rateLimitedGet('/users');
  const users = res.data?._embedded?.users || [];
  const map = {};
  for (const u of users) {
    map[u.id] = u.name || `Usuario ${u.id}`;
  }
  return map;
}

// Obtener leads activos (no cerrados)
async function fetchActiveLeads() {
  // status_id 142 = ganado, 143 = perdido (estándares de Kommo)
  // Traemos todos los leads activos con info de tareas
  const leads = await fetchAll('/leads', {
    with: 'loss_reason,contacts',
    'filter[statuses][0][status_id]': null, // sin filtro de status = todos activos
  });

  // Filtrar solo leads que NO están en estados cerrados (142 = Won, 143 = Lost)
  return leads.filter(l => l.status_id !== 142 && l.status_id !== 143);
}

// Obtener tareas pendientes de leads
async function fetchTasks() {
  return fetchAll('/tasks', { 'filter[is_completed]': 0, 'filter[entity_type]': 'leads' });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const now = () => Date.now();

function daysSince(timestamp) {
  if (!timestamp) return null;
  return Math.floor((now() - timestamp * 1000) / DAY_MS);
}

function isOverdue(completeTill) {
  if (!completeTill) return false;
  return completeTill * 1000 < now();
}

// Función principal
async function fetchReportData() {
  if (!ACCESS_TOKEN) {
    throw new Error('KOMMO_TOKEN no configurado. Por favor agrega tu token en las variables de entorno.');
  }

  const [usersMap, activeLeads, tasks] = await Promise.all([
    fetchUsers(),
    fetchActiveLeads(),
    fetchTasks(),
  ]);

  // Indexar tareas por lead_id
  const tasksByLead = {};
  for (const task of tasks) {
    if (task.entity_type !== 'leads') continue;
    const lid = task.entity_id;
    if (!tasksByLead[lid]) tasksByLead[lid] = [];
    tasksByLead[lid].push(task);
  }

  // Agrupar leads por asesor
  const byAdvisor = {};

  for (const lead of activeLeads) {
    const userId = lead.responsible_user_id;
    const advisorName = usersMap[userId] || `Asesor ${userId}`;

    if (!byAdvisor[userId]) {
      byAdvisor[userId] = {
        advisorId: userId,
        advisorName,
        sinSeguimiento: [],   // > 3 días sin actualización
        sinTareas: [],        // sin tareas pendientes
        tareasVencidas: [],   // tiene tareas pero todas vencidas
        tareasAlDia: [],      // tiene al menos una tarea futura
      };
    }

    const leadTasks = tasksByLead[lead.id] || [];
    const daysSinceUpdate = daysSince(lead.updated_at);
    const sinSeguimiento = daysSinceUpdate !== null && daysSinceUpdate > 3;

    const hasTasks = leadTasks.length > 0;
    const hasOverdue = hasTasks && leadTasks.every(t => isOverdue(t.complete_till));
    const hasUpcoming = hasTasks && leadTasks.some(t => !isOverdue(t.complete_till));

    const leadSummary = {
      id: lead.id,
      name: lead.name || `Lead #${lead.id}`,
      price: lead.price || 0,
      updatedAt: lead.updated_at,
      daysSinceUpdate,
      taskCount: leadTasks.length,
      tasks: leadTasks.map(t => ({
        id: t.id,
        text: t.text,
        completeTill: t.complete_till,
        isOverdue: isOverdue(t.complete_till),
      })),
    };

    const group = byAdvisor[userId];

    if (sinSeguimiento) group.sinSeguimiento.push(leadSummary);
    if (!hasTasks) group.sinTareas.push(leadSummary);
    else if (hasOverdue) group.tareasVencidas.push(leadSummary);
    if (hasUpcoming) group.tareasAlDia.push(leadSummary);
  }

  return {
    advisors: Object.values(byAdvisor).sort((a, b) =>
      a.advisorName.localeCompare(b.advisorName)
    ),
    totals: {
      totalLeads: activeLeads.length,
      totalAdvisors: Object.keys(byAdvisor).length,
    },
  };
}

module.exports = { fetchReportData };
