import { EventEmitter } from 'node:events';

/**
 * Compartilhado entre exportCsv.js/exportDataHub.js (quem emite) e
 * server.js (quem escuta, quando automation roda como servico HTTP - ver
 * automation/Dockerfile). Como os jobs sao processados em fila (um por
 * vez, ver jobQueue.js), nao ha risco de misturar eventos de jobs
 * diferentes nesse emissor compartilhado.
 */
export const progressEmitter = new EventEmitter();

/**
 * Emite uma atualizacao de progresso de UM relatorio. Sempre loga no
 * stdout (formato fixo "PROGRESS {...}", usado pelo CLI/index.js e visivel
 * via `docker logs`) e tambem publica no progressEmitter, para o servidor
 * HTTP capturar sem precisar fazer parse de stdout entre processos.
 */
export function reportProgress(reportKey, percent, message) {
  console.log(`PROGRESS ${JSON.stringify({ report: reportKey, percent, message })}`);
  progressEmitter.emit('progress', { report: reportKey, percent, message });
}
