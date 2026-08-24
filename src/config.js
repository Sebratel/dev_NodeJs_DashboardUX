import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const config = {
  baseUrl: 'https://sebratel.matrixdobrasil.ai',
  reportPath: '/relatorio-atendimento/relatorio-atendimento-analitico',
  // Diretorio de perfil persistente do Chromium (cookies, cache, IndexedDB...)
  // reaproveitado em toda execucao para nao precisar logar de novo.
  profileDir: path.join(ROOT, '.auth', 'chromium-profile'),
  downloadsDir: path.join(ROOT, 'downloads'),

  // Intervalo entre tentativas de detectar login concluido (ms)
  loginPollIntervalMs: 3000,

  // Payload padrao do relatorio; datas sao sobrescritas via CLI (--from/--to)
  defaultFilters: {
    bol_somente_agentes: '0',
    bol_prioritario: '0',
    rows: '10',
    page: '1',
    sidx: 'dat_entrada',
    sord: 'desc',
    searchOper: 'cn',
  },
};
