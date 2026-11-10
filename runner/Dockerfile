FROM mcr.microsoft.com/playwright:v1.49.1-jammy
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY run.js ./
ENV NODE_ENV=production
CMD ["node", "run.js"]
