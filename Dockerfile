# Build com contexto na propria pasta automation/:
#   docker build -t consolidador-automation .
#
# Roda o servico HTTP (src/server.js), NAO o CLI (src/index.js) - o BFF
# chama este servico via REST em vez de spawnar um subprocesso local (ver
# bff/AutomationProperties.java / HttpReportJobRunner.java).
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV PORT=3212
EXPOSE 3212

CMD ["node", "src/server.js"]
