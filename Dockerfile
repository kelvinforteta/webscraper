# Dockerfile
FROM ghcr.io/puppeteer/puppeteer:22

WORKDIR /usr/src/app

# prevent re-downloading Chrome since it's included in the base image
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./
RUN npm ci --only=production

COPY . .

ENV PORT=4000
EXPOSE 4000

CMD ["npm", "start"]