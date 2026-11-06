FROM golang:1.27.3-alpine AS base
ENV PATH="/usr/local/go/bin:${PATH}"

# Do not rebuild C libs, no need to use gcc for building Go code
ENV CGO_ENABLED=0
# Do not supress stack trace gives more info about errors in runtime
ENV GOTRACEBACK=system
# Build for linux os
ENV GOOS=linux

WORKDIR /app

COPY go.mod go.sum go.work go.work.sum ./
COPY services ./services

RUN go mod download

ARG SERVICE
RUN test -n "$SERVICE" && go build -trimpath -ldflags="-s -w" -o /usr/bin/service ./services/$SERVICE

FROM base AS dev

CMD ["/usr/bin/service"]

FROM gcr.io/distroless/base-debian13:nonroot AS prod
COPY --from=base /usr/bin/service /usr/bin/service

CMD ["/usr/bin/service"]
