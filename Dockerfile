# Build com contexto na propria pasta automation/:
#   docker build -t consolidador-automation .
#
# Roda o servico HTTP (src/server.js), NAO o CLI (src/index.js) - o BFF
# chama este servico via REST em vez de spawnar um subprocesso local (ver
# bff/AutomationProperties.java / HttpReportJobRunner.java).
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

# xvfb + x11vnc + websockify/novnc: usados so pelo fluxo de reautenticacao
# remota (ver src/reauth.js) - permitem abrir um Chromium HEADED e expor a
# tela dele via noVNC, para o usuario logar via browser, sem SSH nem
# instalar nada além do próprio browser.
RUN DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV PORT=3212
EXPOSE 3212 6080

# --max-old-space-size=8192: sem isso, um pedido de relatorio cobrindo um
# range grande (varios meses/anos) estoura o limite padrao do V8 (~4GB) ao
# carregar TODO o cache incremental do periodo de uma vez em memoria (ver
# fetchWithCache/getCachedRows em matrixApiClient.js/reportsDb.js) -
# confirmado derrubando o processo com "JavaScript heap out of memory" ao
# carregar 20 meses (~1,6M linhas) do cache do relatorio de Atendimento. Nao
# resolve a causa raiz (o array inteiro ainda vai pra memoria de uma vez),
# so empurra o teto pra mais longe - suficiente pros ranges grandes de hoje.
CMD ["node", "--max-old-space-size=8192", "src/server.js"]
