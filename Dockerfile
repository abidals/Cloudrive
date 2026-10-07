FROM node:24-alpine

ENV CLOUDRIVE_UPLOAD_DIR=/data \
    NODE_ENV=production

LABEL org.opencontainers.image.title="Cloudrive" \
      org.opencontainers.image.description="Self-hosted file sharing with accounts, roles and expiring links. Fork of PsiTransfer" \
      org.opencontainers.image.source="https://github.com/abidals/Cloudrive" \
      org.opencontainers.image.licenses="BSD-2-Clause" \
      org.opencontainers.image.vendor="abidals"

RUN apk add --no-cache tzdata

WORKDIR /app

ADD *.js package.json package-lock.json README.md /app/
ADD lib /app/lib
ADD app /app/app
ADD lang /app/lang
ADD plugins /app/plugins
ADD public /app/public

# Rebuild the frontend apps
RUN cd app && \
    NODE_ENV=dev npm ci && \
    npm run build && \
    cd .. && \
    mkdir /data && \
    chown node /data && \
    npm ci && \
    rm -rf app

EXPOSE 3000
VOLUME ["/data"]

USER node

# HEALTHCHECK CMD wget -O /dev/null -q http://localhost:3000

CMD ["node", "app.js"]
