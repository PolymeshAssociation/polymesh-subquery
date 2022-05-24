FROM onfinality/subql-node:v1.0.0
RUN addgroup subquery && adduser --uid 1001 -G subquery -D --shell /bin/false subquery
RUN apk add --no-cache bash gettext

# Dependencies
WORKDIR /app
COPY package.json /app
COPY yarn.lock /app
RUN yarn --frozen-lockfile && chown -R subquery /app

########################################################################################
# Following parameters are needed to generate a project.yaml from project.template.yaml
ENV START_BLOCK=1
ENV CALL_HANDLER='callHandler'
ENV EVENT_HANDLER='handleEvent'
# ENV NETWORK_ENDPOINT='ws://host.docker.internal:9944'
# ENV NETWORK_CHAIN_ID='0xda7f2072787bfd0b09f7e12fca619afb6041b3d620f39f3a508814869100bf01'
########################################################################################

ENTRYPOINT [ "/sbin/tini", "--", "bash", "/app/docker-entrypoint.sh" ]

# End of cache
COPY . /app

RUN envsubst < project.template.yaml > project.yaml && yarn codegen && yarn build && rm project.yaml && chown -R subquery $(ls /app |grep -v 'node_modules')
USER subquery