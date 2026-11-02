FROM node:22-slim
WORKDIR /srv/kinpay
# Aucune dépendance à installer : le serveur n'utilise que Node.js.
COPY package.json server.mjs app.mjs ./
COPY lib ./lib
COPY providers ./providers
COPY scripts ./scripts
RUN mkdir -p /srv/kinpay/data && chown -R node:node /srv/kinpay
USER node
ENV NODE_ENV=production PORT=3000 DB_PATH=/srv/kinpay/data/kinpay.db
EXPOSE 3000
VOLUME ["/srv/kinpay/data"]
CMD ["node", "server.mjs"]
