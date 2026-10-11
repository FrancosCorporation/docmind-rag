FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
RUN mkdir -p /app/data && chown -R node:node /app
COPY --chown=node:node . .
USER node
EXPOSE 3300
CMD ["node", "server.js"]
