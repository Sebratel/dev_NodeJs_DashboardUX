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

  // Modo "api": busca atendimento/HSM direto pela API REST da Matrix
  // (rest/v2/relAtAnalitico e rest/v2/hsmEnviadas) em vez de scraping via
  // Playwright - ver matrixApiClient.js/matrixAuth.js. Login/senha de um
  // usuario da Matrix (nao um token fixo) - o servico se autentica sozinho
  // via POST /rest/v2/authuser e renova o bearer token (~1h de validade)
  // conforme necessario, ver matrixAuth.js. Segredo, nao commitar em texto
  // puro.
  //
  // `concurrency` foi calibrado testando manualmente contra o servidor real:
  // ate 50 chamadas simultaneas = 0 falhas; 100 simultaneas = ~20-30% de
  // HTTP 500. Nao e rate limit por tempo (sem 429/Retry-After) - e
  // esgotamento momentaneo de capacidade do servidor, que se recupera na
  // hora assim que a concorrencia cai (sem "castigo"/cooldown).
  //
  // Esse teste foi uma rajada isolada, unica - num range de varios meses os
  // dois relatorios (HSM + atendimento) rodam suas pools ao mesmo tempo por
  // varias ondas seguidas (uma por dia do range), sustentando concorrencia
  // real de ate 2x esse valor por mais tempo. Testado manualmente com 25
  // (pico de 50): escapou uma falha HTTP 500 e uma HTTP 412 num range de ~8
  // meses mesmo com retry. 20 (pico de 40) da mais margem sem perder muita
  // velocidade - dia unico continua saindo em segundos.
  matrixApi: {
    login: process.env.MATRIX_API_LOGIN,
    senha: process.env.MATRIX_API_SENHA,
    concurrency: 20,
  },
};
