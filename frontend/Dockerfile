# Static frontend. Pin the reviewed linux/amd64 manifest so a moving tag cannot
# silently change the reference runtime.
FROM docker.io/library/nginx@sha256:3bcf852aed06467cf075c6105892e4d5a6ebbbafa0ce22d35062db9e90ddef4c

COPY index.html /usr/share/nginx/html/index.html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
