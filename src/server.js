const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { fetchReportData } = require('./kommo');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory cache del último reporte
let lastReport = null;
let lastUpdated = null;
let isLoading = false;
let lastError = null;

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// Endpoint: obtener reporte cacheado
app.get('/api/report', (req, res) => {
  res.json({
    data: lastReport,
    lastUpdated,
    isLoading,
    error: lastError,
  });
});

// Endpoint: forzar refresh manual
app.post('/api/refresh', async (req, res) => {
  if (isLoading) {
    return res.json({ message: 'Ya hay una actualización en curso' });
  }
  runReport();
  res.json({ message: 'Actualización iniciada' });
});

// Función principal de reporte
async function runReport() {
  if (isLoading) return;
  isLoading = true;
  lastError = null;
  console.log(`[${new Date().toISOString()}] Ejecutando reporte Kommo...`);
  try {
    const data = await fetchReportData();
    lastReport = data;
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
cron.schedule('0 * * * *', () => {
  runReport();
});

// Cargar datos al iniciar
runReport();

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
