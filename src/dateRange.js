function parseDate(ddMMyyyy) {
  const [day, month, year] = ddMMyyyy.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * O endpoint de exportacao da Matrix parece ter algum limite de
 * tempo/memoria no servidor: um intervalo de 1 ano (>1 milhao de linhas)
 * responde HTTP 500, enquanto 1 mes (~100 mil linhas, ~44MB) funciona bem
 * em ~47s. Por isso quebramos qualquer intervalo em pedacos mensais antes
 * de exportar, e juntamos os CSVs depois.
 *
 * A hora de inicio/fim original (timeFrom/timeTo) so se aplica ao primeiro
 * e ultimo pedaco - os pedacos do meio cobrem o dia inteiro.
 */
export function splitIntoMonthlyChunks({ dateFrom, dateTo, timeFrom, timeTo }) {
  const start = parseDate(dateFrom);
  const end = parseDate(dateTo);

  if (start > end) {
    throw new Error(`Intervalo invalido: dateFrom (${dateFrom}) e posterior a dateTo (${dateTo})`);
  }

  const chunks = [];
  let cursor = start;

  while (cursor <= end) {
    const monthEnd = endOfMonth(cursor);
    const chunkEnd = monthEnd < end ? monthEnd : end;
    const chunkFromStr = formatDate(cursor);
    const chunkToStr = formatDate(chunkEnd);

    chunks.push({
      dateFrom: chunkFromStr,
      dateTo: chunkToStr,
      timeFrom: chunkFromStr === dateFrom ? timeFrom : '00:00',
      timeTo: chunkToStr === dateTo ? timeTo : '23:59',
    });

    cursor = addDays(chunkEnd, 1);
  }

  return chunks;
}
