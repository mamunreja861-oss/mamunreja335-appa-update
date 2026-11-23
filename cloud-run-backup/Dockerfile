FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm install --no-save tsx

COPY firebase-applet-config.json ./
COPY server ./server
COPY cloud-run-backup ./cloud-run-backup

ENV NODE_ENV=production
ENV PORT=8080
ENV FIREBASE_USE_ADC=true

EXPOSE 8080

CMD ["npx", "tsx", "cloud-run-backup/server.ts"]
