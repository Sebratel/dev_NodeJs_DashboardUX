import express from 'express';
import { createJob, getJob, listJobs } from './jobQueue.js';
import { startReauth, stopReauth, reauthStatus } from './reauth.js';

const PORT = Number(process.env.PORT ?? 3212);

const app = express();
app.use(express.json());

function toStatusResponse(job) {
  return {
    jobId: job.id,
    status: job.status,
    percent: job.percent,
    message: job.message,
    pid: job.pid,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    steps: job.steps,
    files: Object.keys(job.files),
    errors: job.errors,
  };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', pid: process.pid });
});

app.get('/jobs', (req, res) => {
  res.json(listJobs().map(toStatusResponse));
});

app.post('/jobs', (req, res) => {
  const { dateFrom, dateTo, timeFrom, timeTo } = req.body ?? {};
  if (!dateFrom || !dateTo) {
    res.status(400).json({ error: 'dateFrom e dateTo (dd-MM-yyyy) sao obrigatorios.' });
    return;
  }

  const job = createJob({
    dateFrom,
    dateTo,
    timeFrom: timeFrom ?? '00:00',
    timeTo: timeTo ?? '23:59',
  });

  res.status(202).json({ jobId: job.id });
});

app.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: `Job nao encontrado: ${req.params.id}` });
    return;
  }
  res.json(toStatusResponse(job));
});

app.get('/jobs/:id/download/:report', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: `Job nao encontrado: ${req.params.id}` });
    return;
  }

  const filePath = job.files[req.params.report];
  if (!filePath) {
    res.status(404).json({ error: `Relatorio "${req.params.report}" nao disponivel para este job.` });
    return;
  }

  res.download(filePath);
});

app.post('/reauth/start', async (req, res) => {
  try {
    res.json(await startReauth());
  } catch (err) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.get('/reauth/status', (req, res) => {
  res.json(reauthStatus());
});

app.post('/reauth/stop', async (req, res) => {
  res.json(await stopReauth());
});

app.listen(PORT, () => {
  console.log(`Automation HTTP service listening on port ${PORT} (pid ${process.pid})`);
});
