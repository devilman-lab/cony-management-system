# 稼働先を決めていないため、どこでも同じ形で動くようにコンテナ化しておく
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# 帳票PDFの日本語書体（Noto Sans CJK）と日本時間
RUN apk add --no-cache tzdata font-noto-cjk && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# 添付ファイルの置き場（compose でボリュームを当てる）
RUN mkdir -p /app/storage/attachments && chown -R node:node /app/storage
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
