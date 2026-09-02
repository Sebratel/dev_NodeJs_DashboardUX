import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { fetchHsmEnviadasApi, fetchAtendimentoApi } from './matrixApiClient.js';
import { reportProgress } from './progress.js';

/** Escapa um valor para um campo de CSV separado por ";" (mesma convencao dos outros relatorios). */
function csvField(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[;"\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(rows, columns) {
  const header = columns.map(([label]) => label).join(';');
  const lines = rows.map((row) => columns.map(([, getValue]) => csvField(getValue(row))).join(';'));
  return [header, ...lines].join('\r\n') + '\r\n';
}

async function writeReportCsv(reportDef, filters, rows, columns) {
  await fs.mkdir(config.downloadsDir, { recursive: true });
  const fileName = `${reportDef.fileLabel}_${filters.dateFrom}_a_${filters.dateTo}.csv`.replace(
    /\//g,
    '-',
  );
  const filePath = path.join(config.downloadsDir, fileName);
  await fs.writeFile(filePath, toCsv(rows, columns), 'utf-8');
  return filePath;
}

/** "dd/MM/yyyy HH:mm:ss" (formato de dat_msg no hsmEnviadas) -> Date, para ordenar decrescente. */
function parseBrDateTime(value) {
  const m = String(value || '').match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, d, mo, y, h = '0', mi = '0', s = '0'] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +s);
}

/** "yyyy-MM-dd HH:mm:ss" (formato de data_entrada no relAtAnalitico) -> Date, para ordenar decrescente. */
function parseIsoDateTime(value) {
  const m = String(value || '').match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +s);
}

function sortDesc(rows, getDate) {
  return [...rows].sort((a, b) => (getDate(b)?.getTime() ?? 0) - (getDate(a)?.getTime() ?? 0));
}

// Colunas em portugues (mesmo estilo dos CSVs exportados pela Matrix) - ver
// buildRows/parseHsmCsv em frontend-react/src/components/Dashboard/csvParsing.ts.
//
// hsmEnviadas nao devolve um "protocolo" formatado (so cod_atendimento, o id
// interno do atendimento) - usamos ele aqui. Isso e suficiente para a coluna
// em si, mas a correlacao HSM<->Atendimento por protocolo no dashboard pode
// nao casar 1:1 com o que o CSV scrapeado da Matrix contem hoje (nao
// verificado - vale conferir visualmente apos trocar para o modo API).
const HSM_COLUMNS = [
  ['Status', (r) => r.status],
  ['Data', (r) => r.dat_msg],
  ['HSM', (r) => r.nom_hsm],
  ['Telefone', (r) => r.num_telefone],
  ['Protocolo', (r) => r.cod_atendimento],
  ['CPF', (r) => r.num_cpf],
  ['Contato', (r) => r.nom_contato],
  ['Conta', (r) => r.nom_conta],
  ['Categoria', (r) => r.categoria],
  ['Mensagem', (r) => r.dsc_msg],
];

const ATENDIMENTO_COLUMNS = [
  ['Protocolo', (r) => r.protocolo],
  ['Contato', (r) => r.contato],
  ['Telefone', (r) => r.telefone],
  ['Canal', (r) => r.tipo_integracao],
  ['Data de Entrada', (r) => r.data_entrada],
  ['Status', (r) => r.status],
  ['Tipo', (r) => r.tipo_atendimento],
  ['Recorrência', (r) => r.recorrencia],
  ['Tag', (r) => r.tag],
  ['Tempo de Atendimento', (r) => r.tempo_atendimento],
  ['Observação', (r) => r.descricao_observacao],
  ['Ativo/Receptivo?', (r) => (String(r.boleano_receptivo) === '1' ? 'Receptivo' : 'Ativo')],
];

export async function exportHsmViaApi(reportDef, filters) {
  const message = `[${reportDef.label}] Buscando via API da Matrix`;
  reportProgress(reportDef.key, 0, message);

  const rows = await fetchHsmEnviadasApi(filters, (percent) => reportProgress(reportDef.key, percent, message));
  const sorted = sortDesc(rows, (r) => parseBrDateTime(r.dat_msg));

  const filePath = await writeReportCsv(reportDef, filters, sorted, HSM_COLUMNS);
  reportProgress(reportDef.key, 100, message);
  return filePath;
}

export async function exportAtendimentoViaApi(reportDef, filters) {
  const message = `[${reportDef.label}] Buscando via API da Matrix`;
  reportProgress(reportDef.key, 0, message);

  const rows = await fetchAtendimentoApi(filters, (percent) => reportProgress(reportDef.key, percent, message));
  const sorted = sortDesc(rows, (r) => parseIsoDateTime(r.data_entrada));

  const filePath = await writeReportCsv(reportDef, filters, sorted, ATENDIMENTO_COLUMNS);
  reportProgress(reportDef.key, 100, message);
  return filePath;
}
