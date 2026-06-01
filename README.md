# Reporte Kommo · Serviclimas

Dashboard web que se conecta a Kommo cada hora y muestra el estado de los leads por asesor.

## Categorías del reporte

| Categoría | Descripción |
|---|---|
| ⚠ Sin seguimiento | Leads sin actualización hace más de 3 días |
| 📋 Sin tareas | Leads sin ninguna tarea pendiente |
| 🔴 Tareas vencidas | Leads con tareas cuya fecha ya pasó |
| ✅ Tareas al día | Leads con al menos una tarea futura activa |

---

## 1. Obtener el Access Token de Kommo

1. Ve a tu cuenta de Kommo → **Configuración** → **Integraciones**
2. Crea una integración nueva (o usa una existente)
3. En la pestaña **Claves y scopes**, genera un **Long-lived access token**
4. Copia el token (empieza con algo como `eyJ0...`)

---

## 2. Desplegar en EasyPanel

### Opción A: Desde GitHub (recomendado)
1. Sube este proyecto a un repositorio GitHub
2. En EasyPanel → **New Service** → **App**
3. Conecta tu repo
4. En **Environment Variables** agrega:
   ```
   KOMMO_SUBDOMAIN=ventasserviclimascom
   KOMMO_TOKEN=tu_token_aqui
   PORT=3000
   ```
5. EasyPanel detectará el `Dockerfile` automáticamente
6. Haz deploy ✓

### Opción B: Docker Compose en EasyPanel
1. En EasyPanel → **New Service** → **Docker Compose**
2. Pega el contenido de `docker-compose.yml`
3. Edita `KOMMO_TOKEN` con tu token real
4. Deploy ✓

---

## 3. Probar localmente

```bash
# Instalar dependencias
npm install

# Configurar variables de entorno
export KOMMO_TOKEN=tu_token_aqui
export KOMMO_SUBDOMAIN=ventasserviclimascom

# Iniciar servidor
npm start

# Abrir en el navegador
open http://localhost:3000
```

O con Docker:
```bash
# Editar KOMMO_TOKEN en docker-compose.yml, luego:
docker-compose up --build
```

---

## Funcionamiento

- Al iniciar el servidor se ejecuta el reporte inmediatamente
- Después se actualiza **cada hora en punto** (cron `0 * * * *`)
- El botón **⟳ Actualizar** en el dashboard fuerza una actualización manual
- Los datos se cachean en memoria; si el servidor se reinicia, se recarga automáticamente

---

## Estructura del proyecto

```
kommo-reporte/
├── src/
│   ├── server.js     # Express + cron
│   └── kommo.js      # Lógica de conexión a API Kommo
├── public/
│   └── index.html    # Dashboard web
├── Dockerfile
├── docker-compose.yml
└── package.json
```
