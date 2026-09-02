import mysql from 'mysql2/promise';
import { config } from './config.js';

/**
 * Cache incremental dos relatorios da Matrix num MariaDB compartilhado (ver
 * config.massivesDb). Cada tabela guarda o payload cru (JSON) de um dia ja
 * buscado da API, mais a data desse dia.
 *
 * Estrategia de "marca d'agua": dados de dias passados nunca mudam, entao um
 * dia so precisa ser buscado da API UMA vez. So o dia mais recente ja salvo
 * (a marca d'agua) e sempre rebuscado e substituido, porque pode ter sido
 * salvo incompleto (ex.: o dia ainda nao tinha terminado quando foi salvo).
 * Dias depois da marca d'agua (nunca vistos) tambem vem da API e sao
 * inseridos, avancando a marca d'agua. Ver getWatermark()/replaceDayRows()
 * e o uso em matrixApiClient.js.
 */

export const TABLES = {
  hsmEnviadas: 'db_matrix_hsms_enviados',
  atendimentoAnalitico: 'db_matrix_atendimento_analitico',
};

let pool = null;

function isConfigured() {
  return Boolean(
    config.massivesDb.host && config.massivesDb.user && config.massivesDb.database,
  );
}

function getPool() {
  if (!isConfigured()) return null;
  if (!pool) {
    pool = mysql.createPool({
      host: config.massivesDb.host,
      port: config.massivesDb.port,
      user: config.massivesDb.user,
      password: config.massivesDb.password,
      database: config.massivesDb.database,
      connectionLimit: 5,
      connectTimeout: 8000,
    });
  }
  return pool;
}

function toIsoDate(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Cria a tabela se ainda nao existir. So roda CREATE TABLE IF NOT EXISTS -
 * nunca DROP/ALTER, o schema e compartilhado com outros projetos.
 */
async function ensureTable(db, table) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${table} (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      report_date DATE NOT NULL,
      payload JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_report_date (report_date)
    )`,
  );
}

/**
 * Devolve a data mais recente ja salva na tabela (a "marca d'agua"), ou null
 * se a tabela ainda esta vazia/nao existe/o banco esta inacessivel - nesses
 * casos quem chama trata como "sem cache", buscando tudo da API normalmente
 * (a integracao com o banco e so uma otimizacao, nunca pode quebrar o fluxo
 * existente).
 */
export async function getWatermark(table) {
  const db = getPool();
  if (!db) return null;

  try {
    await ensureTable(db, table);
    const [rows] = await db.query(`SELECT MAX(report_date) AS maxDate FROM ${table}`);
    const maxDate = rows[0]?.maxDate;
    return maxDate ? new Date(maxDate) : null;
  } catch (error) {
    console.warn(`[reportsDb] Falha ao ler marca d'agua de ${table}: ${error.message}`);
    return null;
  }
}

/** Le os payloads ja cacheados de report_date entre from/to (inclusive), em ordem crescente de data. */
export async function getCachedRows(table, fromDate, toDate) {
  const db = getPool();
  if (!db) return [];

  try {
    const [rows] = await db.query(
      `SELECT payload FROM ${table} WHERE report_date BETWEEN ? AND ? ORDER BY report_date`,
      [toIsoDate(fromDate), toIsoDate(toDate)],
    );
    return rows.map((row) =>
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    );
  } catch (error) {
    console.warn(`[reportsDb] Falha ao ler cache de ${table}: ${error.message}`);
    return [];
  }
}

/**
 * Substitui todas as linhas de UM dia (delete + insert numa transacao) -
 * usado tanto para o dia novo (marca d'agua ainda nao tinha esse dia) quanto
 * para reescrever a marca d'agua anterior (que pode ter sido salva
 * incompleta). Falha aqui e so logada, nunca propagada - perder o cache de
 * um dia nao pode derrubar a exportacao do relatorio em si.
 */
export async function replaceDayRows(table, day, rows) {
  const db = getPool();
  if (!db) return;

  const isoDay = toIsoDate(day);
  let connection;
  try {
    // getConnection() tambem pode falhar (rede/credenciais) - tem que estar
    // DENTRO do try, senao a rejeicao escapa sem passar pelo catch abaixo e
    // derruba o relatorio inteiro (foi exatamente isso que aconteceu num
    // teste manual com o banco temporariamente inacessivel).
    connection = await db.getConnection();
    await ensureTable(connection, table);
    await connection.beginTransaction();
    await connection.query(`DELETE FROM ${table} WHERE report_date = ?`, [isoDay]);
    if (rows.length) {
      await connection.query(`INSERT INTO ${table} (report_date, payload) VALUES ?`, [
        rows.map((row) => [isoDay, JSON.stringify(row)]),
      ]);
    }
    await connection.commit();
  } catch (error) {
    await connection?.rollback().catch(() => {});
    console.warn(`[reportsDb] Falha ao salvar cache de ${table} (${isoDay}): ${error.message}`);
  } finally {
    connection?.release();
  }
}
