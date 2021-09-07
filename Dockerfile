FROM onfinality/subql-node:v0.19.2
RUN addgroup subquery && adduser --uid 1001 -G subquery -D --shell /bin/false subquery
RUN apk add --no-cache bash
COPY . /app
WORKDIR /app
RUN yarn --frozen-lockfile
USER subquery
ENTRYPOINT [ "/sbin/tini", "--", "bash", "/app/docker-entrypoint.sh" ]