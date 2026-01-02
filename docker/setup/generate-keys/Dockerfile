FROM node:22-alpine

WORKDIR /usr/app

COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src

RUN npm install

CMD ["npm", "run", "start"]
