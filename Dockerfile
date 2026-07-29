FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server ./server

ENV NODE_ENV=production
ENV WS_PORT=8787
EXPOSE 8787

CMD ["npm", "run", "server"]
