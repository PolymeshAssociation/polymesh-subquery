FROM onfinality/subql-node:v0.19.2
RUN addgroup subquery && adduser --uid 1001 -G subquery -D --shell /bin/false subquery
RUN apk add --no-cache bash gettext
COPY . /app
WORKDIR /app

ENV START_BLOCK=1

RUN yarn --frozen-lockfile
RUN envsubst < project.template.yaml > project.yaml
RUN yarn codegen
RUN yarn build
RUN rm project.yaml
RUN chown -R subquery /app
USER subquery
ENTRYPOINT [ "/sbin/tini", "--", "bash", "/app/docker-entrypoint.sh" ]