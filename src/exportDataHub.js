import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { fetchAllDataHubRows } from './dataHubClient.js';

function reportProgress(reportKey, percent, message) {
  console.log(`PROGRESS ${JSON.stringify({ report: reportKey, percent, message })}`);
}

function parseDdMmYyyyHHmm(dateDdMmYyyy, timeHHmm) {
  const [day, month, year] = dateDdMmYyyy.split('-').map(Number);
  const [hour, minute] = timeHHmm.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0);
}

function parseDataHoraDisparo(value) {
  // formato da API: "yyyy-MM-dd HH:mm:ss"
  const m = value && value.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

/** Escapa um valor para um campo de CSV separado por ";" (mesma convencao dos outros relatorios). */
function csvField(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[;"\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(rows, columns) {
  const header = columns.join(';');
  const lines = rows.map((row) => columns.map((col) => csvField(row[col])).join(';'));
  return [header, ...lines].join('\r\n') + '\r\n';
}

/**
 * Exporta o relatorio de HSM CX Pos-Instalacao (fonte: API do Data Hub, sem
 * Playwright/browser). A API nao filtra por data no servidor, entao
 * buscamos o dataset inteiro e filtramos/ordenamos aqui - mesma regra de
 * organizacao de datas (decrescente) dos outros dois relatorios.
 */
export async function exportDataHubReport(reportDef, filters) {
  const message = `[${reportDef.label}] Buscando dados do Data Hub`;
  console.log(`>>> ${message}`);
  reportProgress(reportDef.key, 0, message);

  const allRows = await fetchAllDataHubRows();

  const start = parseDdMmYyyyHHmm(filters.dateFrom, filters.timeFrom);
  const end = parseDdMmYyyyHHmm(filters.dateTo, filters.timeTo);

  const filtered = allRows
    .map((row) => ({ row, date: parseDataHoraDisparo(row[reportDef.dateField]) }))
    .filter(({ date }) => date && date >= start && date <= end)
    .sort((a, b) => b.date - a.date)
    .map(({ row }) => row);

  reportProgress(reportDef.key, 60, message);

  const csv = toCsv(filtered, reportDef.columns);

  await fs.mkdir(config.downloadsDir, { recursive: true });
  const fileName = `${reportDef.fileLabel}_${filters.dateFrom}_a_${filters.dateTo}.csv`.replace(
    /\//g,
    '-',
  );
  const filePath = path.join(config.downloadsDir, fileName);
  await fs.writeFile(filePath, csv, 'utf-8');

  reportProgress(reportDef.key, 100, message);

  return filePath;
}
