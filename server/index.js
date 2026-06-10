import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, getHistory, rootDir, saveConfig } from './store.js';
import { Scheduler } from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 8787);
const scheduler = new Scheduler({ saveConfig });

app.use(express.json({ limit: '1mb' }));

app.get('/api/config', async (req, res, next) => {
  try {
    res.json(await getConfig());
  } catch (error) {
    next(error);
  }
});

app.put('/api/config', async (req, res, next) => {
  try {
    const config = await saveConfig(req.body);
    res.json(config);
  } catch (error) {
    next(error);
  }
});

app.get('/api/history', async (req, res, next) => {
  try {
    res.json(await getHistory());
  } catch (error) {
    next(error);
  }
});

app.post('/api/sites/:siteId/run', async (req, res, next) => {
  try {
    const results = await scheduler.runNow(req.params.siteId);
    res.json(results[0] || null);
  } catch (error) {
    next(error);
  }
});

app.post('/api/run', async (req, res, next) => {
  try {
    res.json(await scheduler.runNow());
  } catch (error) {
    next(error);
  }
});

const distDir = path.join(rootDir, 'dist');
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({
    message: error.message || '服务器错误'
  });
});

app.listen(port, () => {
  scheduler.start();
  console.log(`Auto Checkin server running at http://localhost:${port}`);
});
