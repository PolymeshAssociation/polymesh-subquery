FROM onfinality/subql-node:v0.19.2
RUN addgroup subquery && adduser --uid 1001 -G subquery -D --shell /bin/false subquery
RUN apk add --no-cache bash gettext

# Dependencies
WORKDIR /app
COPY package.json /app
COPY yarn.lock /app
RUN yarn --frozen-lockfile && chown -R subquery /app

ENV START_BLOCK=1
ENTRYPOINT [ "/sbin/tini", "--", "bash", "/app/docker-entrypoint.sh" ]

# End of cache
COPY . /app

RUN envsubst < project.template.yaml > project.yaml && yarn codegen && yarn build && rm project.yaml && chown -R subquery $(ls /app |grep -v 'node_modules') 
USER subquery