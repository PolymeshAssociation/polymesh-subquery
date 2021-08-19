FROM onfinality/subql-node:v0.19.2
RUN apk add --no-cache bash
COPY . /app
ENTRYPOINT [ "/sbin/tini", "--", "bash", "/app/docker-entrypoint.sh" ]
WORKDIR /app