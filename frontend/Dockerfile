# 画面（Next.js）。API は同じ compose の api サービスへ /api で中継する
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# ブラウザからは同じオリジンの /api を叩き、Next.js のサーバーが api コンテナへ中継する
ARG NEXT_PUBLIC_API_URL=/api
ARG API_PROXY_TARGET=http://api:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL API_PROXY_TARGET=$API_PROXY_TARGET NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
RUN apk add --no-cache tzdata && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
