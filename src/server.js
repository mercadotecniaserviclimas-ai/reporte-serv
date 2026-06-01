const express = require('express');
const cron    = require('node-cron');
const path    = require('path');
const { fetchRawData, buildReport } = require('./kommo');

const app  = express();
const PORT = process.env.PORT || 3000;

let rawData    = null; // datos crudos cacheados
let lastUpdated = null;
let isLoading  = false;
let lastError  = null;

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// Endpoint: obtener reporte con filtros opcionales de fecha
// Query params: dateFrom, dateTo (ISO strings), dateField ('created_at' | 'closed_at')
app.get('/api/report', (req, res) => {
  const { dateFrom, dateTo, dateField } = req.query;

  // Los timestamps de Kommo son Unix segundos; dateFrom/dateTo llegan
  // como ISO strings ya en hora local (construidos con new Date(y,m,d,...)).
  const filters = {
    dateFrom:  dateFrom ? new Date(dateFrom).getTime() : null,
    dateTo:    dateTo   ? new Date(dateTo).getTime()   : null,
    dateField: dateField || 'created_at',
  };

  const data = rawData ? buildReport(rawData, filters) : null;

  res.json({ data, lastUpdated, isLoading, error: lastError });
});

// Endpoint: forzar refresh manual
app.post('/api/refresh', async (req, res) => {
  if (isLoading) return res.json({ message: 'Ya hay una actualización en curso' });
  runReport();
  res.json({ message: 'Actualización iniciada' });
});

async function runReport() {
  if (isLoading) return;
  isLoading = true;
  lastError = null;
  console.log(`[${new Date().toISOString()}] Ejecutando reporte Kommo...`);
  try {
    rawData    = await fetchRawData();
    lastUpdated = new Date().toISOString();
    console.log(`[${new Date().toISOString()}] Reporte actualizado exitosamente.`);
  } catch (err) {
    lastError = err.message || 'Error desconocido';
    console.error(`[${new Date().toISOString()}] Error en reporte:`, err.message);
  } finally {
    isLoading = false;
  }
}

// Cron: cada hora en punto
cron.schedule('0 * * * *', () => { runReport(); });

runReport();

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
