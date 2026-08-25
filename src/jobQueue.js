import { randomUUID } from 'node:crypto';
import { runReportJob } from './runReportJob.js';
import { progressEmitter } from './progress.js';

const jobs = new Map();

/**
 * So um job por vez: o profile persistente do Chromium
 * (chromium.launchPersistentContext) so pode ser aberto por UM processo/
 * contexto de cada vez - rodar 2 jobs em paralelo faria o segundo falhar
 * ao tentar abrir o mesmo profileDir. Cada POST /jobs entra numa fila
 * simples (encadeamento de promises) e comeca a rodar de fato so quando o
 * anterior termina; o jobId e devolvido na hora (job fica PENDING).
 */
let queueTail = Promise.resolve();

export function createJob(filters) {
  const job = {
    id: randomUUID(),
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    status: 'PENDING',
    percent: 0,
    message: 'Aguardando inicio...',
    pid: process.pid,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    steps: [],
    files: {},
    errors: {},
  };
  jobs.set(job.id, job);

  queueTail = queueTail.then(() => runJob(job, filters)).catch(() => {
    // erros ja ficam registrados no job (markFailed) - so evita que uma
    // rejeicao aqui quebre a cadeia e trave os proximos jobs da fila.
  });

  return job;
}

async function runJob(job, filters) {
  job.status = 'RUNNING';

  // Cada evento de progresso e de UM relatorio so, mas o historico exibido
  // na Auditoria (e o parser de badges do frontend) espera uma mensagem
  // combinada com o estado mais recente de TODOS os relatorios concorrentes
  // a cada ponto (ex.: "[Atendimento] ... | [HSM] ..."), nao so o que
  // acabou de mudar - por isso agregamos aqui, igual o antigo
  // ReportProgressAggregator do BFF fazia ao ler as linhas PROGRESS.
  const latestByReport = new Map();

  const onProgress = ({ report, percent, message }) => {
    latestByReport.set(report, { percent, message });

    const combinedPercent = Math.round(
      [...latestByReport.values()].reduce((sum, r) => sum + r.percent, 0) / latestByReport.size,
    );
    const combinedMessage = [...latestByReport.entries()]
      .map(([r, s]) => `[${r}] ${s.message}`)
      .join(' | ');

    job.percent = combinedPercent;
    job.message = combinedMessage;
    job.steps.push({ percent: combinedPercent, message: combinedMessage, timestamp: new Date().toISOString() });
  };
  progressEmitter.on('progress', onProgress);

  try {
    const { files, errors } = await runReportJob(filters);
    const hasErrors = Object.values(errors).some(Boolean);

    job.files = Object.fromEntries(
      Object.entries(files).filter(([, filePath]) => filePath !== null),
    );
    job.errors = Object.fromEntries(
      Object.entries(errors).filter(([, message]) => message !== null),
    );
    job.percent = 100;
    job.finishedAt = new Date().toISOString();

    if (hasErrors) {
      job.status = 'FAILED';
      job.message =
        'Falha ao gerar relatorio(s) - ' +
        Object.entries(job.errors)
          .map(([report, message]) => `${report}: ${message}`)
          .join(' | ');
    } else {
      job.status = 'DONE';
      job.message = `Relatorios baixados com sucesso (${Object.keys(job.files).join(', ')}).`;
    }
  } catch (err) {
    job.status = 'FAILED';
    job.message = err?.message ?? String(err);
    job.finishedAt = new Date().toISOString();
  } finally {
    progressEmitter.off('progress', onProgress);
  }
}

export function getJob(id) {
  return jobs.get(id);
}

export function listJobs() {
  return [...jobs.values()];
}
