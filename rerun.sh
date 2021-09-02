set -e
subql codegen
yarn build
docker-compose down -v
docker-compose up --build
