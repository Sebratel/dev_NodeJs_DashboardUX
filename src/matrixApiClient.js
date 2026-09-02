import { config } from './config.js';
import { getValidToken } from './matrixAuth.js';

const CONCURRENCY = config.matrixApi.concurrency ?? 25;

/**
 * Roda `tasks` (funcoes que retornam Promise) com no maximo `limit` em voo ao
 * mesmo tempo. `onTaskDone`, se passado, e chamado apos CADA task concluida
 * (sucesso ou falha), para quem chamou acompanhar progresso real por unidade
 * de trabalho em vez de so no fim do lote inteiro.
 */
async function runWithConcurrency(tasks, limit, onTaskDone) {
  const results = new Array(tasks.length);
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor++;
      try {
        results[index] = await tasks[index]();
      } finally {
        onTaskDone?.();
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/**
 * As falhas observadas sob carga alta sao HTTP 500/412 transitorios (ver
 * config.js) - nao ha "castigo" por tempo a esperar passar, mas num range de
 * varios meses os dois relatorios (HSM + atendimento) rodam suas pools de 25
 * ao mesmo tempo, entao a concorrencia real que bate no servidor fica bem
 * mais sustentada do que numa rajada isolada de teste. Testado manualmente:
 * range de ~8 meses com retries=2/delay fixo deixou escapar 2 falhas (uma
 * HTTP 500, uma HTTP 412) porque o delay fixo nao da tempo da onda de
 * requisicoes concorrentes (que continuam disparando durante o delay)
 * esvaziar. Backoff exponencial (dobra a cada tentativa, com teto) da mais
 * chance da pool desafogar antes do proximo retry.
 *
 * Mesmo com retries=4/backoff exponencial, um range de ~8 meses (milhares
 * de paginas) ainda deixou escapar 1 HTTP 412 numa pagina isolada -
 * qualquer que seja a causa (WAF/rate-limit externo, nao a app em si, dado
 * que o mesmo request refeito manualmente depois funciona), o padrao e "1
 * request infeliz em ~1500", entao mais tentativas com teto de backoff mais
 * alto reduz bastante a chance de um range inteiro falhar por causa de UMA
 * pagina.
 */
async function withRetry(fn, { retries = 6, delayMs = 500, maxDelayMs = 6000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const delay = Math.min(delayMs * 2 ** attempt, maxDelayMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

async function fetchJson(url) {
  const token = await getValidToken();
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`[matrixApi] HTTP ${response.status} em ${url.pathname}${url.search}`);
  }
  return response.json();
}

function parseDdMmYyyyDash(ddMMyyyy) {
  const [day, month, year] = ddMMyyyy.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Todo dia (inclusive) entre dateFrom e dateTo, formato "dd-MM-yyyy". */
function eachDay(dateFrom, dateTo) {
  const start = parseDdMmYyyyDash(dateFrom);
  const end = parseDdMmYyyyDash(dateTo);
  const days = [];
  for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    days.push(new Date(cursor));
  }
  return days;
}

function toBrDate(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

function toIsoDate(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Busca um relatorio paginado da API REST da Matrix, quebrando o intervalo
 * pedido em pedacos DIARIOS antes de paginar.
 *
 * Isso importa porque o servidor parece escanear o intervalo inteiro a cada
 * pagina, nao so a pagina pedida - testado manualmente, uma unica chamada
 * (pagina 1) para um intervalo de ~8 meses levou mais de 2 minutos, contra
 * menos de 1s para 1 dia. Quebrar por dia mantem cada chamada individual
 * rapida mesmo cobrindo um periodo longo no total.
 *
 * Concorrencia fica numa pool fixa (ver CONCURRENCY/config.js) - primeiro
 * busca a pagina 1 de cada dia (para descobrir quantas paginas cada um tem),
 * depois busca o resto das paginas de todos os dias de uma vez, tudo na
 * mesma pool.
 *
 * `onProgress` e chamado a cada PAGINA concluida (nao so no fim de cada
 * fase) - com ranges de varios meses o total de paginas e grande (ex.: 8
 * meses x ~5-6 paginas/dia em media = milhares de paginas), entao reportar
 * so 0/50/90/100 fazia a barra parecer travada por minutos entre um
 * checkpoint e outro. A fase 1 (descobrir quantas paginas cada dia tem)
 * ocupa 0-50%, proporcional aos dias ja consultados; a fase 2 (buscar as
 * paginas extras) ocupa 50-90%, proporcional as paginas extras ja buscadas.
 */
async function paginateByDay(
  { dateFrom, dateTo, buildFirstPageUrl, buildPageUrl, getRows, getPageCount },
  onProgress,
) {
  const days = eachDay(dateFrom, dateTo);

  // Com milhares de paginas, varias delas caem no mesmo ponto percentual
  // arredondado - sem essa deduplicacao cada pagina dispararia um evento de
  // progresso (console.log + entrada na Auditoria) mesmo sem o numero
  // exibido mudar.
  let lastReported = -1;
  const emitProgress = (percent) => {
    if (percent === lastReported) return;
    lastReported = percent;
    onProgress?.(percent);
  };

  let firstPagesDone = 0;
  const firstPageResults = await runWithConcurrency(
    days.map((day, index) => async () => {
      const body = await withRetry(() => fetchJson(buildFirstPageUrl(day, index)));
      return { day, index, body };
    }),
    CONCURRENCY,
    () => emitProgress(Math.round((++firstPagesDone / days.length) * 50)),
  );

  const allRows = [];
  const extraPageTasks = [];
  for (const { day, index, body } of firstPageResults) {
    allRows.push(...getRows(body));
    const pageCount = getPageCount(body);
    for (let page = 2; page <= pageCount; page++) {
      extraPageTasks.push(() =>
        withRetry(() => fetchJson(buildPageUrl(day, index, page))).then(getRows),
      );
    }
  }

  if (extraPageTasks.length) {
    let extraPagesDone = 0;
    const extraPageResults = await runWithConcurrency(
      extraPageTasks,
      CONCURRENCY,
      () => emitProgress(50 + Math.round((++extraPagesDone / extraPageTasks.length) * 40)),
    );
    for (const rows of extraPageResults) allRows.push(...rows);
  } else {
    emitProgress(90);
  }

  return allRows;
}

/** GET /rest/v2/hsmEnviadas - paginacao fixa em 100 registros/pagina (sem parametro de tamanho). */
export async function fetchHsmEnviadasApi(filters, onProgress) {
  const buildUrl = (day, page) => {
    const url = new URL('/rest/v2/hsmEnviadas', config.baseUrl);
    url.searchParams.set('data_inicial', toBrDate(day));
    url.searchParams.set('data_final', toBrDate(day));
    url.searchParams.set('page', String(page));
    return url;
  };

  return paginateByDay(
    {
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      buildFirstPageUrl: (day) => buildUrl(day, 1),
      buildPageUrl: (day, _index, page) => buildUrl(day, page),
      getRows: (body) => body.registros ?? [],
      getPageCount: (body) => Number(body.num_pages ?? 1),
    },
    onProgress,
  );
}

// Testado manualmente ate 5000 sem erro/limite aparente - 2000 fica com
// bastante folga (a maioria dos dias cabe numa unica pagina) sem deixar
// cada resposta grande demais.
const ATENDIMENTO_PAGE_LIMIT = 2000;

/** GET /rest/v2/relAtAnalitico - aceita `limit` (testado ate 5000), reduzindo bastante o numero de paginas. */
export async function fetchAtendimentoApi(filters, onProgress) {
  const dayCount = eachDay(filters.dateFrom, filters.dateTo).length;

  const buildUrl = (day, index, page) => {
    // A hora de inicio/fim pedida so vale para o primeiro/ultimo dia do
    // intervalo - dias do meio cobrem o dia inteiro. Mesma regra do fluxo
    // Playwright (ver dateRange.js/splitIntoMonthlyChunks).
    const startTime = index === 0 ? `${filters.timeFrom || '00:00'}:00` : '00:00:00';
    const endTime = index === dayCount - 1 ? `${filters.timeTo || '23:59'}:59` : '23:59:59';

    const url = new URL('/rest/v2/relAtAnalitico', config.baseUrl);
    url.searchParams.set('data_inicial', `${toIsoDate(day)} ${startTime}`);
    url.searchParams.set('data_final', `${toIsoDate(day)} ${endTime}`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', String(ATENDIMENTO_PAGE_LIMIT));
    return url;
  };

  return paginateByDay(
    {
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      buildFirstPageUrl: (day, index) => buildUrl(day, index, 1),
      buildPageUrl: (day, index, page) => buildUrl(day, index, page),
      getRows: (body) => body.rows ?? [],
      getPageCount: (body) => Number(body.total ?? 1),
    },
    onProgress,
  );
}
