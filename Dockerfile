FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

# The parts of openGym the tools import: the training helpers (frontend/src/lib, which reach into
# locales and a few api/ modules) and the upstream read tools. Tests are left out (.dockerignore).
COPY vendor/opengym/frontend/src ./vendor/opengym/frontend/src
COPY vendor/opengym/api ./vendor/opengym/api
COPY vendor/opengym/mcp/src ./vendor/opengym/mcp/src
COPY vendor/opengym/LICENSE ./vendor/opengym/LICENSE
COPY src ./src
COPY LICENSE ./

USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3100/health || exit 1
CMD ["node", "--import", "./src/register.js", "src/server.js"]
