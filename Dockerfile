FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8787
ARG JUICE_VERSION_COMMIT=unknown
ENV JUICE_VERSION_COMMIT=$JUICE_VERSION_COMMIT
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY LICENSE README.md ./
USER node
EXPOSE 8787
CMD ["node", "dist/src/api/main.js"]
