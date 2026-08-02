FROM golang:1.26.5-alpine AS base

# Do not rebuild C libs, no need to use gcc for building Go code
ENV CGO_ENABLED=0
# Do not supress stack trace gives more info about errors in runtime
ENV GOTRACEBACK=system
# Build for linux os
ENV GOOS=linux

WORKDIR /app

COPY go.mod go.work ./
COPY services ./services

RUN go mod download

ARG SERVICE
RUN test -n "$SERVICE" && go build -trimpath -ldflags="-s -w" -o /usr/bin/service ./services/$SERVICE

FROM base AS dev

CMD ["/usr/bin/service"]

FROM alpine:3.20 AS prod
RUN apk --no-cache add ca-certificates

WORKDIR /usr/bin
COPY --from=base /usr/bin/service .

CMD ["/usr/bin/service"]
