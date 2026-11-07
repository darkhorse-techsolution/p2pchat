FROM node:22-alpine
WORKDIR /app
COPY core/crypto.js core/relaylink.js core/
COPY relay/server.js relay/
RUN adduser -D relay && mkdir -p /data && chown relay /data
USER relay
EXPOSE 4433
VOLUME ["/data"]
ENTRYPOINT ["node", "relay/server.js", "--port", "4433", "--data", "/data"]
CMD ["--public-host", "localhost"]
