import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const config = {
  baseUrl: 'https://sebratel.matrixdobrasil.ai',
  // Path usado apenas para a checagem de login (session.js) - qualquer
  // pagina de relatorio autenticada serve para esse fim, entao ficamos com
  // o relatorio de atendimento por ser o primeiro que existiu aqui.
  reportPath: '/relatorio-atendimento/relatorio-atendimento-analitico',
  // Diretorio de perfil persistente do Chromium (cache, IndexedDB, etc)
  // reaproveitado em toda execucao para nao precisar logar de novo.
  profileDir: path.join(ROOT, '.auth', 'chromium-profile'),
  // O cookie de sessao do Matrix (SACMessenger) nao tem data de expiracao -
  // e um cookie de sessao "de verdade", e o Chromium descarta esse tipo de
  // cookie ao fechar o processo mesmo usando profileDir persistente (esse
  // e o comportamento padrao de qualquer browser, nao um bug do profile).
  // Por isso salvamos um snapshot explicito (storageState do Playwright,
  // que preserva cookies de sessao) assim que o login e confirmado, e
  // recarregamos esse snapshot manualmente em toda nova instancia do
  // Chromium - ver saveSessionState()/loadSavedCookies() em session.js.
  storageStatePath: path.join(ROOT, '.auth', 'storage-state.json'),
  downloadsDir: path.join(ROOT, 'downloads'),

  // Intervalo entre tentativas de detectar login concluido (ms)
  loginPollIntervalMs: 3000,

  // Terceiro relatorio: nao vem do Matrix/Playwright, vem de uma API REST
  // publica (Data Hub) que ja guarda os disparos de HSM de pos-instalacao.
  // Token e secreto - nao commitar em texto puro; definir DATA_HUB_TOKEN no
  // ambiente (ou num .env local, ver .env.example) antes de rodar.
  dataHub: {
    baseUrl: 'https://data-hub.sebratel.net.br',
    datasetSlug: 'matrix-hsm-cx-post-installation',
    token: process.env.DATA_HUB_TOKEN,
    // A API responde 429 acima de 10 requisicoes/minuto por token - com
    // paginacao (raro, dataset atual cabe numa unica pagina) esperamos esse
    // intervalo entre chamadas para nunca estourar o limite.
    minRequestIntervalMs: 6500,
  },
};
