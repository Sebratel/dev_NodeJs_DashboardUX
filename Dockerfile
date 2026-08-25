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

CMD ["node", "src/server.js"]
