set -e
subql codegen
npm run build
docker-compose down -v
docker-compose up --build
