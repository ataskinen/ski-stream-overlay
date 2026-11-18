FROM node:20-alpine
WORKDIR /app
COPY --chown=node:node simulator ./simulator
COPY --chown=node:node examples/competitors.csv ./examples/competitors.csv
ENV HOST=0.0.0.0 TCP_PORT=5409 HTTP_PORT=8790 FORMAT=vola
USER node
EXPOSE 5409 8790
CMD ["node", "simulator/server.mjs"]
