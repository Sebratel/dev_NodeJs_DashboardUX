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
 * (confirmado via log de rede, para o relatorio de atendimento), diferente
 * do endpoint de export.
 */
async function fillAndCommit(page, selector, value) {
  await page.fill(selector, value);
  await page.locator(selector).dispatchEvent('change');
  await page.locator(selector).dispatchEvent('blur');
}

async function applyFilters(page, reportDef, { dateFrom, dateTo, timeFrom, timeTo }) {
  const toSlash = (d) => d.replace(/-/g, '/'); // payload usa dd-MM-yyyy, o input usa dd/MM/yyyy

  await fillAndCommit(page, reportDef.dateFieldSelectors.dateFrom, toSlash(dateFrom));
  await fillAndCommit(page, reportDef.dateFieldSelectors.dateTo, toSlash(dateTo));
  if (reportDef.hasTimeFilters) {
    await fillAndCommit(page, reportDef.timeFieldSelectors.timeFrom, timeFrom);
    await fillAndCommit(page, reportDef.timeFieldSelectors.timeTo, timeTo);
  }

  // Confere que o formulario realmente ficou com os valores pedidos antes
  // de submeter - falha alto e claro em vez de exportar o filtro errado
  // silenciosamente.
  const actualDateFrom = await page.locator(reportDef.dateFieldSelectors.dateFrom).inputValue();
  const actualDateTo = await page.locator(reportDef.dateFieldSelectors.dateTo).inputValue();
  if (actualDateFrom !== toSlash(dateFrom) || actualDateTo !== toSlash(dateTo)) {
    throw new Error(
      `[${reportDef.key}] Formulario de filtro nao refletiu as datas pedidas (esperado ${toSlash(dateFrom)} a ${toSlash(dateTo)}, ` +
        `encontrado ${actualDateFrom} a ${actualDateTo}). Abortando para nao exportar periodo errado.`,
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
async function fetchChunk(context, page, reportDef, chunk) {
  await applyFilters(page, reportDef, chunk);

  const formToken = await page
    .locator('#filtro_relatorio input[name="form_token"]')
    .inputValue();

  const payload = {
    form_token: formToken,
    [reportDef.payloadDateKeys.dateFrom]: chunk.dateFrom,
    [reportDef.payloadDateKeys.dateTo]: chunk.dateTo,
    ...(reportDef.hasTimeFilters
      ? {
          [reportDef.payloadTimeKeys.timeFrom]: chunk.timeFrom,
          [reportDef.payloadTimeKeys.timeTo]: chunk.timeTo,
        }
      : {}),
    ...reportDef.defaultFilters,
    'export-to-csv': 'true',
  };

  const base64Payload = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
  const url = `${config.baseUrl}${reportDef.reportPath}/data64/${base64Payload}`;

  // Intervalos grandes fazem o servidor gerar o CSV de forma sincrona, o
  // que pode passar bastante do timeout padrao (30s) do Playwright.
  const response = await context.request.get(url, { timeout: 5 * 60 * 1000 });
  if (!response.ok()) {
    throw new Error(
      `[${reportDef.key}] Falha ao exportar periodo ${chunk.dateFrom} a ${chunk.dateTo}: HTTP ${response.status()}`,
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
 * Emite uma linha de progresso em JSON no stdout, num formato fixo
 * ("PROGRESS {...}") para que um processo pai (o BFF Java, via
 * ProcessBuilder) consiga fazer parse do andamento sem depender de texto
 * livre. Ver bff/.../NodeProcessReportJobRunner.java, que le stdout linha a
 * linha e casa esse prefixo.
 *
 * O campo "report" identifica qual dos relatorios concorrentes gerou essa
 * atualizacao (ver REPORT_DEFINITIONS) - necessario desde que passamos a
 * rodar mais de um relatorio ao mesmo tempo (index.js).
 */
function reportProgress(reportKey, percent, message) {
  console.log(`PROGRESS ${JSON.stringify({ report: reportKey, percent, message })}`);
}

/**
 * Exporta um relatorio (`reportDef`) para o intervalo pedido, usando a
 * pagina (`page`) e o contexto de browser (`context`, para as chamadas
 * `context.request`) que o chamador ja deixou autenticados e navegados na
 * pagina correta do relatorio.
 *
 * Internamente quebra o periodo em pedacos mensais em ordem decrescente
 * (ver dateRange.js) e concatena tudo em um unico arquivo com um so
 * cabecalho - mesma regra de organizacao de datas para qualquer relatorio.
 */
export async function exportCsv(context, page, reportDef, filters) {
  const chunks = splitIntoMonthlyChunks(filters);
  const buffers = [];

  for (const [index, chunk] of chunks.entries()) {
    const message = `[${reportDef.label}] Exportando periodo ${index + 1}/${chunks.length}: ${chunk.dateFrom} ${chunk.timeFrom} ate ${chunk.dateTo} ${chunk.timeTo}`;
    console.log(`>>> ${message}`);
    reportProgress(reportDef.key, Math.round((index / chunks.length) * 100), message);

    const buffer = await fetchChunk(context, page, reportDef, chunk);
    buffers.push(index === 0 ? buffer : stripHeader(buffer));

    reportProgress(reportDef.key, Math.round(((index + 1) / chunks.length) * 100), message);
  }

  await fs.mkdir(config.downloadsDir, { recursive: true });
  const fileName = `${reportDef.fileLabel}_${filters.dateFrom}_a_${filters.dateTo}.csv`.replace(
    /\//g,
    '-',
  );
  const filePath = path.join(config.downloadsDir, fileName);
  await fs.writeFile(filePath, Buffer.concat(buffers));

  return filePath;
}
