import { config } from './config.js';
import { getValidToken } from './matrixAuth.js';
import { getCacheBounds, getCachedRows, replaceDayRows, TABLES } from './reportsDb.js';

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
 * Busca um relatorio paginado da API REST da Matrix para os dias pedidos.
 *
 * `dayEntries` e uma lista de { day, index } - `index` e a posicao do dia
 * DENTRO DO RANGE COMPLETO pedido pelo usuario, nao dentro de `dayEntries`
 * em si. Isso importa porque relAtAnalitico usa esse indice pra saber se e
 * o primeiro/ultimo dia do range inteiro (pra aplicar o horario especifico -
 * ver fetchAtendimentoApi) mesmo quando `dayEntries` e so um SUBCONJUNTO do
 * range (os dias que faltam buscar - ver fetchWithCache).
 *
 * Isso importa quebrar por dia porque o servidor parece escanear o
 * intervalo inteiro a cada pagina, nao so a pagina pedida - testado
 * manualmente, uma unica chamada (pagina 1) para um intervalo de ~8 meses
 * levou mais de 2 minutos, contra menos de 1s para 1 dia.
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
 *
 * Devolve um Map<isoDate, rows[]> (nao uma lista achatada) - quem chama
 * (fetchWithCache) precisa saber quais linhas pertencem a qual dia pra
 * salvar no cache um dia de cada vez.
 */
async function paginateByDay(
  { dayEntries, buildFirstPageUrl, buildPageUrl, getRows, getPageCount },
  onProgress,
) {
  const rowsByDay = new Map();
  if (!dayEntries.length) return rowsByDay;

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

  const addRows = (day, rows) => {
    const key = toIsoDate(day);
    if (!rowsByDay.has(key)) rowsByDay.set(key, []);
    rowsByDay.get(key).push(...rows);
  };

  let firstPagesDone = 0;
  const firstPageResults = await runWithConcurrency(
    dayEntries.map(({ day, index }) => async () => {
      const body = await withRetry(() => fetchJson(buildFirstPageUrl(day, index)));
      return { day, index, body };
    }),
    CONCURRENCY,
    () => emitProgress(Math.round((++firstPagesDone / dayEntries.length) * 50)),
  );

  const extraPageTasks = [];
  for (const { day, index, body } of firstPageResults) {
    addRows(day, getRows(body));
    const pageCount = getPageCount(body);
    for (let page = 2; page <= pageCount; page++) {
      extraPageTasks.push({
        day,
        run: () => withRetry(() => fetchJson(buildPageUrl(day, index, page))).then(getRows),
      });
    }
  }

  if (extraPageTasks.length) {
    let extraPagesDone = 0;
    const extraPageResults = await runWithConcurrency(
      extraPageTasks.map(({ run }) => run),
      CONCURRENCY,
      () => emitProgress(50 + Math.round((++extraPagesDone / extraPageTasks.length) * 40)),
    );
    extraPageResults.forEach((rows, i) => addRows(extraPageTasks[i].day, rows));
  } else {
    emitProgress(90);
  }

  return rowsByDay;
}

/**
 * Camada de cache incremental por cima de paginateByDay (ver reportsDb.js).
 * Dias dentro de [min, marca d'agua) - ou seja, ja cobertos pelo cache - vem
 * direto do banco, rapido, zero chamadas a API. A marca d'agua em si (pode
 * ter sido salva incompleta, ex.: dia ainda em andamento na hora que foi
 * salva) e todo dia fora desse intervalo conhecido (nunca visto, seja antes
 * do `min` ou depois da marca d'agua) vem da API e sao salvos, expandindo o
 * intervalo coberto pro proximo request.
 *
 * O `min` importa pra nao confundir "dia anterior a marca d'agua" com "dia
 * ja cacheado": se alguem pedir um range cujo inicio e ANTERIOR ao primeiro
 * dia que ja existe no banco (ex.: cache comecou em 2026, pediram desde
 * 2025), esses dias de 2025 sao menores que a marca d'agua mas NUNCA foram
 * buscados - sem essa checagem eles voltariam vazios do banco, sem nunca
 * bater na API.
 *
 * So faz sentido cachear dias INTEIROS (00:00-23:59) - se o request pedir
 * uma janela de horario parcial (timeFrom/timeTo diferente do dia inteiro),
 * cachear esse resultado incompleto quebraria requests futuros pelo dia
 * inteiro. Nesse caso `runFetch` e chamado sem nenhuma divisao de cache
 * (todo o range vira dayEntries, nada e lido/salvo no banco).
 */
async function fetchWithCache(table, filters, runFetch) {
  const isFullDayRequest =
    (filters.timeFrom ?? '00:00') === '00:00' && (filters.timeTo ?? '23:59') === '23:59';

  const allDays = eachDay(filters.dateFrom, filters.dateTo);
  const { min, max } = isFullDayRequest
    ? await getCacheBounds(table)
    : { min: null, max: null };

  const cachedDays = [];
  const apiDayEntries = [];
  allDays.forEach((day, index) => {
    if (min && max && day >= min && day < max) {
      cachedDays.push(day);
    } else {
      apiDayEntries.push({ day, index });
    }
  });

  const cachedRows = cachedDays.length
    ? await getCachedRows(table, cachedDays[0], cachedDays[cachedDays.length - 1])
    : [];

  const rowsByDay = await runFetch(apiDayEntries);

  if (isFullDayRequest) {
    // Sequencial, NAO Promise.all - varias transacoes de DELETE+INSERT
    // concorrentes na mesma tabela (dias diferentes) causam deadlock no
    // MariaDB (testado manualmente: com 3 dias, 2 das 3 gravacoes
    // colidiram e falharam). Sao operacoes locais rapidas comparadas ao
    // fetch na API, entao rodar uma de cada vez nao pesa no tempo total.
    for (const [isoDay, rows] of rowsByDay) {
      await replaceDayRows(table, new Date(`${isoDay}T00:00:00`), rows);
    }
  }

  return [...cachedRows, ...[...rowsByDay.values()].flat()];
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

  return fetchWithCache(TABLES.hsmEnviadas, filters, (dayEntries) =>
    paginateByDay(
      {
        dayEntries,
        buildFirstPageUrl: (day) => buildUrl(day, 1),
        buildPageUrl: (day, _index, page) => buildUrl(day, page),
        getRows: (body) => body.registros ?? [],
        getPageCount: (body) => Number(body.num_pages ?? 1),
      },
      onProgress,
    ),
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

  return fetchWithCache(TABLES.atendimentoAnalitico, filters, (dayEntries) =>
    paginateByDay(
      {
        dayEntries,
        buildFirstPageUrl: (day, index) => buildUrl(day, index, 1),
        buildPageUrl: (day, index, page) => buildUrl(day, index, page),
        getRows: (body) => body.rows ?? [],
        getPageCount: (body) => Number(body.total ?? 1),
      },
      onProgress,
    ),
  );
}
