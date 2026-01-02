FROM node:22-alpine

WORKDIR /usr/app

COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src

RUN npm install

# The script expects cardano-cli to be available in PATH. Extend this image or
# mount a binary if you need to run it inside a container.
CMD ["npm", "run", "start"]
