import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { splitIntoMonthlyChunks } from './dateRange.js';

/**
 * Preenche o formulario de filtros e clica em "Filtrar" de verdade pela UI.
 * Isso importa porque o botao de exportar so aparece (e o backend so aceita
 * o export) DEPOIS que o relatorio foi filtrado pelo menos uma vez - o
 * servidor guarda algum estado de sessao nesse passo que o endpoint de
 * exportacao exige (sem isso o data64/... responde HTTP 500). O filtro em
 * si dispara um POST para /relatorio-atendimento/listarRelatorioAtendimentoAnalitico
 * (confirmado via log de rede), diferente do endpoint de export.
 */
async function fillAndCommit(page, selector, value) {
  await page.fill(selector, value);
  await page.locator(selector).dispatchEvent('change');
  await page.locator(selector).dispatchEvent('blur');
}

async function applyFilters(page, { dateFrom, dateTo, timeFrom, timeTo }) {
  const toSlash = (d) => d.replace(/-/g, '/'); // payload usa dd-MM-yyyy, o input usa dd/MM/yyyy

  await fillAndCommit(page, '#dat_inicial', toSlash(dateFrom));
  await fillAndCommit(page, '#hor_inicial', timeFrom);
  await fillAndCommit(page, '#dat_final', toSlash(dateTo));
  await fillAndCommit(page, '#hor_final', timeTo);

  // Confere que o formulario realmente ficou com os valores pedidos antes
  // de submeter - falha alto e claro em vez de exportar o filtro errado
  // silenciosamente.
  const actualDatInicial = await page.locator('#dat_inicial').inputValue();
  const actualDatFinal = await page.locator('#dat_final').inputValue();
  if (actualDatInicial !== toSlash(dateFrom) || actualDatFinal !== toSlash(dateTo)) {
    throw new Error(
      `Formulario de filtro nao refletiu as datas pedidas (esperado ${toSlash(dateFrom)} a ${toSlash(dateTo)}, ` +
        `encontrado ${actualDatInicial} a ${actualDatFinal}). Abortando para nao exportar periodo errado.`,
    );
  }

  await page.click('#enviaFiltro');

  // O icone de exportar CSV só e renderizado depois que o grid recebe os
  // resultados do filtro.
  await page.waitForSelector('a[title="Exportar CSV"]', { timeout: 30_000 });
}

/**
 * Filtra e baixa um unico pedaco (mes) do relatorio, retornando os bytes
 * crus do CSV (com header e BOM inclusos).
 */
async function fetchChunk(context, page, chunk) {
  await applyFilters(page, chunk);

  const formToken = await page
    .locator('#filtro_relatorio input[name="form_token"]')
    .inputValue();

  const payload = {
    form_token: formToken,
    dat_inicial: chunk.dateFrom,
    hor_inicial: chunk.timeFrom,
    dat_final: chunk.dateTo,
    hor_final: chunk.timeTo,
    ...config.defaultFilters,
    'export-to-csv': 'true',
  };

  const base64Payload = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
  const url = `${config.baseUrl}${config.reportPath}/data64/${base64Payload}`;

  // Intervalos grandes fazem o servidor gerar o CSV de forma sincrona, o
  // que pode passar bastante do timeout padrao (30s) do Playwright.
  const response = await context.request.get(url, { timeout: 5 * 60 * 1000 });
  if (!response.ok()) {
    throw new Error(
      `Falha ao exportar periodo ${chunk.dateFrom} a ${chunk.dateTo}: HTTP ${response.status()}`,
    );
  }

  return response.body();
}

/** Remove a primeira linha (cabecalho) de um CSV, mantendo o resto. */
function stripHeader(buffer) {
  const text = buffer.toString('utf-8');
  const newlineIndex = text.indexOf('\n');
  if (newlineIndex === -1) return Buffer.alloc(0);
  return Buffer.from(text.slice(newlineIndex + 1), 'utf-8');
}

/**
 * Exporta o relatorio para o intervalo pedido. Internamente quebra o
 * periodo em pedacos mensais (ver dateRange.js) para nao estourar o limite
 * do servidor, e concatena tudo em um unico arquivo com um so cabecalho.
 */
/**
 * Emite uma linha de progresso em JSON no stdout, num formato fixo
 * ("PROGRESS {...}") para que um processo pai (o BFF Java, via
 * ProcessBuilder) consiga fazer parse do andamento sem depender de texto
 * livre. Ver bff/.../NodeProcessReportJobRunner.java, que le stdout linha a
 * linha e casa esse prefixo.
 */
function reportProgress(percent, message) {
  console.log(`PROGRESS ${JSON.stringify({ percent, message })}`);
}

export async function exportCsv(context, page, filters) {
  const chunks = splitIntoMonthlyChunks(filters);
  const buffers = [];

  for (const [index, chunk] of chunks.entries()) {
    const message = `Exportando periodo ${index + 1}/${chunks.length}: ${chunk.dateFrom} ${chunk.timeFrom} ate ${chunk.dateTo} ${chunk.timeTo}`;
    console.log(`>>> ${message}`);
    reportProgress(Math.round((index / chunks.length) * 100), message);

    const buffer = await fetchChunk(context, page, chunk);
    buffers.push(index === 0 ? buffer : stripHeader(buffer));

    reportProgress(Math.round(((index + 1) / chunks.length) * 100), message);
  }

  await fs.mkdir(config.downloadsDir, { recursive: true });
  const fileName = `relatorio-atendimento_${filters.dateFrom}_a_${filters.dateTo}.csv`.replace(
    /\//g,
    '-',
  );
  const filePath = path.join(config.downloadsDir, fileName);
  await fs.writeFile(filePath, Buffer.concat(buffers));

  console.log(`RESULT ${JSON.stringify({ filePath })}`);

  return filePath;
}
